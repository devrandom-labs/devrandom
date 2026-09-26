import {
  taskBudgetNames,
  type EvidenceStream,
  type Run,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  decodeAppendEvidenceBatchBody,
  decodeEvidenceEvent,
  type AppendEvidenceBatchBody,
  type EvidenceEvent,
  type TerminalCalibrationReconciliationBody,
} from '@devrandom/protocol';

import { evidenceCheckpointBelongsToRun } from '../domain/run-binding.js';
import type { EvidenceBatchCommitment } from './evidence-batches.js';

export interface TerminalCalibrationReconciliationInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly command: TerminalCalibrationReconciliationBody;
  readonly receivedAt: string;
}

/** Transactional conversation that never grants execution or extends a lease. */
export interface TerminalCalibrationEvidence {
  reconcile(input: TerminalCalibrationReconciliationInput): Promise<EvidenceBatchCommitment>;
}

/** The hosted prefix is authoritative; this capability admits bookkeeping only. */
export interface TerminalCalibrationBatchInput {
  readonly run: Run;
  readonly stream: EvidenceStream;
  readonly runStarted: EvidenceEvent;
  readonly acceptedBudget: TaskBudgets;
  readonly completionConditionIds: readonly string[];
  readonly expected: {
    readonly incarnationId: string;
    readonly runStartedSaid: string;
    readonly acceptedThroughSequence: number;
    readonly chainHeadSaid: string;
  };
  readonly body: AppendEvidenceBatchBody;
  readonly receivedAt: string;
}

export type TerminalCalibrationBatchAssessment =
  | { readonly kind: 'Accepted'; readonly phase: 'Checkpoint' | 'Acknowledgement' }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'RunNotEligible'
        | 'CursorConflict'
        | 'RunStartedConflict'
        | 'BatchInvalid'
        | 'EventBindingConflict'
        | 'TerminalSequenceInvalid'
        | 'CheckpointInvalid'
        | 'BudgetMismatch';
    };

function reject(
  reason: Extract<TerminalCalibrationBatchAssessment, { kind: 'Rejected' }>['reason'],
): TerminalCalibrationBatchAssessment {
  return { kind: 'Rejected', reason };
}

function exactTime(instant: string): number | undefined {
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === instant ? parsed : undefined;
}

function matchesRun(event: EvidenceEvent, run: Run, incarnationId: string): boolean {
  return (
    event.taskId === run.binding.taskId &&
    event.taskRevisionSaid === run.binding.taskRevisionSaid &&
    event.runId === run.binding.runId &&
    event.incarnationId === incarnationId &&
    event.harnessRevisionSaid === run.binding.initialHarnessRevisionSaid &&
    event.personalAgentAid === run.binding.personalAgentAid &&
    event.taskMandateSaid === run.binding.taskMandateSaid
  );
}

function budgetAfter(
  prior: TaskBudgets,
  events: readonly EvidenceEvent[],
): TaskBudgets | undefined {
  let consumed = { ...prior };
  for (const event of events) {
    if (event.event.kind !== 'BudgetDebited') continue;
    const { budget, amount } = event.event;
    if (
      (budget !== 'changedFiles' && budget !== 'changedWorktreeBytes') ||
      event.producer.kind !== 'EvidenceRecorder' ||
      amount <= 0 ||
      !Number.isSafeInteger(consumed[budget] + amount) ||
      consumed[budget] + amount !== event.event.consumed
    )
      return undefined;
    consumed = { ...consumed, [budget]: event.event.consumed };
  }
  return consumed;
}

/** W0 E2/E3: original Run/incarnation, exact accepted prefix, no new effect. */
export function assessTerminalCalibrationBatch(
  input: TerminalCalibrationBatchInput,
): TerminalCalibrationBatchAssessment {
  const { run, stream, runStarted, expected, body } = input;
  const lease = run.lease;
  const receivedAt = exactTime(input.receivedAt);
  if (
    run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Preparing' ||
    lease.kind !== 'Held' ||
    receivedAt === undefined ||
    exactTime(lease.expiresAt) === undefined ||
    receivedAt < Date.parse(lease.expiresAt) ||
    stream.seal.kind !== 'Open' ||
    stream.binding.ownerAid !== run.binding.ownerAid ||
    stream.binding.runId !== run.binding.runId ||
    stream.binding.streamId !== run.binding.evidenceStreamId ||
    stream.binding.incarnationId !== lease.incarnationId
  )
    return reject('RunNotEligible');
  if (
    stream.cursor.kind !== 'Continued' ||
    expected.acceptedThroughSequence !== stream.cursor.acceptedThrough ||
    expected.chainHeadSaid !== stream.cursor.chainHeadSaid ||
    expected.incarnationId !== lease.incarnationId
  )
    return reject('CursorConflict');
  if (
    decodeEvidenceEvent(runStarted).kind !== 'Accepted' ||
    runStarted.sequence !== 0 ||
    runStarted.event.kind !== 'RunStarted' ||
    runStarted.d !== expected.runStartedSaid ||
    !matchesRun(runStarted, run, lease.incarnationId) ||
    runStarted.event.fromRunVersion < 1 ||
    runStarted.event.fromRunVersion > run.version ||
    (exactTime(runStarted.recordedAt) ?? Infinity) >= Date.parse(lease.expiresAt)
  )
    return reject('RunStartedConflict');
  if (decodeAppendEvidenceBatchBody(body, input.completionConditionIds).kind !== 'Accepted')
    return reject('BatchInvalid');
  if (
    body.batch.runId !== run.binding.runId ||
    body.batch.evidenceStreamId !== run.binding.evidenceStreamId ||
    body.batch.startingSequence !== stream.cursor.acceptedThrough + 1 ||
    body.batch.predecessor.kind !== 'Previous' ||
    body.batch.predecessor.eventSaid !== stream.cursor.chainHeadSaid
  )
    return reject('CursorConflict');
  for (const event of body.events) {
    const occurredAt = exactTime(event.occurredAt);
    const recordedAt = exactTime(event.recordedAt);
    if (
      !matchesRun(event, run, lease.incarnationId) ||
      occurredAt === undefined ||
      recordedAt === undefined ||
      occurredAt < Date.parse(lease.expiresAt) ||
      recordedAt < Date.parse(lease.expiresAt) ||
      occurredAt > recordedAt ||
      recordedAt > receivedAt
    )
      return reject('EventBindingConflict');
  }
  if (stream.provisional.kind === 'Checkpointed') {
    const event = body.events[0];
    return body.events.length === 1 &&
      body.checkpoint === undefined &&
      stream.provisional.lifecycle.kind === 'Ended' &&
      stream.provisional.lifecycle.outcome.kind === 'CalibrationExcluded' &&
      stream.provisional.lifecycle.outcome.reason === 'BudgetExhausted' &&
      event?.producer.kind === 'EvidenceRecorder' &&
      event.event.kind === 'CheckpointAccepted' &&
      event.event.checkpointSaid === stream.provisional.checkpointSaid
      ? { kind: 'Accepted', phase: 'Acknowledgement' }
      : reject('TerminalSequenceInvalid');
  }
  const checkpoint = body.checkpoint;
  const markerIndex = body.events.findIndex((event) => event.event.kind === 'CheckpointVerified');
  const marker = body.events[markerIndex];
  const recorded = body.events[markerIndex + 1];
  if (
    stream.provisional.kind !== 'None' ||
    checkpoint === undefined ||
    markerIndex < 0 ||
    markerIndex !== body.events.length - 2 ||
    marker?.producer.kind !== 'EvidenceRecorder' ||
    marker.event.kind !== 'CheckpointVerified' ||
    marker.event.checkpointSaid !== checkpoint.d ||
    recorded?.producer.kind !== 'RunSupervisor' ||
    recorded.event.kind !== 'RunCalibrationRecorded' ||
    recorded.event.checkpointSaid !== checkpoint.d ||
    recorded.event.disposition.kind !== 'Excluded' ||
    recorded.event.disposition.reason !== 'BudgetExhausted' ||
    checkpoint.runState.kind !== 'Ended' ||
    checkpoint.runState.outcome.kind !== 'CalibrationExcluded' ||
    checkpoint.runState.outcome.reason !== 'BudgetExhausted' ||
    checkpoint.runState.verification.kind !== 'NotSubmitted'
  )
    return reject('TerminalSequenceInvalid');
  if (
    body.events
      .slice(0, markerIndex)
      .some(
        (event) =>
          event.event.kind !== 'BudgetDebited' || event.producer.kind !== 'EvidenceRecorder',
      ) ||
    !evidenceCheckpointBelongsToRun(checkpoint, run) ||
    checkpoint.version !== 1
  )
    return reject('CheckpointInvalid');
  const priorHead = body.events[markerIndex - 1];
  if (
    checkpoint.evidence.finalSequence !== (priorHead?.sequence ?? stream.cursor.acceptedThrough) ||
    checkpoint.evidence.chainHeadSaid !== (priorHead?.d ?? stream.cursor.chainHeadSaid) ||
    checkpoint.evidence.eventCount !== checkpoint.evidence.finalSequence + 1
  )
    return reject('CheckpointInvalid');
  const consumed = budgetAfter(input.acceptedBudget, body.events.slice(0, markerIndex));
  if (
    consumed === undefined ||
    taskBudgetNames.some(
      (name) =>
        checkpoint.budget.consumed[name] !== consumed[name] ||
        checkpoint.budget.remaining[name] !==
          Math.max(0, run.binding.budget[name] - consumed[name]),
    ) ||
    consumed.changedWorktreeBytes <= run.binding.budget.changedWorktreeBytes ||
    checkpoint.repository.changedFiles.length !== consumed.changedFiles
  )
    return reject('BudgetMismatch');
  return { kind: 'Accepted', phase: 'Checkpoint' };
}
