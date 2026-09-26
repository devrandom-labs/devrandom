import { isDeepStrictEqual } from 'node:util';
import { taskBudgetNames, type Run, type EvidenceStream } from '@devrandom/domain';
import {
  decodeAppendEvidenceBatchBody,
  decodeEvidenceEvent,
  verifyInterruptedCalibrationPrefix,
  type EvidenceEvent,
  type VerifiedCheckpoint,
  type RunSuccessorSegment,
  type RuntimeRecoveryReconciliationBody,
} from '@devrandom/protocol';
import { evidenceCheckpointBelongsToRun } from '../domain/run-binding.js';
import type { EvidenceBatchCommitment } from './evidence-batches.js';

export interface RuntimeRecoveryReconciliationInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly command: RuntimeRecoveryReconciliationBody;
  readonly receivedAt: string;
}
export interface RuntimeRecoveryEvidence {
  reconcile(input: RuntimeRecoveryReconciliationInput): Promise<EvidenceBatchCommitment>;
}
export interface RuntimeRecoveryBatchInput {
  readonly run: Run;
  readonly stream: EvidenceStream;
  readonly segment: RunSuccessorSegment;
  readonly predecessorCheckpoint: VerifiedCheckpoint;
  readonly acceptedEvents: readonly EvidenceEvent[];
  readonly completionConditionIds: readonly string[];
  readonly expected: RuntimeRecoveryReconciliationBody['expected'];
  readonly body: RuntimeRecoveryReconciliationBody['body'];
  readonly receivedAt: string;
}
export type RuntimeRecoveryBatchAssessment =
  | { readonly kind: 'Accepted'; readonly phase: 'Checkpoint' | 'Acknowledgement' }
  | { readonly kind: 'Rejected' };

/** E2/E5 accounting-only custody: never grants authority or attributes task failure. */
export function assessRuntimeRecoveryBatch(
  input: RuntimeRecoveryBatchInput,
): RuntimeRecoveryBatchAssessment {
  const { run, stream, segment, acceptedEvents, expected, body, receivedAt } = input;
  const reject = { kind: 'Rejected' } as const;
  const observed = Date.parse(receivedAt);
  if (
    run.lease.kind !== 'Held' ||
    !Number.isFinite(observed) ||
    new Date(observed).toISOString() !== receivedAt ||
    observed < Date.parse(run.lease.expiresAt) ||
    stream.seal.kind !== 'Open' ||
    stream.cursor.kind !== 'Continued' ||
    stream.binding.runId !== run.binding.runId ||
    stream.binding.ownerAid !== run.binding.ownerAid ||
    stream.binding.streamId !== run.currentExecution?.evidenceStreamId ||
    stream.binding.incarnationId !== run.lease.incarnationId ||
    expected.incarnationId !== run.lease.incarnationId ||
    expected.acceptedThroughSequence !== stream.cursor.acceptedThrough ||
    expected.chainHeadSaid !== stream.cursor.chainHeadSaid ||
    acceptedEvents.length !== stream.cursor.acceptedThrough + 1 ||
    acceptedEvents.at(-1)?.d !== stream.cursor.chainHeadSaid ||
    decodeAppendEvidenceBatchBody(body, input.completionConditionIds).kind !== 'Accepted' ||
    body.batch.runId !== run.binding.runId ||
    body.batch.evidenceStreamId !== stream.binding.streamId ||
    body.batch.startingSequence !== acceptedEvents.length ||
    body.batch.predecessor.kind !== 'Previous' ||
    body.batch.predecessor.eventSaid !== stream.cursor.chainHeadSaid
  )
    return reject;
  const prefix = verifyInterruptedCalibrationPrefix({
    run,
    segment,
    events: acceptedEvents.slice(0, 4),
  });
  if (
    prefix.kind !== 'Verified' ||
    prefix.runStartedSaid !== expected.runStartedSaid ||
    taskBudgetNames.some((name) => prefix.run.consumedBudget[name] > run.binding.budget[name])
  )
    return reject;
  for (const event of body.events) {
    if (
      decodeEvidenceEvent(event).kind !== 'Accepted' ||
      event.runId !== run.binding.runId ||
      event.taskId !== run.binding.taskId ||
      event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      event.incarnationId !== run.lease.incarnationId ||
      event.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      event.personalAgentAid !== run.binding.personalAgentAid ||
      event.taskMandateSaid !== run.binding.taskMandateSaid ||
      Date.parse(event.recordedAt) < Date.parse(run.lease.expiresAt) ||
      Date.parse(event.occurredAt) < Date.parse(run.lease.expiresAt) ||
      Date.parse(event.occurredAt) > Date.parse(event.recordedAt) ||
      Date.parse(event.recordedAt) > observed
    )
      return reject;
  }
  if (stream.provisional.kind === 'Checkpointed') {
    const verified = acceptedEvents[4],
      blocked = acceptedEvents[5],
      ack = body.events[0];
    if (
      acceptedEvents.length !== 6 ||
      verified?.event.kind !== 'CheckpointVerified' ||
      verified.producer.kind !== 'EvidenceRecorder' ||
      verified.predecessor.kind !== 'Previous' ||
      verified.predecessor.eventSaid !== acceptedEvents[3]?.d ||
      blocked?.event.kind !== 'RunBlocked' ||
      blocked.event.reason !== 'ProcessLost' ||
      blocked.producer.kind !== 'RunSupervisor' ||
      blocked.predecessor.kind !== 'Previous' ||
      blocked.predecessor.eventSaid !== verified.d ||
      verified.event.checkpointSaid !== stream.provisional.checkpointSaid ||
      blocked.event.checkpointSaid !== stream.provisional.checkpointSaid ||
      stream.provisional.lifecycle.kind !== 'Active' ||
      stream.provisional.lifecycle.phase.kind !== 'Blocked' ||
      stream.provisional.lifecycle.phase.reason !== 'ProcessLost' ||
      stream.provisional.submissionVerification.kind !== 'NotSubmitted' ||
      body.checkpoint !== undefined ||
      body.events.length !== 1 ||
      ack?.event.kind !== 'CheckpointAccepted' ||
      ack.producer.kind !== 'EvidenceRecorder' ||
      ack.event.checkpointSaid !== stream.provisional.checkpointSaid
    )
      return reject;
    return { kind: 'Accepted', phase: 'Acknowledgement' };
  }
  const checkpoint = body.checkpoint,
    verified = body.events[0],
    blocked = body.events[1];
  if (
    acceptedEvents.length !== 4 ||
    body.events.length !== 2 ||
    checkpoint === undefined ||
    checkpoint.version !== 1 ||
    verified?.event.kind !== 'CheckpointVerified' ||
    verified.producer.kind !== 'EvidenceRecorder' ||
    verified.event.checkpointSaid !== checkpoint.d ||
    blocked?.event.kind !== 'RunBlocked' ||
    blocked.event.reason !== 'ProcessLost' ||
    blocked.producer.kind !== 'RunSupervisor' ||
    blocked.event.checkpointSaid !== checkpoint.d ||
    !evidenceCheckpointBelongsToRun(checkpoint, run) ||
    checkpoint.runState.kind !== 'Active' ||
    checkpoint.runState.phase.kind !== 'Blocked' ||
    checkpoint.runState.phase.reason !== 'ProcessLost' ||
    checkpoint.runState.verification.kind !== 'NotSubmitted' ||
    checkpoint.continuation.kind !== 'LaterRuntimeRecoveryRequired' ||
    checkpoint.evidence.finalSequence !== 3 ||
    checkpoint.evidence.eventCount !== 4 ||
    checkpoint.evidence.chainHeadSaid !== acceptedEvents[3]?.d ||
    input.predecessorCheckpoint.d !== segment.predecessor.checkpointSaid ||
    !isDeepStrictEqual(checkpoint.repository, input.predecessorCheckpoint.repository) ||
    !isDeepStrictEqual(
      checkpoint.outputArtifactSaids,
      input.predecessorCheckpoint.outputArtifactSaids,
    ) ||
    !isDeepStrictEqual(checkpoint.verifierReceipts, input.predecessorCheckpoint.verifierReceipts) ||
    taskBudgetNames.some(
      (name) =>
        checkpoint.budget.consumed[name] !== prefix.run.consumedBudget[name] ||
        checkpoint.budget.remaining[name] !==
          run.binding.budget[name] - prefix.run.consumedBudget[name],
    )
  )
    return reject;
  return { kind: 'Accepted', phase: 'Checkpoint' };
}
