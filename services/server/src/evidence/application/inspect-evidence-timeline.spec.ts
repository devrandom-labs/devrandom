import { acceptEvidenceBatch, createEvidenceStream, sealEvidenceStream } from '@devrandom/domain';
import { prepareEvidenceEvent, type EvidenceEventDraft } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { inspectEvidenceTimeline } from './inspect-evidence-timeline.js';

const ownerAid = `E${'a'.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const streamId = 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94';

function timeline(disposition: 'Open' | 'Sealed' = 'Open') {
  const draft: EvidenceEventDraft = {
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: `E${'d'.repeat(43)}`,
    runId,
    incarnationId: 'b5c5f13e-63df-4a4f-b1fc-08df00150f15',
    harnessRevisionSaid: `E${'b'.repeat(43)}`,
    personalAgentAid: `E${'e'.repeat(43)}`,
    taskMandateSaid: `E${'f'.repeat(43)}`,
    occurredAt: '2026-09-24T20:00:01.000Z',
    recordedAt: '2026-09-24T20:00:01.000Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'IncarnationStarted' },
  };
  const prepared = prepareEvidenceEvent(draft);
  const created = createEvidenceStream({
    streamId,
    runId,
    ownerAid,
    taskId: draft.taskId,
    taskRevisionSaid: draft.taskRevisionSaid,
    incarnationId: draft.incarnationId,
    harnessRevisionSaid: draft.harnessRevisionSaid,
    personalAgentAid: draft.personalAgentAid,
    taskMandateSaid: draft.taskMandateSaid,
    combinedByteCeiling: 1_024,
  });
  if (prepared.kind !== 'Prepared' || created.kind !== 'Created') {
    throw new Error('expected a valid timeline fixture');
  }
  const accepted = acceptEvidenceBatch(created.stream, {
    batchSaid: `E${'q'.repeat(43)}`,
    startingSequence: 0,
    endingSequence: 0,
    predecessor: { kind: 'Genesis' },
    eventSaids: [prepared.event.d],
    encodedBytes: 128,
    checkpoint:
      disposition === 'Open'
        ? { kind: 'Absent' }
        : {
            kind: 'Present',
            checkpointSaid: `E${'c'.repeat(43)}`,
            lifecycle: {
              kind: 'Active',
              phase: {
                kind: 'Blocked',
                reason: 'HarnessCompatibilityFailure',
                checkpointSaid: `E${'c'.repeat(43)}`,
              },
            },
            submissionVerification: { kind: 'NotSubmitted' },
          },
  });
  if (accepted.kind !== 'Accepted') {
    throw new Error('expected an accepted stream fixture');
  }
  const sealed =
    disposition === 'Open'
      ? undefined
      : sealEvidenceStream(accepted.stream, {
          exchangeSaid: `E${'s'.repeat(43)}`,
          eventCount: 1,
          finalSequence: 0,
          chainHeadSaid: prepared.event.d,
          sealedAt: '2026-09-24T20:00:03.000Z',
        });
  if (sealed !== undefined && sealed.kind !== 'Sealed') {
    throw new Error('expected a sealed stream fixture');
  }
  return {
    stream: sealed?.stream ?? accepted.stream,
    event: { version: 1 as const, event: prepared.event, receivedAt: '2026-09-24T20:00:02.000Z' },
  };
}

describe('inspect evidence timeline', () => {
  it('returns one owner-scoped page and binds the continuation cursor to the query', async () => {
    const fixture = timeline();
    const encode = vi.fn().mockReturnValue('opaque-next');
    const read = vi.fn().mockResolvedValue({
      kind: 'EvidenceTimelineRead',
      stream: fixture.stream,
      events: [fixture.event],
      hasMore: true,
    });

    const outcome = await inspectEvidenceTimeline(
      { ownerAid, runId, query: { limit: 10 } },
      { cursor: { encode, decode: vi.fn() }, timelines: { read } },
    );

    expect(outcome).toEqual({
      kind: 'EvidenceTimelineFound',
      page: {
        version: 1,
        stream: {
          version: 1,
          runId,
          evidenceStreamId: streamId,
          cursor: {
            kind: 'Accepted',
            eventCount: 1,
            acceptedThroughSequence: 0,
            chainHeadSaid: fixture.event.event.d,
          },
          checkpoint: { kind: 'Absent' },
          seal: { kind: 'Unsealed' },
        },
        events: [fixture.event],
        nextCursor: 'opaque-next',
      },
    });
    expect(read).toHaveBeenCalledWith({ ownerAid, runId, limit: 10, afterSequence: null });
    expect(encode).toHaveBeenCalledWith({ ownerAid, runId, limit: 10, afterSequence: 0 });
  });

  it('rejects an invalid or differently bound cursor before reading MongoDB', async () => {
    const read = vi.fn();
    const outcome = await inspectEvidenceTimeline(
      { ownerAid, runId, query: { cursor: 'not-for-this-owner' } },
      {
        cursor: {
          encode: vi.fn(),
          decode: vi.fn().mockReturnValue({ kind: 'CursorRejected' }),
        },
        timelines: { read },
      },
    );

    expect(outcome).toEqual({ kind: 'EvidenceTimelineCursorRejected' });
    expect(read).not.toHaveBeenCalled();
  });

  it('retains an opaque tail cursor while an open stream is caught up', async () => {
    const fixture = timeline();
    const encode = vi.fn().mockReturnValue('opaque-tail');
    const decode = vi.fn().mockReturnValue({ kind: 'CursorAccepted', afterSequence: 0 });
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'EvidenceTimelineRead',
        stream: fixture.stream,
        events: [fixture.event],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        kind: 'EvidenceTimelineRead',
        stream: fixture.stream,
        events: [],
        hasMore: false,
      });
    const dependencies = { cursor: { encode, decode }, timelines: { read } };

    const caughtUp = await inspectEvidenceTimeline(
      { ownerAid, runId, query: { limit: 10 } },
      dependencies,
    );
    const unchanged = await inspectEvidenceTimeline(
      { ownerAid, runId, query: { limit: 10, cursor: 'opaque-tail' } },
      dependencies,
    );

    expect(caughtUp).toMatchObject({
      kind: 'EvidenceTimelineFound',
      page: { events: [fixture.event], nextCursor: 'opaque-tail' },
    });
    expect(unchanged).toMatchObject({
      kind: 'EvidenceTimelineFound',
      page: { events: [], nextCursor: 'opaque-tail' },
    });
    expect(encode).toHaveBeenNthCalledWith(1, {
      ownerAid,
      runId,
      limit: 10,
      afterSequence: 0,
    });
    expect(encode).toHaveBeenNthCalledWith(2, {
      ownerAid,
      runId,
      limit: 10,
      afterSequence: 0,
    });
  });

  it('ends continuation only after a sealed stream is caught up', async () => {
    const fixture = timeline('Sealed');
    const encode = vi.fn();

    const outcome = await inspectEvidenceTimeline(
      { ownerAid, runId, query: { limit: 10 } },
      {
        cursor: { encode, decode: vi.fn() },
        timelines: {
          read: vi.fn().mockResolvedValue({
            kind: 'EvidenceTimelineRead',
            stream: fixture.stream,
            events: [fixture.event],
            hasMore: false,
          }),
        },
      },
    );

    expect(outcome).toMatchObject({
      kind: 'EvidenceTimelineFound',
      page: { events: [fixture.event], nextCursor: null },
    });
    expect(encode).not.toHaveBeenCalled();
  });
});
