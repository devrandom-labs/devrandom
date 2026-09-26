import { isDeepStrictEqual } from 'node:util';
import {
  decodeEvidenceEvent,
  decodeRunSuccessorSegment,
  type EvidenceEvent,
  type RunProjection,
  type RunSuccessorSegment,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import type { HostedRunStatuses, HostedRunTimelines } from './task-run-observation.js';

/** Verify the complete original incarnation behind one exact same-H1 continuation. */
async function readCalibrationContinuationLink(
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
      readonly segment?: RunSuccessorSegment;
      readonly stream?: EvidenceStreamProjection;
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
  let processLost = false;
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
          (event.event.reason !== 'ContextLimitReached' && event.event.reason !== 'ProcessLost') ||
          event.event.checkpointSaid !== segment.predecessor.checkpointSaid
        )
          return { kind: 'Rejected' };
        processLost = event.event.reason === 'ProcessLost';
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
    (processLost &&
      events.some(({ event }) =>
        [
          'ModelRequest',
          'ModelMessageCompleted',
          'ToolProposed',
          'ToolAuthorized',
          'EffectCompleted',
          'EffectFailed',
        ].includes(event.kind),
      )) ||
    stream.seal.sealedAt > segment.admittedAt ||
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
    segment,
    stream,
  };
}

/** Walk immutable segment references; every incarnation is verified independently. */
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
      readonly predecessorIncarnationIds: readonly string[];
      readonly predecessorEvents: readonly EvidenceEvent[];
      readonly predecessors: readonly {
        readonly segment: RunSuccessorSegment;
        readonly stream: EvidenceStreamProjection;
        readonly events: readonly EvidenceEvent[];
      }[];
    }
  | { readonly kind: 'Rejected' }
> {
  const predecessors: {
    segment: RunSuccessorSegment;
    stream: EvidenceStreamProjection;
    events: readonly EvidenceEvent[];
  }[] = [];
  const seen = new Set<string>();
  const incarnations = new Set<string>();
  if (run.lease.kind === 'Held') incarnations.add(run.lease.incarnationId);
  let current = run;
  let laterAdmission: string | undefined;
  for (let depth = 0; current.currentExecution !== undefined; depth++) {
    if (depth >= 64 || seen.has(current.currentExecution.segmentSaid)) return { kind: 'Rejected' };
    seen.add(current.currentExecution.segmentSaid);
    const read = await readCalibrationContinuationLink(current, runs, evidence);
    if (
      read.kind !== 'Verified' ||
      read.segment === undefined ||
      read.stream === undefined ||
      current.lease.kind !== 'Held'
    )
      return { kind: 'Rejected' };
    const segment = read.segment;
    if (laterAdmission !== undefined && segment.admittedAt > laterAdmission)
      return { kind: 'Rejected' };
    laterAdmission = segment.admittedAt;
    if (incarnations.has(segment.predecessor.incarnationId)) return { kind: 'Rejected' };
    incarnations.add(segment.predecessor.incarnationId);
    predecessors.unshift({ segment, stream: read.stream, events: read.predecessorEvents });
    const previous = segment.predecessor.segmentSaid;
    if (segment.predecessor.evidenceStreamId === run.evidenceStreamId) {
      if (previous !== undefined) return { kind: 'Rejected' };
      break;
    }
    if (previous === undefined) return { kind: 'Rejected' };
    current = {
      ...current,
      runVersion: segment.fromRunVersion,
      budget: { ...current.budget, consumed: segment.consumedBudget },
      currentExecution: {
        segmentSaid: previous,
        evidenceStreamId: segment.predecessor.evidenceStreamId,
        harnessRevisionSaid: run.harnessRevisionSaid,
      },
      lease: {
        ...current.lease,
        incarnationId: segment.predecessor.incarnationId,
        segmentSaid: previous,
      },
    };
  }
  const first = predecessors[0];
  return {
    kind: 'Verified',
    evidenceStreamId: run.currentExecution?.evidenceStreamId ?? run.evidenceStreamId,
    ...(run.currentExecution === undefined || run.lease.kind !== 'Held'
      ? {}
      : { incarnationId: run.lease.incarnationId }),
    ...(first === undefined
      ? {}
      : { predecessorIncarnationId: first.segment.predecessor.incarnationId }),
    predecessorIncarnationIds: predecessors.map((item) => item.segment.predecessor.incarnationId),
    predecessorEvents: predecessors.flatMap((item) => item.events),
    predecessors,
  };
}
