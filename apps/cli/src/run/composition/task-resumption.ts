import { isDeepStrictEqual } from 'node:util';
import { readCalibrationContinuationHistory } from '../application/calibration-continuation-history.js';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Run } from '@devrandom/domain';
import {
  decodeRunProjection,
  decodeRunSuccessorSegment,
  type RunSuccessorSegment,
  projectRun,
  type ActiveHarnessPointer,
  type EvidenceEvent,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import type { RunSupervision, SuccessorRunBehavior } from '@devrandom/runtime';
import {
  resumeTask,
  type HostedRunContinuations,
  type TaskResumption,
} from '../application/resume-task.js';
import {
  continuationContext,
  type ContinuationContext,
} from '../application/continuation-context.js';
import type { HostedRunStatuses, HostedRunTimelines } from '../application/task-run-observation.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import { RunContinuationFile } from '../infrastructure/run-continuation-file.js';
import type { RunPredecessorCustody } from '../application/run-predecessor-custody.js';
import type { AdmittedRunExecutionCustody } from './baseline-run-supervisor.js';
import {
  LinuxRunSupervisorComposition,
  type LinuxRunSupervisorCompositionOptions,
} from './linux-run-supervisor.js';

export interface TaskResumptionInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly activation: ActiveHarnessPointer;
  readonly preparation: AdmittedRunExecutionCustody;
  readonly runs: HostedRunStatuses & HostedRunContinuations;
  readonly evidence: HostedRunTimelines;
  readonly authority: {
    verify(run: Run): Promise<{ readonly kind: 'Current' | 'Rejected' | 'Unavailable' }>;
  };
  successorBehavior(
    context: ContinuationContext,
    custody: RunPredecessorCustody,
  ): SuccessorRunBehavior | undefined;
}
export type SupervisedTaskResumption =
  | Exclude<TaskResumption, { readonly kind: 'Admitted' }>
  | {
      readonly kind: 'RunSupervised';
      readonly supervision: RunSupervision;
      readonly context: ContinuationContext;
    };

/** Same-profile continuation: hosted acceptance and local exact bytes precede every new executor. */
export class TaskResumptionComposition {
  readonly #options: LinuxRunSupervisorCompositionOptions;
  constructor(options: LinuxRunSupervisorCompositionOptions) {
    this.#options = options;
  }
  async resume(input: TaskResumptionInput, signal: AbortSignal): Promise<SupervisedTaskResumption> {
    try {
      const hosted = await input.runs.inspect(input.runId);
      if (hosted.kind !== 'Found') return { kind: 'Unavailable' };
      const decoded = decodeRunProjection(hosted.run);
      if (decoded.kind !== 'Accepted') return { kind: 'BindingRejected' };
      let run = decoded.run;
      const commands = new RunContinuationFile(
        join(this.#options.stateRoot, 'continuations'),
        randomUUID,
      );
      let pending: Awaited<ReturnType<RunContinuationFile['readPredecessor']>>;
      let unstartedSuccessor: { run: typeof run; segment: RunSuccessorSegment } | undefined;
      if (
        run.binding.purpose.kind === 'PreparedCompatibilityCalibration' &&
        run.lifecycle.kind === 'Active' &&
        run.lifecycle.phase.kind === 'Preparing' &&
        run.currentExecution !== undefined &&
        run.lease.kind === 'Held'
      ) {
        const readSegment = await input.runs.readSuccessorSegment?.(
          input.runId,
          run.currentExecution.segmentSaid,
        );
        if (readSegment?.kind !== 'Found') return { kind: 'PredecessorRejected' };
        const segment = decodeRunSuccessorSegment(readSegment.segment);
        if (segment.kind !== 'Accepted' || segment.segment.d !== run.currentExecution.segmentSaid)
          return { kind: 'PredecessorRejected' };
        pending = await commands.readPredecessor(input.runId, segment.segment.fromRunVersion);
        if (pending === undefined) return { kind: 'PredecessorRejected' };
        unstartedSuccessor = { run, segment: segment.segment };
      } else if (
        run.binding.purpose.kind === 'Retained' &&
        run.lifecycle.kind === 'Active' &&
        run.lifecycle.phase.kind === 'Preparing' &&
        run.currentExecution !== undefined &&
        run.lease.kind === 'Held' &&
        run.lease.lastChange.kind === 'Replaced'
      ) {
        pending = await commands.readPredecessor(input.runId, run.lease.lastChange.fromRunVersion);
      }
      if (pending !== undefined) {
        const previous = decodeRunProjection(pending.run);
        if (previous.kind !== 'Accepted') return { kind: 'PredecessorRejected' };
        run = previous.run;
      }
      const preparation = input.preparation;
      if (
        run.binding.runId !== input.runId ||
        run.binding.personalAgentAid !== preparation.executionAuthority.personalAgentAid ||
        run.binding.taskMandateSaid !== preparation.mandates.taskMandate.credentialSaid ||
        run.binding.governorAid !== preparation.mandates.governor.aid ||
        run.binding.promotionMandateSaid !== preparation.mandates.promotionMandate.credentialSaid ||
        run.binding.initialHarnessRevisionSaid !== preparation.harness.projection.revision.d
      )
        return { kind: 'BindingRejected' };
      const events: EvidenceEvent[] = [];
      let stream: EvidenceStreamProjection | undefined;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      if (pending !== undefined) {
        stream = pending.stream;
        events.push(...pending.events);
      } else
        do {
          signal.throwIfAborted();
          const page = await input.evidence.inspect(input.runId, {
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (page.kind !== 'Found') return { kind: 'Unavailable' };
          if (stream !== undefined && JSON.stringify(stream) !== JSON.stringify(page.page.stream))
            return { kind: 'PredecessorRejected' };
          stream = page.page.stream;
          events.push(...page.page.events.map(({ event }) => event));
          if (events.length > 100000) return { kind: 'PredecessorRejected' };
          if (
            stream.cursor.kind === 'Accepted' &&
            events.at(-1)?.sequence === stream.cursor.acceptedThroughSequence
          )
            break;
          cursor = page.page.nextCursor ?? undefined;
          if (cursor !== undefined) {
            if (cursors.has(cursor)) return { kind: 'PredecessorRejected' };
            cursors.add(cursor);
          }
        } while (cursor !== undefined);
      if (
        (await commands.retainPredecessor({ run: projectRun(run), stream, events })) !== 'Recorded'
      )
        return { kind: 'Unavailable' };
      const read = new SqliteEvidenceOutboxes(
        () => this.#options.now(),
        preparation.protectedCredentials,
      ).readPredecessor({ run, stateRoot: this.#options.stateRoot, stream, events });
      if (read.kind !== 'Read') return { kind: 'PredecessorRejected' };
      let transcriptCustody = read.custody;
      if (
        run.binding.purpose.kind === 'PreparedCompatibilityCalibration' &&
        run.currentExecution !== undefined
      ) {
        const history = await readCalibrationContinuationHistory(
          projectRun(run),
          input.runs,
          input.evidence,
        );
        if (history.kind !== 'Verified') return { kind: 'PredecessorRejected' };
        const earlier: RunPredecessorCustody[] = [];
        for (const item of history.predecessors) {
          const retained = await commands.readPredecessor(input.runId, item.segment.fromRunVersion);
          if (
            retained === undefined ||
            !isDeepStrictEqual(retained.stream, item.stream) ||
            !isDeepStrictEqual(retained.events, item.events)
          )
            return { kind: 'PredecessorRejected' };
          const previous = decodeRunProjection(retained.run);
          if (
            previous.kind !== 'Accepted' ||
            previous.run.lease.kind !== 'Held' ||
            !isDeepStrictEqual(previous.run.binding, run.binding) ||
            previous.run.version !== item.segment.fromRunVersion ||
            previous.run.lease.incarnationId !== item.segment.predecessor.incarnationId ||
            previous.run.currentExecution?.segmentSaid !== item.segment.predecessor.segmentSaid ||
            !isDeepStrictEqual(previous.run.consumedBudget, item.segment.consumedBudget)
          )
            return { kind: 'PredecessorRejected' };
          const raw = new SqliteEvidenceOutboxes(
            () => this.#options.now(),
            preparation.protectedCredentials,
          ).readPredecessor({
            run: previous.run,
            stateRoot: this.#options.stateRoot,
            stream: item.stream,
            events: item.events,
          });
          if (
            raw.kind !== 'Read' ||
            raw.custody.checkpoint.d !== item.segment.predecessor.checkpointSaid
          )
            return { kind: 'PredecessorRejected' };
          earlier.push(raw.custody);
        }
        const artifacts = new Map<string, RunPredecessorCustody['artifacts'][number]>();
        for (const custody of [...earlier, read.custody])
          for (const artifact of custody.artifacts) {
            const existing = artifacts.get(artifact.artifact.d);
            if (existing !== undefined && !isDeepStrictEqual(existing, artifact))
              return { kind: 'PredecessorRejected' };
            artifacts.set(artifact.artifact.d, artifact);
          }
        transcriptCustody = {
          ...read.custody,
          events: [...earlier.flatMap((custody) => custody.events), ...read.custody.events],
          artifacts: [...artifacts.values()],
        };
      }
      const context: ContinuationContext | undefined =
        run.binding.purpose.kind === 'PreparedCompatibilityCalibration'
          ? {
              text: '',
              sourceEventSaids: transcriptCustody.events.map((event) => event.d),
              includedEventSaids: transcriptCustody.events
                .filter(
                  (event) =>
                    event.event.kind === 'ModelMessageCompleted' ||
                    event.event.kind === 'EffectCompleted',
                )
                .map((event) => event.d),
              addressableEventSaids: transcriptCustody.events.map((event) => event.d),
              addressableArtifactSaids: transcriptCustody.artifacts.map(
                ({ artifact }) => artifact.d,
              ),
            }
          : continuationContext(preparation.task, transcriptCustody);
      if (context === undefined) return { kind: 'PredecessorRejected' };
      const behavior = input.successorBehavior(context, transcriptCustody);
      if (behavior === undefined) return { kind: 'PredecessorRejected' };
      const directory = join(this.#options.stateRoot, 'runs', input.runId, 'worktree');
      const status = await lstat(directory);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      )
        return { kind: 'ArtifactMismatch' };
      const admitted = await resumeTask(
        {
          ownerAid: input.ownerAid,
          task: preparation.task,
          run,
          activation: input.activation,
          predecessor: read.custody,
          ...(unstartedSuccessor === undefined ? {} : { unstartedSuccessor }),
          worktree: {
            directory,
            branch: `devrandom/run/${input.runId}`,
            repository: run.binding.repository,
          },
        },
        {
          authority: input.authority,
          repository: new GitWorktreeChanges(preparation.protectedCredentials),
          commands,
          hosted: input.runs,
          now: () => this.#options.now(),
          monotonicNow: () => performance.now(),
        },
        signal,
      );
      if (admitted.kind !== 'Admitted') return admitted;
      if (admitted.run.lease.kind !== 'Held') return { kind: 'AdmissionRejected' };
      const supervision = await new LinuxRunSupervisorComposition({
        ...this.#options,
        successorBehavior: behavior,
        ...(read.custody.checkpoint.version === 1
          ? { pausePredecessorRepository: read.custody.checkpoint.repository }
          : {}),
      })
        .provision(preparation)
        .supervise(
          admitted.run,
          {
            runId: input.runId,
            incarnationId: admitted.run.lease.incarnationId,
            runVersion: admitted.run.version,
            serverTime: admitted.leaseServerTime,
            expiresAt: admitted.run.lease.expiresAt,
          },
          signal,
          admitted.leaseRequestStartedAt,
        );
      return { kind: 'RunSupervised', supervision, context };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
