import { isDeepStrictEqual } from 'node:util';

import type { EvidenceStream, Run } from '@devrandom/domain';
import { decodeEvidenceEvent, type EvidenceEvent } from '../evidence/evidence-event.js';
import {
  decodeVerifiedCheckpoint,
  type VerifiedCheckpoint,
} from '../evidence/verified-checkpoint.js';

/** Replay only the accepted, sealed predecessor incarnation before replacing its lease. */
export function verifyContinuationPredecessor(input: {
  readonly run: Run;
  readonly stream: Pick<EvidenceStream, 'binding' | 'cursor' | 'seal' | 'provisional'>;
  readonly checkpoint: VerifiedCheckpoint;
  readonly events: readonly EvidenceEvent[];
  readonly sealExchangeSaid: string;
  readonly chainHeadSaid: string;
  readonly completionConditionIds: readonly string[];
}): 'Verified' | 'Rejected' {
  const { run, stream, checkpoint, events } = input;
  const predecessorStreamId =
    run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId;
  const predecessorRevision =
    run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid;
  if (
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Blocked' ||
    (run.lifecycle.phase.reason !== 'CheckpointPause' &&
      (run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure' ||
        run.currentExecution !== undefined)) ||
    run.lifecycle.phase.checkpointSaid !== checkpoint.d ||
    run.lease.kind !== 'Held' ||
    stream.binding.streamId !== predecessorStreamId ||
    stream.binding.runId !== run.binding.runId ||
    stream.binding.ownerAid !== run.binding.ownerAid ||
    stream.binding.taskId !== run.binding.taskId ||
    stream.binding.taskRevisionSaid !== run.binding.taskRevisionSaid ||
    stream.binding.incarnationId !== run.lease.incarnationId ||
    stream.binding.harnessRevisionSaid !== predecessorRevision ||
    stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
    stream.binding.taskMandateSaid !== run.binding.taskMandateSaid ||
    stream.cursor.kind !== 'Continued' ||
    stream.seal.kind !== 'Sealed' ||
    stream.seal.exchangeSaid !== input.sealExchangeSaid ||
    stream.cursor.chainHeadSaid !== input.chainHeadSaid ||
    stream.provisional.kind !== 'Checkpointed' ||
    stream.provisional.checkpointSaid !== checkpoint.d ||
    decodeVerifiedCheckpoint(checkpoint, input.completionConditionIds).kind !== 'Accepted' ||
    checkpoint.runId !== run.binding.runId ||
    checkpoint.incarnationId !== run.lease.incarnationId ||
    checkpoint.harnessRevisionSaid !== predecessorRevision ||
    checkpoint.taskId !== run.binding.taskId ||
    checkpoint.taskRevisionSaid !== run.binding.taskRevisionSaid ||
    checkpoint.personalAgentAid !== run.binding.personalAgentAid ||
    checkpoint.taskMandateSaid !== run.binding.taskMandateSaid ||
    checkpoint.runState.kind !== 'Active' ||
    checkpoint.runState.phase.kind !== 'Blocked' ||
    checkpoint.runState.phase.reason !== run.lifecycle.phase.reason ||
    checkpoint.continuation.kind !==
      (run.lifecycle.phase.reason === 'HarnessCompatibilityFailure'
        ? 'LaterHarnessCompatibilityResolutionRequired'
        : 'LaterRuntimeRecoveryRequired') ||
    !isDeepStrictEqual(checkpoint.budget.consumed, run.consumedBudget) ||
    !isDeepStrictEqual(stream.provisional.lifecycle, run.lifecycle) ||
    events.length !== stream.cursor.acceptedThrough + 1 ||
    checkpoint.evidence.eventCount !== checkpoint.evidence.finalSequence + 1 ||
    checkpoint.evidence.finalSequence > stream.cursor.acceptedThrough ||
    events[checkpoint.evidence.finalSequence]?.d !== checkpoint.evidence.chainHeadSaid ||
    events.length === 0
  )
    return 'Rejected';

  const authorized = new Set<string>();
  const modelRequests = new Set<string>();
  let previousSaid: string | undefined;
  let blocked = false;
  for (const [sequence, event] of events.entries()) {
    if (
      decodeEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== sequence ||
      event.runId !== run.binding.runId ||
      event.taskId !== run.binding.taskId ||
      event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      event.incarnationId !== run.lease.incarnationId ||
      event.harnessRevisionSaid !== predecessorRevision ||
      event.personalAgentAid !== run.binding.personalAgentAid ||
      event.taskMandateSaid !== run.binding.taskMandateSaid ||
      (sequence === 0
        ? event.predecessor.kind !== 'Genesis'
        : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== previousSaid)
    )
      return 'Rejected';
    const detail = event.event;
    if (sequence === 0 && detail.kind !== 'RunStarted') return 'Rejected';
    if (detail.kind === 'ToolAuthorized') {
      const key = `${detail.piSessionId}:${detail.modelTurnId}:${detail.toolCallId}:${String(detail.proposalIndex)}`;
      if (authorized.has(key)) return 'Rejected';
      authorized.add(key);
    }
    if (detail.kind === 'EffectCompleted' || detail.kind === 'EffectFailed') {
      const key = `${detail.piSessionId}:${detail.modelTurnId}:${detail.toolCallId}:${String(detail.proposalIndex)}`;
      if (!authorized.delete(key)) return 'Rejected';
    }
    if (detail.kind === 'ModelRequest') {
      const key = `${detail.piSessionId}:${detail.modelTurnId}`;
      if (modelRequests.has(key)) return 'Rejected';
      modelRequests.add(key);
    }
    if (detail.kind === 'ModelMessageCompleted') {
      const key = `${detail.piSessionId}:${detail.modelTurnId}`;
      if (!modelRequests.delete(key)) return 'Rejected';
    }
    if (
      detail.kind === 'RunBlocked' &&
      detail.reason === run.lifecycle.phase.reason &&
      detail.checkpointSaid === checkpoint.d &&
      sequence > checkpoint.evidence.finalSequence
    )
      blocked = true;
    if (
      sequence === checkpoint.evidence.finalSequence &&
      (authorized.size !== 0 || modelRequests.size !== 0)
    )
      return 'Rejected';
    previousSaid = event.d;
  }
  return previousSaid === stream.cursor.chainHeadSaid &&
    blocked &&
    authorized.size === 0 &&
    modelRequests.size === 0
    ? 'Verified'
    : 'Rejected';
}
