import { isDeepStrictEqual } from 'node:util';
import { blockRun, taskBudgetNames, type Run } from '@devrandom/domain';
import {
  prepareVerifiedCheckpoint,
  verifyInterruptedCalibrationPrefix,
  type EvidenceEvent,
  type RunSuccessorSegment,
  type RuntimeRecoveryReconciliationBody,
  type TaskProjection,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';
import type { EvidenceRecorderOpening } from '@devrandom/runtime';
import type { PreparedCompatibilityEvidence } from './prepared-compatibility-calibration-settlement.js';
import {
  deliverNextEvidencePage,
  type HostedEvidence,
  type HostedBatchAppend,
} from './evidence-delivery.js';
import type { CheckpointRepository } from './verified-run-checkpoint.js';
import type { PreparedRunWorktree } from './run-worktree.js';
import type { RunEvidenceSealing } from './sealed-evidence-settlement.js';

export interface HostedRuntimeRecovery {
  reconcileRuntimeRecovery(
    runId: string,
    body: RuntimeRecoveryReconciliationBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend>;
}
export type InterruptedCalibrationReconciliation =
  | { readonly kind: 'Reconciled'; readonly checkpointSaid: string; readonly run: Run }
  | { readonly kind: 'Rejected' | 'Unavailable' };

/** Closes proven startup-only custody; cannot create a lease or execute a model/tool. */
export async function reconcileInterruptedCalibration(
  input: {
    readonly run: Run;
    readonly segment: RunSuccessorSegment;
    readonly task: TaskProjection;
    readonly hostedPrefix: readonly EvidenceEvent[];
    readonly predecessor: VerifiedCheckpoint;
    readonly stateRoot: string;
    readonly executionProfileSaid: string;
    readonly worktree: PreparedRunWorktree;
    readonly signal: AbortSignal;
  },
  dependencies: {
    readonly outboxes: {
      reconcileCalibration(
        opening: EvidenceRecorderOpening,
        prefix: readonly EvidenceEvent[],
        bookkeeping: 'RuntimeRecovery',
      ):
        | {
            readonly kind: 'Opened';
            readonly recorder: PreparedCompatibilityEvidence;
            readonly events: readonly EvidenceEvent[];
          }
        | { readonly kind: string };
    };
    readonly repository: CheckpointRepository;
    readonly hosted: HostedEvidence & HostedRuntimeRecovery;
    sealing(hosted: HostedEvidence): RunEvidenceSealing;
    now(): string;
  },
): Promise<InterruptedCalibrationReconciliation> {
  const { run, task, predecessor, signal } = input;
  const now = dependencies.now();
  const interrupted = () => signal.aborted;
  if (
    interrupted() ||
    !Number.isFinite(Date.parse(now)) ||
    !Number.isFinite(Date.parse(task.revision.expiresAt)) ||
    run.lease.kind !== 'Held' ||
    Date.parse(now) < Date.parse(run.lease.expiresAt) ||
    Date.parse(task.revision.expiresAt) <= Date.parse(now) ||
    task.lifecycle.kind !== 'Open' ||
    task.taskId !== run.binding.taskId ||
    task.revisionSaid !== run.binding.taskRevisionSaid ||
    task.ownerAid !== run.binding.ownerAid ||
    predecessor.version !== 1 ||
    predecessor.d !== input.segment.predecessor.checkpointSaid ||
    predecessor.runId !== run.binding.runId ||
    predecessor.incarnationId !== input.segment.predecessor.incarnationId ||
    !isDeepStrictEqual(predecessor.budget.consumed, input.segment.consumedBudget)
  )
    return { kind: 'Rejected' };
  const opened = dependencies.outboxes.reconcileCalibration(
    { run, stateRoot: input.stateRoot },
    input.hostedPrefix,
    'RuntimeRecovery',
  );
  if (opened.kind !== 'Opened' || !('recorder' in opened)) return { kind: 'Rejected' };
  const { recorder, events } = opened;
  try {
    const prefix = events.slice(0, 4);
    const verified = verifyInterruptedCalibrationPrefix({
      run,
      segment: input.segment,
      events: prefix,
    });
    if (
      verified.kind !== 'Verified' ||
      prefix[2]?.event.kind !== 'RunExecutionProfileBound' ||
      prefix[2].event.executionProfileSaid !== input.executionProfileSaid
    )
      return { kind: 'Rejected' };
    const captured = await dependencies.repository.capture(
      input.worktree,
      {
        changedFiles: run.binding.budget.changedFiles,
        changedWorktreeBytes: run.binding.budget.changedWorktreeBytes,
      },
      signal,
    );
    if (
      interrupted() ||
      captured.kind !== 'Captured' ||
      !isDeepStrictEqual(captured.repository, predecessor.repository)
    )
      return { kind: 'Rejected' };
    const suffix = events.slice(4);
    if (
      suffix.length > 3 ||
      suffix.some((e, i) =>
        i === 0
          ? e.event.kind !== 'CheckpointVerified'
          : i === 1
            ? e.event.kind !== 'RunBlocked' || e.event.reason !== 'ProcessLost'
            : e.event.kind !== 'CheckpointAccepted',
      )
    )
      return { kind: 'Rejected' };
    for (;;) {
      const page = recorder.page();
      if (page.kind === 'Empty') break;
      if (page.kind !== 'Page') return { kind: 'Rejected' };
      if (page.page.events.some((e) => e.sequence >= 4)) break;
      if (
        (await deliverNextEvidencePage({ recorder, hosted: dependencies.hosted, signal })).kind !==
        'Delivered'
      )
        return { kind: 'Rejected' };
    }
    const readiness = recorder.readiness();
    if (readiness.kind !== 'Ready' || readiness.readiness.kind !== 'Continued')
      return { kind: 'Rejected' };
    const consumed = verified.run.consumedBudget;
    const remaining = { ...run.binding.budget };
    for (const name of taskBudgetNames) {
      remaining[name] -= consumed[name];
      if (remaining[name] < 0) return { kind: 'Rejected' };
    }
    const { d: previousSaid, ...draft } = predecessor;
    if (previousSaid !== input.segment.predecessor.checkpointSaid) return { kind: 'Rejected' };
    const prepared = prepareVerifiedCheckpoint(
      {
        ...draft,
        incarnationId: run.lease.incarnationId,
        evidence: { eventCount: 4, finalSequence: 3, chainHeadSaid: prefix[3]?.d ?? '' },
        budget: { consumed, remaining },
        runState: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'ProcessLost' },
          verification: { kind: 'NotSubmitted' },
        },
        continuation: { kind: 'LaterRuntimeRecoveryRequired' },
      },
      task.revision.completionConditions.map((c) => c.id),
    );
    if (prepared.kind !== 'Prepared') return { kind: 'Rejected' };
    const checkpoint = prepared.checkpoint;
    const existing = suffix[0];
    if (existing?.event.kind === 'CheckpointVerified') {
      const read = recorder.checkpoint(existing.event.checkpointSaid);
      if (read.kind !== 'Read' || !isDeepStrictEqual(read.checkpoint, checkpoint))
        return { kind: 'Rejected' };
    } else {
      const stored = recorder.storeCheckpoint({
        checkpoint,
        completionConditionIds: task.revision.completionConditions.map((c) => c.id),
      });
      if (stored.kind !== 'Stored' && stored.kind !== 'AlreadyStored') return { kind: 'Rejected' };
      if (
        recorder.record({
          occurredAt: dependencies.now(),
          producer: { kind: 'EvidenceRecorder' },
          event: { kind: 'CheckpointVerified', checkpointSaid: checkpoint.d },
        }).kind !== 'Recorded'
      )
        return { kind: 'Rejected' };
    }
    if (
      suffix.length < 2 &&
      recorder.record({
        occurredAt: dependencies.now(),
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunBlocked', reason: 'ProcessLost', checkpointSaid: checkpoint.d },
      }).kind !== 'Recorded'
    )
      return { kind: 'Rejected' };
    const hosted: HostedEvidence = {
      storeArtifact: (...args) => dependencies.hosted.storeArtifact(...args),
      appendBatch: (id, body, abort) => {
        const first = body.events[0];
        if (first?.predecessor.kind !== 'Previous' || run.lease.kind !== 'Held')
          return Promise.resolve({ kind: 'InputInvalid' });
        return dependencies.hosted.reconcileRuntimeRecovery(
          id,
          {
            version: 1,
            expected: {
              incarnationId: run.lease.incarnationId,
              runStartedSaid: verified.runStartedSaid,
              acceptedThroughSequence: first.sequence - 1,
              chainHeadSaid: first.predecessor.eventSaid,
            },
            body,
          },
          abort,
        );
      },
    };
    if ((await dependencies.sealing(hosted).settle(recorder, checkpoint.d)).kind !== 'Sealed')
      return { kind: 'Rejected' };
    const blocked = blockRun(verified.run, { reason: 'ProcessLost', checkpointSaid: checkpoint.d });
    return blocked.kind === 'Blocked'
      ? { kind: 'Reconciled', run: blocked.run, checkpointSaid: checkpoint.d }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Unavailable' };
  } finally {
    recorder.close();
  }
}
