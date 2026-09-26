import {
  decodeEvidenceTimelinePage,
  type EvidenceTimelinePage,
  type EvidenceTimelineQuery,
} from '@devrandom/protocol';

import type { EvidenceTimelineCursor } from './evidence-timeline-cursor.js';
import { projectEvidenceStream } from './evidence-stream-projection.js';
import type { EvidenceTimelines } from './evidence-timelines.js';

export interface InspectEvidenceTimelineInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly query: EvidenceTimelineQuery;
}

export interface InspectEvidenceTimelineDependencies {
  readonly cursor: EvidenceTimelineCursor;
  readonly timelines: EvidenceTimelines;
}

export type InspectEvidenceTimelineOutcome =
  | { readonly kind: 'EvidenceTimelineFound'; readonly page: EvidenceTimelinePage }
  | { readonly kind: 'EvidenceTimelineCursorRejected' }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export async function inspectEvidenceTimeline(
  input: InspectEvidenceTimelineInput,
  dependencies: InspectEvidenceTimelineDependencies,
): Promise<InspectEvidenceTimelineOutcome> {
  const limit = input.query.limit ?? 25;
  let afterSequence: number | null = null;
  if (input.query.cursor !== undefined) {
    const decoded = dependencies.cursor.decode({
      ownerAid: input.ownerAid,
      runId: input.runId,
      limit,
      cursor: input.query.cursor,
    });
    if (decoded.kind === 'CursorRejected') {
      return { kind: 'EvidenceTimelineCursorRejected' };
    }
    afterSequence = decoded.afterSequence;
  }
  const reading = await dependencies.timelines.read({
    ownerAid: input.ownerAid,
    runId: input.runId,
    limit,
    afterSequence,
  });
  if (reading.kind === 'EvidenceTimelineNotStarted') {
    return {
      kind: 'EvidenceTimelineFound',
      page: {
        version: 1,
        stream: {
          version: 1,
          runId: reading.runId,
          evidenceStreamId: reading.evidenceStreamId,
          cursor: { kind: 'Empty' },
          checkpoint: { kind: 'Absent' },
          seal: { kind: 'Unsealed' },
        },
        events: [],
        nextCursor: null,
      },
    };
  }
  if (reading.kind !== 'EvidenceTimelineRead') {
    return reading;
  }
  const finalEvent = reading.events.at(-1);
  if (reading.hasMore && finalEvent === undefined) {
    return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
  }
  const continuationSequence = finalEvent?.event.sequence ?? afterSequence;
  const pollable = reading.hasMore || reading.stream.seal.kind === 'Open';
  const nextCursor =
    pollable && continuationSequence !== null
      ? dependencies.cursor.encode({
          ownerAid: input.ownerAid,
          runId: input.runId,
          limit,
          afterSequence: continuationSequence,
        })
      : null;
  const candidate: EvidenceTimelinePage = {
    version: 1,
    stream: projectEvidenceStream(reading.stream),
    events: [...reading.events],
    nextCursor,
  };
  const decoded = decodeEvidenceTimelinePage(candidate, input.runId);
  return decoded.kind === 'Accepted'
    ? { kind: 'EvidenceTimelineFound', page: decoded.page }
    : { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
}
