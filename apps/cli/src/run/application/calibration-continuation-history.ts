import { isDeepStrictEqual } from 'node:util';
import {
  decodeEvidenceEvent,
  decodeRunSuccessorSegment,
  type EvidenceEvent,
  type RunProjection,
} from '@devrandom/protocol';
import type { HostedRunStatuses, HostedRunTimelines } from './task-run-observation.js';

/** Verify the complete original incarnation behind one exact same-H1 continuation. */
export async function readCalibrationContinuationHistory(
  run: RunProjection,
  runs: HostedRunStatuses,
  evidence: HostedRunTimelines,
): Promise<
  | {
      readonly kind: 'Verified';
      readonly evidenceStreamId: string;
      readonly incarnationId?: string;
      readonly predecessorIncarnationId?: string;
      readonly predecessorEvents: readonly EvidenceEvent[];
    }
  | { readonly kind: 'Rejected' }
> {
  if (run.currentExecution === undefined)
    return { kind: 'Verified', evidenceStreamId: run.evidenceStreamId, predecessorEvents: [] };
  if (
    run.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    runs.readSuccessorSegment === undefined ||
    run.lease.kind !== 'Held'
  )
    return { kind: 'Rejected' };
  const read = await runs.readSuccessorSegment(run.runId, run.currentExecution.segmentSaid);
  if (read.kind !== 'Found') return { kind: 'Rejected' };
  const decoded = decodeRunSuccessorSegment(read.segment);
  if (decoded.kind !== 'Accepted') return { kind: 'Rejected' };
  const segment = decoded.segment;
  if (
    segment.version !== 2 ||
    segment.d !== run.currentExecution.segmentSaid ||
    segment.runId !== run.runId ||
    segment.taskId !== run.taskId ||
    segment.taskRevisionSaid !== run.taskRevisionSaid ||
    segment.ownerAid !== run.ownerAid ||
    segment.personalAgentAid !== run.personalAgentAid ||
    segment.taskMandateSaid !== run.taskMandateSaid ||
    segment.baseline.harnessRevisionSaid !== run.harnessRevisionSaid ||
    segment.successor.harnessRevisionSaid !== run.harnessRevisionSaid ||
    segment.successor.evidenceStreamId !== run.currentExecution.evidenceStreamId ||
    segment.successor.incarnationId !== run.lease.incarnationId ||
    segment.predecessor.evidenceStreamId !== run.evidenceStreamId ||
    segment.fromRunVersion >= run.runVersion ||
    Object.entries(segment.consumedBudget).some(([key, value]) => {
      const consumed: unknown = Reflect.get(run.budget.consumed, key);
      return typeof consumed !== 'number' || value > consumed;
    })
  )
    return { kind: 'Rejected' };
  const scope = { limit: 100, evidenceStreamId: segment.predecessor.evidenceStreamId };
  const first = await evidence.inspect(run.runId, scope);
  if (first.kind !== 'Found') return { kind: 'Rejected' };
  const stream = first.page.stream;
  if (
    stream.runId !== run.runId ||
    stream.evidenceStreamId !== segment.predecessor.evidenceStreamId ||
    stream.seal.kind !== 'Sealed' ||
    stream.cursor.kind !== 'Accepted' ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.seal.sealExchangeSaid !== segment.predecessor.sealExchangeSaid ||
    stream.seal.chainHeadSaid !== segment.predecessor.chainHeadSaid ||
    stream.cursor.chainHeadSaid !== segment.predecessor.chainHeadSaid ||
    stream.seal.finalSequence !== segment.predecessor.finalSequence ||
    stream.cursor.acceptedThroughSequence !== segment.predecessor.finalSequence ||
    stream.seal.eventCount !== segment.predecessor.finalSequence + 1 ||
    stream.cursor.eventCount !== segment.predecessor.finalSequence + 1 ||
    stream.checkpoint.checkpointSaid !== segment.predecessor.checkpointSaid
  )
    return { kind: 'Rejected' };
  const events: EvidenceEvent[] = [];
  const cursors = new Set<string>();
  let page = first.page;
  let blocked = false;
  let accepted = false;
  for (let pages = 0; ; pages += 1) {
    if (pages >= 64 || !isDeepStrictEqual(stream, page.stream)) return { kind: 'Rejected' };
    for (const { event } of page.events) {
      const previous = events.at(-1);
      if (
        decodeEvidenceEvent(event).kind !== 'Accepted' ||
        event.sequence !== events.length ||
        event.runId !== run.runId ||
        event.incarnationId !== segment.predecessor.incarnationId ||
        event.taskId !== run.taskId ||
        event.taskRevisionSaid !== run.taskRevisionSaid ||
        event.harnessRevisionSaid !== run.harnessRevisionSaid ||
        event.personalAgentAid !== run.personalAgentAid ||
        event.taskMandateSaid !== run.taskMandateSaid ||
        (previous === undefined
          ? event.predecessor.kind !== 'Genesis' || event.event.kind !== 'RunStarted'
          : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== previous.d) ||
        event.event.kind === 'RunCalibrationRecorded'
      )
        return { kind: 'Rejected' };
      if (event.event.kind === 'RunBlocked') {
        if (
          blocked ||
          event.event.reason !== 'ContextLimitReached' ||
          event.event.checkpointSaid !== segment.predecessor.checkpointSaid
        )
          return { kind: 'Rejected' };
        blocked = true;
      }
      if (
        event.event.kind === 'CheckpointAccepted' &&
        event.event.checkpointSaid === segment.predecessor.checkpointSaid
      ) {
        if (!blocked || accepted || event.producer.kind !== 'EvidenceRecorder')
          return { kind: 'Rejected' };
        accepted = true;
      }
      events.push(event);
    }
    if (page.nextCursor === null) break;
    if (page.events.length === 0 || cursors.has(page.nextCursor)) return { kind: 'Rejected' };
    cursors.add(page.nextCursor);
    const next = await evidence.inspect(run.runId, { ...scope, cursor: page.nextCursor });
    if (next.kind !== 'Found') return { kind: 'Rejected' };
    page = next.page;
  }
  if (
    !blocked ||
    !accepted ||
    events.length !== stream.seal.eventCount ||
    events.at(-1)?.d !== segment.predecessor.chainHeadSaid
  )
    return { kind: 'Rejected' };
  return {
    kind: 'Verified',
    evidenceStreamId: segment.successor.evidenceStreamId,
    incarnationId: segment.successor.incarnationId,
    predecessorIncarnationId: segment.predecessor.incarnationId,
    predecessorEvents: events,
  };
}
