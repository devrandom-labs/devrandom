import { isDeepStrictEqual } from 'node:util';

import {
  cancelRun,
  planRunCalibration,
  planRunCancellation,
  recordRunCalibration,
  startRunExecution,
  taskBudgetNames,
  type Run,
} from '@devrandom/domain';
import {
  decodeEvidenceEvent,
  preparePublicVerifierReceipt,
  type BaselineHarnessRevision,
  type EvidenceEvent,
  type EvidenceStreamProjection,
  type TaskProjection,
  type VerifiedCheckpoint,
  type TerminalCalibrationReconciliationBody,
} from '@devrandom/protocol';
import {
  RunResourceBudget,
  type EvidenceRecorderAcquisition,
  type EvidenceRecorderOpening,
} from '@devrandom/runtime';

import {
  deliverNextEvidencePage,
  type HostedBatchAppend,
  type HostedEvidence,
} from './evidence-delivery.js';
import type { PreparedCompatibilityEvidence } from './prepared-compatibility-calibration-settlement.js';
import type { PreparedCompatibilityCalibrationSettlements } from './prepared-compatibility-calibration.js';
import { VerifiedRunCheckpoint, type CheckpointRepository } from './verified-run-checkpoint.js';
import type { PreparedRunWorktree } from './run-worktree.js';
import type { RunEvidenceSealing } from './sealed-evidence-settlement.js';

export interface HostedTerminalCalibration {
  reconcileTerminalCalibration(
    runId: string,
    body: TerminalCalibrationReconciliationBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend>;
}

export interface TerminalCalibrationInput {
  readonly intent?: 'CancelExpiredRun';
  readonly ownerAid: string;
  readonly run: Run;
  readonly hostedPrefix: readonly EvidenceEvent[];
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly stateRoot: string;
}

export interface TerminalCalibrationDependencies {
  readonly outboxes: {
    reconcileCalibration(
      opening: EvidenceRecorderOpening,
      hostedPrefix: readonly EvidenceEvent[],
    ):
      | {
          readonly kind: 'Opened';
          readonly recorder: PreparedCompatibilityEvidence;
          readonly events: readonly EvidenceEvent[];
        }
      | Exclude<
          EvidenceRecorderAcquisition<PreparedCompatibilityEvidence>,
          { readonly kind: 'Opened' }
        >;
  };
  readonly ordinary: HostedEvidence;
  readonly terminal: HostedTerminalCalibration;
  readonly repository: CheckpointRepository;
  readonly interruptedSource?: {
    matches(
      events: readonly EvidenceEvent[],
      recorder: PreparedCompatibilityEvidence,
      repository: Extract<VerifiedCheckpoint, { version: 1 }>['repository'],
    ): boolean;
  };
  readonly worktree: PreparedRunWorktree;
  readonly calibration: PreparedCompatibilityCalibrationSettlements;
  sealing(hosted: HostedEvidence): RunEvidenceSealing;
  now(): string;
}

export type TerminalCalibrationReconciliation =
  | { readonly kind: 'Reconciled'; readonly run: Run; readonly checkpointSaid: string }
  | {
      readonly kind:
        | 'BindingRejected'
        | 'LocalEvidenceRejected'
        | 'OriginalDeliveryRejected'
        | 'CheckpointRejected'
        | 'SealingRejected'
        | 'CalibrationRejected'
        | 'Unavailable';
    };

/** Repair only the local calibration index after the server has verified the native seal. */
export async function reconcileSealedTerminalCalibration(
  input: TerminalCalibrationInput,
  stream: EvidenceStreamProjection,
  calibration: PreparedCompatibilityCalibrationSettlements,
): Promise<TerminalCalibrationReconciliation> {
  const { run, task, harness, hostedPrefix: events } = input;
  const last = events.at(-1);
  if (
    run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    run.lifecycle.kind !== 'Ended' ||
    run.lease.kind !== 'Held' ||
    last?.incarnationId !== run.lease.incarnationId ||
    (run.currentExecution !== undefined &&
      (input.intent !== 'CancelExpiredRun' ||
        run.currentExecution.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        run.lease.segmentSaid !== run.currentExecution.segmentSaid)) ||
    (input.intent === 'CancelExpiredRun'
      ? run.lifecycle.outcome.kind !== 'Cancelled'
      : run.lifecycle.outcome.kind !== 'CalibrationExcluded' ||
        run.lifecycle.outcome.reason !== 'BudgetExhausted') ||
    input.ownerAid !== run.binding.ownerAid ||
    task.ownerAid !== input.ownerAid ||
    task.taskId !== run.binding.taskId ||
    task.revisionSaid !== run.binding.taskRevisionSaid ||
    task.harnessLineageId !== run.binding.harnessLineageId ||
    harness.d !== run.binding.initialHarnessRevisionSaid ||
    harness.authority.personalAgentAid !== run.binding.personalAgentAid ||
    harness.authority.taskMandateSaid !== run.binding.taskMandateSaid ||
    stream.runId !== run.binding.runId ||
    stream.evidenceStreamId !==
      (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId) ||
    stream.seal.kind !== 'Sealed' ||
    stream.cursor.kind !== 'Accepted' ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.checkpoint.checkpointSaid !== run.lifecycle.outcome.checkpointSaid ||
    last.event.kind !== 'CheckpointAccepted' ||
    last.event.checkpointSaid !== stream.checkpoint.checkpointSaid ||
    stream.cursor.eventCount !== events.length ||
    stream.cursor.acceptedThroughSequence !== last.sequence ||
    stream.cursor.chainHeadSaid !== last.d ||
    stream.seal.eventCount !== events.length ||
    stream.seal.finalSequence !== last.sequence ||
    stream.seal.chainHeadSaid !== last.d
  )
    return { kind: 'BindingRejected' };
  const checkpointSaid = stream.checkpoint.checkpointSaid;
  let predecessor: EvidenceEvent | undefined;
  for (const event of events) {
    if (
      decodeEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== (predecessor === undefined ? 0 : predecessor.sequence + 1) ||
      (predecessor === undefined
        ? event.predecessor.kind !== 'Genesis'
        : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== predecessor.d) ||
      event.runId !== run.binding.runId ||
      event.taskId !== run.binding.taskId ||
      event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      event.harnessRevisionSaid !== harness.d ||
      event.personalAgentAid !== run.binding.personalAgentAid ||
      event.taskMandateSaid !== run.binding.taskMandateSaid ||
      event.incarnationId !== last.incarnationId
    )
      return { kind: 'BindingRejected' };
    predecessor = event;
  }
  const starts = events.filter(
    ({ event, producer }) => event.kind === 'RunStarted' && producer.kind === 'RunSupervisor',
  );
  const verified = events.filter(
    ({ event, producer }) =>
      event.kind === 'CheckpointVerified' &&
      producer.kind === 'EvidenceRecorder' &&
      event.checkpointSaid === checkpointSaid,
  );
  const recorded = events.filter(
    ({ event, producer }) =>
      event.kind === 'RunCalibrationRecorded' &&
      producer.kind === 'RunSupervisor' &&
      event.checkpointSaid === checkpointSaid &&
      event.disposition.kind === 'Excluded' &&
      event.disposition.reason === 'BudgetExhausted',
  );
  if (
    starts.length !== 1 ||
    verified.length !== 1 ||
    (input.intent === 'CancelExpiredRun'
      ? recorded.length !== 0
      : recorded.length !== 1 ||
        (verified[0]?.sequence ?? Infinity) >= (recorded[0]?.sequence ?? -1)) ||
    last.producer.kind !== 'EvidenceRecorder'
  )
    return { kind: 'BindingRejected' };
  if (input.intent === 'CancelExpiredRun') {
    if (
      events.some(
        ({ event }) => event.kind === 'RunCalibrationRecorded' || event.kind === 'ResultSubmitted',
      ) ||
      run.submissionVerification.kind !== 'NotSubmitted'
    )
      return { kind: 'BindingRejected' };
    return { kind: 'Reconciled', run, checkpointSaid };
  }
  const committed = await calibration.record({
    kind: 'ExcludedRun',
    runId: run.binding.runId,
    reason: 'BudgetExhausted',
  });
  return committed.kind === 'Recorded'
    ? { kind: 'Reconciled', run, checkpointSaid: checkpointSaid }
    : { kind: 'CalibrationRejected' };
}

/** Run application bookkeeping. It has no executor, effect, admission, or lease capability. */
export async function reconcileTerminalCalibrationRun(
  input: TerminalCalibrationInput,
  dependencies: TerminalCalibrationDependencies,
): Promise<TerminalCalibrationReconciliation> {
  const { run, task, harness } = input;
  const cancellation = input.intent === 'CancelExpiredRun';
  if (
    run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    run.lease.kind !== 'Held' ||
    (run.currentExecution !== undefined &&
      (!cancellation ||
        run.currentExecution.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        run.lease.segmentSaid !== run.currentExecution.segmentSaid)) ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Preparing' ||
    !Number.isFinite(Date.parse(dependencies.now())) ||
    Date.parse(dependencies.now()) < Date.parse(run.lease.expiresAt) ||
    input.ownerAid !== run.binding.ownerAid ||
    task.ownerAid !== input.ownerAid ||
    task.lifecycle.kind !== 'Open' ||
    (cancellation &&
      (!Number.isFinite(Date.parse(task.revision.expiresAt)) ||
        Date.parse(task.revision.expiresAt) > Date.parse(dependencies.now()))) ||
    task.taskId !== run.binding.taskId ||
    task.revisionSaid !== run.binding.taskRevisionSaid ||
    task.harnessLineageId !== run.binding.harnessLineageId ||
    harness.d !== run.binding.initialHarnessRevisionSaid ||
    harness.authority.personalAgentAid !== run.binding.personalAgentAid ||
    harness.authority.taskMandateSaid !== run.binding.taskMandateSaid ||
    !isDeepStrictEqual(task.revision.repository, run.binding.repository)
  )
    return { kind: 'BindingRejected' };
  const opened = dependencies.outboxes.reconcileCalibration(
    { run, stateRoot: input.stateRoot },
    input.hostedPrefix,
  );
  if (opened.kind !== 'Opened') return { kind: 'LocalEvidenceRejected' };
  const { recorder, events } = opened;
  try {
    const starts = events.filter((event) => event.event.kind === 'RunStarted');
    const started = starts[0];
    if (
      starts.length !== 1 ||
      started === undefined ||
      started.event.kind !== 'RunStarted' ||
      !input.hostedPrefix.some(({ d }) => d === started.d) ||
      started.event.fromRunVersion > run.version ||
      started.producer.kind !== 'RunSupervisor'
    )
      return { kind: 'LocalEvidenceRejected' };
    // Reapply the historical transition at its recorded time; this does not acquire a lease.
    const replay = startRunExecution(
      { ...run, version: started.event.fromRunVersion },
      {
        incarnationId: run.lease.incarnationId,
        leaseObservedAt: started.occurredAt,
        worktree: { repository: run.binding.repository },
        evidence: {
          kind: 'Genesis',
          streamId: run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId,
        },
      },
    );
    if (replay.kind !== 'Started') return { kind: 'LocalEvidenceRejected' };
    const consumed = { ...run.consumedBudget };
    if (run.currentExecution === undefined) for (const name of taskBudgetNames) consumed[name] = 0;
    for (const { event } of events) {
      if (event.kind !== 'BudgetDebited') continue;
      if (
        !Number.isSafeInteger(consumed[event.budget] + event.amount) ||
        consumed[event.budget] + event.amount !== event.consumed
      )
        return { kind: 'LocalEvidenceRejected' };
      consumed[event.budget] = event.consumed;
    }
    if (taskBudgetNames.some((name) => consumed[name] < run.consumedBudget[name]))
      return { kind: 'LocalEvidenceRejected' };
    const running: Run = { ...replay.run, consumedBudget: consumed };
    if (cancellation && events.some(({ event }) => event.kind === 'ResultSubmitted'))
      return { kind: 'BindingRejected' };
    const checkpoints = events.filter(({ event }) => event.kind === 'CheckpointVerified');
    if (checkpoints.length > 1) return { kind: 'LocalEvidenceRejected' };
    // Original observations must retain their original bytes and the ordinary admission law.
    for (;;) {
      const pending = recorder.page();
      if (pending.kind === 'Empty') break;
      if (pending.kind !== 'Page') return { kind: 'LocalEvidenceRejected' };
      if (
        pending.page.events.some(
          (event) =>
            Date.parse(event.recordedAt) >=
            Date.parse(run.lease.kind === 'Held' ? run.lease.expiresAt : ''),
        )
      )
        break;
      const delivery = await deliverNextEvidencePage({ recorder, hosted: dependencies.ordinary });
      if (delivery.kind !== 'Delivered') return { kind: 'OriginalDeliveryRejected' };
    }
    const terminalHosted: HostedEvidence = {
      storeArtifact: (...arguments_) => dependencies.ordinary.storeArtifact(...arguments_),
      appendBatch: (runId, body, signal) => {
        const first = body.events[0];
        if (
          first === undefined ||
          first.predecessor.kind !== 'Previous' ||
          run.lease.kind !== 'Held'
        )
          return Promise.resolve({ kind: 'InputInvalid' });
        return dependencies.terminal.reconcileTerminalCalibration(
          runId,
          {
            version: 1,
            expected: {
              incarnationId: run.lease.incarnationId,
              runStartedSaid: started.d,
              acceptedThroughSequence: first.sequence - 1,
              chainHeadSaid: first.predecessor.eventSaid,
            },
            body,
          },
          signal,
        );
      },
    };
    const attempt = {
      kind: 'ExcludedRun' as const,
      runId: run.binding.runId,
      reason: 'BudgetExhausted' as const,
    };
    const assessed = cancellation ? undefined : await dependencies.calibration.assess(attempt);
    if (
      !cancellation &&
      (assessed?.kind !== 'Accepted' ||
        assessed.disposition.kind !== 'Excluded' ||
        assessed.disposition.reason !== 'BudgetExhausted')
    )
      return { kind: 'CalibrationRejected' };
    let checkpointSaid: string;
    const existing = checkpoints[0];
    if (existing !== undefined && existing.event.kind === 'CheckpointVerified') {
      checkpointSaid = existing.event.checkpointSaid;
      const checkpoint = recorder.checkpoint(checkpointSaid);
      if (
        checkpoint.kind !== 'Read' ||
        checkpoint.checkpoint.runState.kind !== 'Ended' ||
        (cancellation
          ? checkpoint.checkpoint.runState.outcome.kind !== 'Cancelled'
          : checkpoint.checkpoint.runState.outcome.kind !== 'CalibrationExcluded' ||
            checkpoint.checkpoint.runState.outcome.reason !== 'BudgetExhausted')
      )
        return { kind: 'CheckpointRejected' };
      if (cancellation) {
        const captured = await dependencies.repository.capture(dependencies.worktree, {
          changedFiles: run.binding.budget.changedFiles,
          changedWorktreeBytes: run.binding.budget.changedWorktreeBytes,
        });
        if (
          captured.kind !== 'Captured' ||
          !isDeepStrictEqual(captured.repository, checkpoint.checkpoint.repository) ||
          dependencies.interruptedSource?.matches(events, recorder, captured.repository) !== true
        )
          return { kind: 'CheckpointRejected' };
      }
    } else {
      // A crash between accounting and checkpoint persistence cannot safely measure/debit twice.
      if (
        events.some(
          (event) =>
            Date.parse(event.recordedAt) >=
            Date.parse(run.lease.kind === 'Held' ? run.lease.expiresAt : ''),
        )
      )
        return { kind: 'CheckpointRejected' };
      const plan = cancellation
        ? planRunCancellation(running)
        : assessed?.kind === 'Accepted'
          ? planRunCalibration(running, assessed.disposition)
          : undefined;
      if (plan?.kind !== 'Planned') return { kind: 'CheckpointRejected' };
      const receipts = harness.completionCommands.map((command) =>
        preparePublicVerifierReceipt({
          version: 1,
          completionConditionId: command.identity,
          commandSaid: command.contentSaid,
          recordedAt: dependencies.now(),
          outcome: { kind: 'Unresolved', reason: 'NotAttempted' },
        }),
      );
      if (receipts.some((receipt) => receipt.kind !== 'Prepared'))
        return { kind: 'CheckpointRejected' };
      const checkpoint = await new VerifiedRunCheckpoint({
        task,
        harness,
        worktree: dependencies.worktree,
        evidence: recorder,
        budget: new RunResourceBudget({
          run: running,
          evidence: recorder,
          now: () => dependencies.now(),
        }),
        repository: {
          capture: async (worktree, limits, signal) => {
            const captured = await dependencies.repository.capture(worktree, limits, signal);
            if (
              cancellation &&
              (captured.kind !== 'Captured' ||
                dependencies.interruptedSource?.matches(events, recorder, captured.repository) !==
                  true)
            )
              return { kind: 'RepositoryBindingRejected' };
            return !cancellation &&
              captured.kind === 'Captured' &&
              captured.changedWorktreeBytes + consumed.changedWorktreeBytes <=
                run.binding.budget.changedWorktreeBytes
              ? { kind: 'RepositoryBindingRejected' }
              : captured;
          },
        },
        now: () => dependencies.now(),
      }).materialize({
        run: running,
        verifierReceipts: receipts.flatMap((receipt) =>
          receipt.kind === 'Prepared' ? [receipt.receipt] : [],
        ),
        outputArtifactSaids: [],
        disposition: {
          runState: {
            kind: 'Ended',
            outcome: plan.state.outcome,
            verification: plan.state.submissionVerification,
          },
          continuation: { kind: 'NoContinuation' },
        },
      });
      if (checkpoint.kind !== 'Materialized') return { kind: 'CheckpointRejected' };
      checkpointSaid = checkpoint.checkpoint.d;
    }
    const stored = recorder.checkpoint(checkpointSaid);
    if (stored.kind !== 'Read') return { kind: 'CheckpointRejected' };
    const checkpointedRun = { ...running, consumedBudget: stored.checkpoint.budget.consumed };
    const recorded = cancellation
      ? cancelRun(checkpointedRun, { checkpointSaid })
      : assessed?.kind === 'Accepted'
        ? recordRunCalibration(checkpointedRun, {
            checkpointSaid,
            disposition: assessed.disposition,
          })
        : undefined;
    if (recorded?.kind !== 'Recorded' && recorded?.kind !== 'Cancelled')
      return { kind: 'CalibrationRejected' };
    const calibrationEvents = events.filter(({ event }) => event.kind === 'RunCalibrationRecorded');
    if (calibrationEvents.length > 1) return { kind: 'LocalEvidenceRejected' };
    if (
      !cancellation &&
      assessed?.kind === 'Accepted' &&
      calibrationEvents.length === 0 &&
      recorder.record({
        occurredAt: dependencies.now(),
        producer: { kind: 'RunSupervisor' },
        event: {
          kind: 'RunCalibrationRecorded',
          checkpointSaid,
          disposition: assessed.disposition,
        },
      }).kind !== 'Recorded'
    )
      return { kind: 'LocalEvidenceRejected' };
    if (
      (await dependencies.sealing(terminalHosted).settle(recorder, checkpointSaid)).kind !==
      'Sealed'
    )
      return { kind: 'SealingRejected' };
    if (!cancellation && (await dependencies.calibration.record(attempt)).kind !== 'Recorded')
      return { kind: 'CalibrationRejected' };
    return { kind: 'Reconciled', run: recorded.run, checkpointSaid };
  } catch {
    return { kind: 'Unavailable' };
  } finally {
    recorder.close();
  }
}
