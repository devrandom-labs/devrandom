import { isDeepStrictEqual } from 'node:util';

import {
  continueRun,
  continueCalibrationRun,
  createEvidenceStream,
  type Run,
} from '@devrandom/domain';
import {
  decodeRunProjection,
  decodeRunSuccessorSegment,
  verifyContinuationPredecessor,
  type ActiveHarnessPointer,
  type RunContinuationRequest,
  type RetainedRunContinuationRequest,
  type CalibrationRunContinuationRequest,
  type RunContinuationReceipt,
  type TaskProjection,
} from '@devrandom/protocol';

import type { HostedRunFailure } from './baseline-run-admission.js';
import type { RunPredecessorCustody } from './run-predecessor-custody.js';
import type { CheckpointRepository } from './verified-run-checkpoint.js';
import type { PreparedRunWorktree } from './run-worktree.js';

export interface HostedRunContinuations {
  admitContinuation(
    runId: string,
    command: RunContinuationRequest,
  ): Promise<
    | { readonly kind: 'Admitted' | 'Equivalent'; readonly receipt: RunContinuationReceipt }
    | HostedRunFailure
  >;
}

export interface RunContinuationCommands {
  acquire(input: {
    readonly runId: string;
    readonly command:
      | Omit<RetainedRunContinuationRequest, 'successorIncarnationId' | 'successorStreamId'>
      | Omit<CalibrationRunContinuationRequest, 'successorIncarnationId' | 'successorStreamId'>;
  }): Promise<
    | { readonly kind: 'Recorded'; readonly command: RunContinuationRequest }
    | { readonly kind: 'Rejected' | 'Unavailable' }
  >;
  recordReceipt(
    runId: string,
    command: RunContinuationRequest,
    receipt: RunContinuationReceipt,
  ): Promise<{ readonly kind: 'Recorded' } | { readonly kind: 'Rejected' | 'Unavailable' }>;
}

export interface RunContinuationPreparation {
  readonly ownerAid: string;
  readonly task: TaskProjection;
  readonly run: Run;
  readonly activation: ActiveHarnessPointer;
  readonly predecessor: RunPredecessorCustody;
  readonly worktree: PreparedRunWorktree;
}

export type TaskResumption =
  | {
      readonly kind: 'Admitted';
      readonly run: Run;
      readonly receipt: RunContinuationReceipt;
      readonly leaseRequestStartedAt: number;
    }
  | {
      readonly kind:
        | 'AuthorityRejected'
        | 'BindingRejected'
        | 'PredecessorRejected'
        | 'ArtifactMismatch'
        | 'LeaseStillHeld'
        | 'AdmissionRejected'
        | 'Unavailable';
    };

/** Reverify exact durable progress and current custody before one same-Run replacement lease. */
export async function resumeTask(
  input: RunContinuationPreparation,
  dependencies: {
    readonly authority: {
      verify(run: Run): Promise<{ readonly kind: 'Current' | 'Rejected' | 'Unavailable' }>;
    };
    readonly repository: CheckpointRepository;
    readonly commands: RunContinuationCommands;
    readonly hosted: HostedRunContinuations;
    now(): string;
    monotonicNow(): number;
  },
  signal: AbortSignal,
): Promise<TaskResumption> {
  try {
    signal.throwIfAborted();
    const { run, task, activation, predecessor } = input;
    if (
      run.lifecycle.kind !== 'Active' ||
      run.lifecycle.phase.kind !== 'Blocked' ||
      run.lease.kind !== 'Held' ||
      run.binding.ownerAid !== input.ownerAid ||
      task.ownerAid !== input.ownerAid ||
      task.lifecycle.kind !== 'Open' ||
      task.taskId !== run.binding.taskId ||
      task.revisionSaid !== run.binding.taskRevisionSaid ||
      task.harnessLineageId !== run.binding.harnessLineageId ||
      activation.taskId !== task.taskId ||
      activation.taskRevisionSaid !== task.revisionSaid ||
      activation.harnessLineageId !== task.harnessLineageId ||
      (run.binding.purpose.kind === 'Retained'
        ? activation.kind !== 'Committed' ||
          activation.disposition !== 'Activated' ||
          activation.activeRevisionSaid === run.binding.initialHarnessRevisionSaid
        : activation.kind !== 'Initial' ||
          activation.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
          run.lifecycle.phase.reason !== 'ContextLimitReached')
    )
      return { kind: 'BindingRejected' };
    const authority = await dependencies.authority.verify(run);
    if (authority.kind !== 'Current')
      return { kind: authority.kind === 'Unavailable' ? 'Unavailable' : 'AuthorityRejected' };
    const stream = predecessor.stream;
    if (
      stream.seal.kind !== 'Sealed' ||
      stream.cursor.kind !== 'Accepted' ||
      stream.checkpoint.kind !== 'Accepted' ||
      stream.checkpoint.checkpointSaid !== predecessor.checkpoint.d ||
      stream.runId !== run.binding.runId ||
      stream.evidenceStreamId !==
        (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId)
    )
      return { kind: 'PredecessorRejected' };
    const created = createEvidenceStream({
      streamId: stream.evidenceStreamId,
      runId: run.binding.runId,
      ownerAid: run.binding.ownerAid,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      incarnationId: run.lease.incarnationId,
      harnessRevisionSaid:
        run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      combinedByteCeiling: run.binding.budget.evidencePlusArtifactsPerRunBytes,
    });
    if (
      created.kind !== 'Created' ||
      verifyContinuationPredecessor({
        run,
        stream: {
          ...created.stream,
          cursor: {
            kind: 'Continued',
            acceptedThrough: stream.cursor.acceptedThroughSequence,
            chainHeadSaid: stream.cursor.chainHeadSaid,
          },
          seal: {
            kind: 'Sealed',
            exchangeSaid: stream.seal.sealExchangeSaid,
            sealedAt: stream.seal.sealedAt,
          },
          provisional: {
            kind: 'Checkpointed',
            checkpointSaid: predecessor.checkpoint.d,
            lifecycle: run.lifecycle,
            submissionVerification: run.submissionVerification,
          },
        },
        checkpoint: predecessor.checkpoint,
        events: predecessor.events,
        sealExchangeSaid: stream.seal.sealExchangeSaid,
        chainHeadSaid: stream.cursor.chainHeadSaid,
        completionConditionIds: task.revision.completionConditions.map(({ id }) => id),
      }) !== 'Verified'
    )
      return { kind: 'PredecessorRejected' };
    if (predecessor.checkpoint.version !== 1) return { kind: 'PredecessorRejected' };
    const captured = await dependencies.repository.capture(
      input.worktree,
      {
        changedFiles: run.binding.budget.changedFiles,
        changedWorktreeBytes: run.binding.budget.changedWorktreeBytes,
      },
      signal,
    );
    if (
      captured.kind !== 'Captured' ||
      !isDeepStrictEqual(captured.repository, predecessor.checkpoint.repository)
    )
      return { kind: 'ArtifactMismatch' };
    const prepared = await dependencies.commands.acquire({
      runId: run.binding.runId,
      command:
        activation.kind === 'Initial'
          ? {
              version: 2,
              kind: 'CalibrationContinuation',
              expectedRunVersion: run.version,
              predecessorCheckpointSaid: predecessor.checkpoint.d,
              predecessorSealSaid: stream.seal.sealExchangeSaid,
              predecessorHeadSaid: stream.cursor.chainHeadSaid,
              expectedHarnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
            }
          : {
              version: 1,
              expectedRunVersion: run.version,
              predecessorCheckpointSaid: predecessor.checkpoint.d,
              predecessorSealSaid: stream.seal.sealExchangeSaid,
              predecessorHeadSaid: stream.cursor.chainHeadSaid,
              expectedActivePointerVersion: activation.pointerVersion,
              expectedActivationReceiptSaid: activation.decisionReceiptSaid,
            },
    });
    if (prepared.kind !== 'Recorded') return { kind: 'Unavailable' };
    signal.throwIfAborted();
    if (Date.parse(run.lease.expiresAt) > Date.parse(dependencies.now()))
      return { kind: 'LeaseStillHeld' };
    const leaseRequestStartedAt = dependencies.monotonicNow();
    const admitted = await dependencies.hosted.admitContinuation(
      run.binding.runId,
      prepared.command,
    );
    if (admitted.kind !== 'Admitted' && admitted.kind !== 'Equivalent')
      return { kind: 'AdmissionRejected' };
    const segment = decodeRunSuccessorSegment(admitted.receipt.segment);
    const decoded = decodeRunProjection(admitted.receipt.run);
    if (segment.kind !== 'Accepted' || decoded.kind !== 'Accepted')
      return { kind: 'AdmissionRejected' };
    const replacement = {
      expectedRunVersion: prepared.command.expectedRunVersion,
      serverTime: segment.segment.admittedAt,
      predecessor: {
        incarnationId: run.lease.incarnationId,
        evidenceStreamId: stream.evidenceStreamId,
        checkpointSaid: predecessor.checkpoint.d,
      },
      successor: {
        segmentSaid: segment.segment.d,
        incarnationId: prepared.command.successorIncarnationId,
        evidenceStreamId: prepared.command.successorStreamId,
        harnessRevisionSaid: activation.activeRevisionSaid,
      },
      effects: 'Settled' as const,
    };
    const expected =
      activation.kind === 'Initial'
        ? continueCalibrationRun(run, {
            ...replacement,
            baseline: { pointerVersion: 1, harnessRevisionSaid: activation.activeRevisionSaid },
          })
        : continueRun(run, {
            ...replacement,
            activation: {
              pointerVersion: activation.pointerVersion,
              activeRevisionSaid: activation.activeRevisionSaid,
              decisionReceiptSaid: activation.decisionReceiptSaid,
            },
          });
    if (
      (activation.kind === 'Initial'
        ? segment.segment.version !== 2 ||
          segment.segment.baseline.harnessRevisionSaid !== activation.activeRevisionSaid
        : segment.segment.version !== 1 ||
          segment.segment.activation.decisionReceiptSaid !== activation.decisionReceiptSaid ||
          segment.segment.activation.pointerVersion !== activation.pointerVersion) ||
      expected.kind !== 'Admitted' ||
      !isDeepStrictEqual(expected.run, decoded.run) ||
      segment.segment.runId !== run.binding.runId ||
      segment.segment.ownerAid !== run.binding.ownerAid ||
      segment.segment.personalAgentAid !== run.binding.personalAgentAid ||
      segment.segment.taskMandateSaid !== run.binding.taskMandateSaid ||
      segment.segment.fromRunVersion !== run.version ||
      segment.segment.predecessor.incarnationId !== run.lease.incarnationId ||
      segment.segment.predecessor.evidenceStreamId !== stream.evidenceStreamId ||
      segment.segment.predecessor.finalSequence !== stream.cursor.acceptedThroughSequence ||
      segment.segment.taskId !== task.taskId ||
      segment.segment.taskRevisionSaid !== task.revisionSaid ||
      segment.segment.predecessor.checkpointSaid !== predecessor.checkpoint.d ||
      segment.segment.predecessor.chainHeadSaid !== stream.cursor.chainHeadSaid ||
      segment.segment.predecessor.sealExchangeSaid !== stream.seal.sealExchangeSaid ||
      !isDeepStrictEqual(segment.segment.consumedBudget, run.consumedBudget) ||
      decoded.run.lease.kind !== 'Held' ||
      Date.parse(decoded.run.lease.expiresAt) <= Date.parse(dependencies.now())
    )
      return { kind: 'AdmissionRejected' };
    if (
      (
        await dependencies.commands.recordReceipt(
          run.binding.runId,
          prepared.command,
          admitted.receipt,
        )
      ).kind !== 'Recorded'
    )
      return { kind: 'Unavailable' };
    return { kind: 'Admitted', run: decoded.run, receipt: admitted.receipt, leaseRequestStartedAt };
  } catch {
    return { kind: 'Unavailable' };
  }
}
