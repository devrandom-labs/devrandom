import { describe, expect, it } from 'vitest';

import { prepareEvidenceEvent, type EvidenceEvent } from './evidence-event.js';
import {
  decodeEvidenceBatch,
  decodeEvidenceBatchAcknowledgement,
  prepareEvidenceBatch,
} from './evidence-batch.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const streamId = 'a30aae94-a652-485f-a2cc-8980134f4acc';
const binding = {
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: 'E'.concat('a'.repeat(43)),
  runId,
  incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
  harnessRevisionSaid: 'E'.concat('b'.repeat(43)),
  personalAgentAid: 'E'.concat('c'.repeat(43)),
  taskMandateSaid: 'E'.concat('d'.repeat(43)),
};

function event(sequence: number, previous: EvidenceEvent | undefined): EvidenceEvent {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor:
      previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
    ...binding,
    occurredAt: `2026-09-24T20:00:0${String(sequence)}.000Z`,
    recordedAt: `2026-09-24T20:00:0${String(sequence)}.001Z`,
    producer: { kind: 'EvidenceRecorder' },
    event:
      sequence === 0 ? { kind: 'RunStarted', fromRunVersion: 1 } : { kind: 'IncarnationStarted' },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('fixture event must prepare');
  }
  return prepared.event;
}

describe('evidence batch protocol', () => {
  it('derives one immutable ordered batch and verifies its complete event chain', () => {
    const first = event(0, undefined);
    const second = event(1, first);
    const prepared = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: streamId,
      events: [first, second],
    });

    expect(prepared).toMatchObject({
      kind: 'Prepared',
      batch: {
        version: 1,
        runId,
        evidenceStreamId: streamId,
        startingSequence: 0,
        endingSequence: 1,
        predecessor: { kind: 'Genesis' },
        eventSaids: [first.d, second.d],
        eventCount: 2,
      },
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture batch must prepare');
    }
    expect(prepared.batch.d).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(decodeEvidenceBatch(prepared.batch, [first, second])).toEqual({
      kind: 'Accepted',
      batch: prepared.batch,
      events: [first, second],
    });
  });

  it('rejects an event-order substitution without advancing a cursor', () => {
    const first = event(0, undefined);
    const second = event(1, first);
    const prepared = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: streamId,
      events: [first, second],
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture batch must prepare');
    }

    expect(decodeEvidenceBatch(prepared.batch, [second, first])).toEqual({
      kind: 'Rejected',
      reason: 'EventIdentityMismatch',
    });
  });

  it('accepts only an acknowledgement bound to the exact batch cursor and head', () => {
    const first = event(0, undefined);
    const second = event(1, first);
    const prepared = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: streamId,
      events: [first, second],
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture batch must prepare');
    }
    const acknowledgement = {
      version: 1 as const,
      disposition: { kind: 'Accepted' as const },
      runId,
      evidenceStreamId: streamId,
      batchSaid: prepared.batch.d,
      acceptedThroughSequence: 1,
      chainHeadSaid: second.d,
      receivedAt: '2026-09-24T20:00:05.000Z',
    };

    expect(decodeEvidenceBatchAcknowledgement(acknowledgement, prepared.batch)).toEqual({
      kind: 'Accepted',
      acknowledgement,
    });
    expect(
      decodeEvidenceBatchAcknowledgement(
        { ...acknowledgement, acceptedThroughSequence: 0 },
        prepared.batch,
      ),
    ).toEqual({ kind: 'Rejected', reason: 'CursorMismatch' });
  });
});
