import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { AdmittedUser, ProtectedCredentials } from '@devrandom/domain';
import type { IssuerAid } from '@devrandom/identity';
import {
  decodeRunProjection,
  type BaselineHarnessRevision,
  type EvidenceEvent,
  type EvidenceStreamProjection,
  type TaskProjection,
} from '@devrandom/protocol';

import type { LocalTaskMandatePreparation } from '../../task/application/task-run-preparation.js';
import type { HostedRunStatuses, HostedRunTimelines } from '../application/task-run-observation.js';
import type { HostedEvidence } from '../application/evidence-delivery.js';
import type { HostedEvidenceSeals } from '../application/evidence-seal-delivery.js';
import { PreparedCompatibilityCalibration } from '../application/prepared-compatibility-calibration.js';
import { SealedEvidenceSettlement } from '../application/sealed-evidence-settlement.js';
import {
  reconcileTerminalCalibrationRun,
  reconcileSealedTerminalCalibration,
  type HostedTerminalCalibration,
  type TerminalCalibrationReconciliation,
} from '../application/terminal-calibration-reconciliation.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import { PreparedCompatibilityCalibrationFile } from '../infrastructure/prepared-compatibility-calibration-file.js';

export interface TerminalCalibrationCompositionInput {
  readonly user: AdmittedUser;
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly mandates: Extract<LocalTaskMandatePreparation, { readonly kind: 'Prepared' }>;
  readonly protectedCredentials: ProtectedCredentials;
  readonly runId: string;
  readonly runs: HostedRunStatuses;
  readonly evidence: HostedEvidence &
    HostedEvidenceSeals &
    HostedRunTimelines &
    HostedTerminalCalibration;
}

export interface TerminalCalibrationCompositionOptions {
  readonly stateRoot: string;
  readonly issuerAid: IssuerAid;
  now(): string;
  wait(milliseconds: number): Promise<void>;
}

/** Wires read-only repository custody and terminal evidence; no supervisor or Pi is constructed. */
export class TerminalCalibrationComposition {
  readonly #options: TerminalCalibrationCompositionOptions;

  constructor(options: TerminalCalibrationCompositionOptions) {
    this.#options = options;
  }

  async reconcile(
    input: TerminalCalibrationCompositionInput,
    signal: AbortSignal,
  ): Promise<TerminalCalibrationReconciliation> {
    try {
      signal.throwIfAborted();
      const hosted = await input.runs.inspect(input.runId);
      if (hosted.kind !== 'Found') return { kind: 'Unavailable' };
      const decoded = decodeRunProjection(hosted.run);
      if (decoded.kind !== 'Accepted') return { kind: 'BindingRejected' };
      const run = decoded.run;
      if (
        run.binding.runId !== input.runId ||
        run.binding.ownerAid !== input.user.principal.aid ||
        run.binding.personalAgentAid !== input.mandates.executionAuthority.personalAgentAid ||
        run.binding.taskMandateSaid !== input.mandates.summary.taskMandate.credentialSaid ||
        run.binding.governorAid !== input.mandates.summary.governor.aid ||
        run.binding.promotionMandateSaid !== input.mandates.summary.promotionMandate.credentialSaid
      )
        return { kind: 'BindingRejected' };
      const events: EvidenceEvent[] = [];
      let cursor: string | undefined;
      let stream: EvidenceStreamProjection | undefined;
      const cursors = new Set<string>();
      do {
        signal.throwIfAborted();
        const page = await input.evidence.inspect(input.runId, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.kind !== 'Found') return { kind: 'Unavailable' };
        if (stream !== undefined && JSON.stringify(stream) !== JSON.stringify(page.page.stream))
          return { kind: 'BindingRejected' };
        stream = page.page.stream;
        events.push(...page.page.events.map(({ event }) => event));
        if (events.length > 100_000) return { kind: 'BindingRejected' };
        // Open streams return a future polling cursor even at the accepted head.
        if (
          stream.cursor.kind === 'Accepted' &&
          events.at(-1)?.sequence === stream.cursor.acceptedThroughSequence
        )
          break;
        if (page.page.events.length === 0) return { kind: 'BindingRejected' };
        cursor = page.page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) return { kind: 'BindingRejected' };
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      const last = events.at(-1);
      if (
        stream.runId !== run.binding.runId ||
        stream.evidenceStreamId !== run.binding.evidenceStreamId ||
        stream.cursor.kind !== 'Accepted' ||
        stream.cursor.eventCount !== events.length ||
        stream.cursor.acceptedThroughSequence !== last?.sequence ||
        stream.cursor.chainHeadSaid !== last.d
      )
        return { kind: 'BindingRejected' };
      const calibration = new PreparedCompatibilityCalibration(
        new PreparedCompatibilityCalibrationFile(
          join(this.#options.stateRoot, 'calibration', input.task.taskId, input.harness.d),
        ),
      );
      if (run.lifecycle.kind === 'Ended')
        return await reconcileSealedTerminalCalibration(
          {
            ownerAid: input.user.principal.aid,
            run,
            hostedPrefix: events,
            task: input.task,
            harness: input.harness,
            stateRoot: this.#options.stateRoot,
          },
          stream,
          calibration,
        );
      const directory = join(this.#options.stateRoot, 'runs', input.runId, 'worktree');
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(directory)) !==
          join(await realpath(this.#options.stateRoot), 'runs', input.runId, 'worktree')
      )
        return { kind: 'BindingRejected' };
      signal.throwIfAborted();
      return await reconcileTerminalCalibrationRun(
        {
          ownerAid: input.user.principal.aid,
          run,
          hostedPrefix: events,
          task: input.task,
          harness: input.harness,
          stateRoot: this.#options.stateRoot,
        },
        {
          outboxes: new SqliteEvidenceOutboxes(
            () => this.#options.now(),
            input.protectedCredentials,
          ),
          ordinary: input.evidence,
          terminal: input.evidence,
          repository: new GitWorktreeChanges(input.protectedCredentials),
          worktree: {
            directory,
            branch: `devrandom/run/${input.runId}`,
            repository: run.binding.repository,
          },
          calibration,
          sealing: (hostedEvidence) =>
            new SealedEvidenceSettlement({
              hostedEvidence,
              hostedSeals: input.evidence,
              exchange: input.mandates.executionAuthority.evidenceSealExchange,
              sourceAid: input.mandates.executionAuthority.personalAgentAid,
              recipientAid: this.#options.issuerAid,
              wait: (milliseconds) => this.#options.wait(milliseconds),
              maximumObservations: 30,
            }),
          now: () => this.#options.now(),
        },
      );
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
