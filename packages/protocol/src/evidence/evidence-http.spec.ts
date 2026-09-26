import { describe, expect, it } from 'vitest';
import Value from 'typebox/value';

import { prepareEvidenceArtifact } from './evidence-artifact.js';
import { prepareEvidenceBatch } from './evidence-batch.js';
import { prepareEvidenceEvent } from './evidence-event.js';
import {
  appendEvidenceBatchBodySchema,
  decodeAppendEvidenceBatchCommand,
  decodeAppendEvidenceBatchBody,
  decodeEvidenceArtifactUpload,
  decodeEvidenceTimelinePage,
  decodeEvidenceStreamProjection,
  evidenceBatchCommandFingerprint,
  evidenceProblemSchema,
  evidenceSealReconciliationBodySchema,
  evidenceStreamProjectionSchema,
  evidenceTimelineQuerySchema,
} from './evidence-http.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const streamId = 'a30aae94-a652-485f-a2cc-8980134f4acc';
const said = (character: string) => 'E'.concat(character.repeat(43));

function event() {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('a'),
    runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.001Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: 1 },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('fixture event must prepare');
  }
  return prepared.event;
}

describe('evidence HTTP protocol', () => {
  it('recomputes artifact identity from raw bytes and the declared media type', () => {
    const bytes = new TextEncoder().encode('bounded command output\n');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture artifact must prepare');
    }
    const headers = {
      'content-type': prepared.artifact.mediaType,
    };

    expect(
      decodeEvidenceArtifactUpload({ runId, artifactSaid: prepared.artifact.d }, headers, bytes),
    ).toEqual({ kind: 'Accepted', artifact: prepared.artifact, bytes });
    expect(
      decodeEvidenceArtifactUpload({ runId, artifactSaid: said('z') }, headers, bytes),
    ).toEqual({ kind: 'Rejected', reason: 'ArtifactSaidMismatch' });
    expect(
      decodeEvidenceArtifactUpload({ runId, artifactSaid: prepared.artifact.d }, headers, {
        encoded: 'not raw bytes',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'ArtifactBodyInvalid' });
  });

  it('carries the immutable batch, exact events, and only an optional verified checkpoint', () => {
    const first = event();
    const prepared = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: streamId,
      events: [first],
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture batch must prepare');
    }
    const body = { version: 1 as const, batch: prepared.batch, events: [first] };

    expect(Value.Check(appendEvidenceBatchBodySchema, body)).toBe(true);
    expect(decodeAppendEvidenceBatchBody(body, [])).toEqual({ kind: 'Accepted', body });
    expect(
      decodeAppendEvidenceBatchCommand({ runId, batchSaid: prepared.batch.d }, body, []),
    ).toEqual({
      kind: 'Accepted',
      command: { parameters: { runId, batchSaid: prepared.batch.d }, body },
    });
    expect(decodeAppendEvidenceBatchCommand({ runId, batchSaid: said('z') }, body, [])).toEqual({
      kind: 'Rejected',
      reason: 'BatchPathMismatch',
    });
    expect(evidenceBatchCommandFingerprint(body)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evidenceBatchCommandFingerprint(body)).toBe(
      evidenceBatchCommandFingerprint({ events: [first], batch: prepared.batch, version: 1 }),
    );
    expect(
      decodeAppendEvidenceBatchBody({ ...body, events: [], payload: { arbitrary: true } }, []),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('defines seal reconciliation and a coherent evidence-only stream projection', () => {
    expect(
      Value.Check(evidenceSealReconciliationBodySchema, {
        version: 1,
        sealExchangeSaid: said('e'),
      }),
    ).toBe(true);

    const projection = {
      version: 1 as const,
      runId,
      evidenceStreamId: streamId,
      cursor: {
        kind: 'Accepted' as const,
        eventCount: 1,
        acceptedThroughSequence: 0,
        chainHeadSaid: said('f'),
      },
      checkpoint: { kind: 'Accepted' as const, checkpointSaid: said('g') },
      seal: {
        kind: 'Sealed' as const,
        sealExchangeSaid: said('e'),
        eventCount: 1,
        finalSequence: 0,
        chainHeadSaid: said('f'),
        sealedAt: '2026-09-24T20:00:12.000Z',
      },
    };

    expect(Value.Check(evidenceStreamProjectionSchema, projection)).toBe(true);
    expect(decodeEvidenceStreamProjection(projection)).toEqual({
      kind: 'Accepted',
      projection,
    });
    expect(
      decodeEvidenceStreamProjection({
        ...projection,
        cursor: { ...projection.cursor, chainHeadSaid: said('h') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SealCursorMismatch' });

    expect(Value.Check(evidenceTimelineQuerySchema, { limit: 25, cursor: 'opaque.cursor' })).toBe(
      true,
    );
    const acceptedEvent = {
      version: 1 as const,
      event: event(),
      receivedAt: '2026-09-24T20:00:11.000Z',
    };
    expect(
      decodeEvidenceTimelinePage(
        { version: 1, stream: projection, events: [acceptedEvent], nextCursor: null },
        runId,
      ),
    ).toMatchObject({ kind: 'Accepted' });
    expect(
      decodeEvidenceTimelinePage(
        {
          version: 1,
          stream: projection,
          events: [
            {
              ...acceptedEvent,
              event: {
                ...acceptedEvent.event,
                runId: '89c95f28-5fd4-4904-aa42-f7d247006f5c',
              },
            },
          ],
          nextCursor: null,
        },
        runId,
      ),
    ).toEqual({ kind: 'Rejected', reason: 'EventRunMismatch' });
  });

  it('keeps RFC 9457 evidence failures closed and purpose-specific', () => {
    const gap = {
      type: 'https://devrandom.example/problems/evidence-conflict' as const,
      title: 'Evidence delivery conflicts with the accepted stream' as const,
      status: 409 as const,
      code: 'EvidenceConflict' as const,
      correlationId: 'c0873888-7025-4c31-a7b9-ee43644ac3bd',
      reason: 'SequenceGap' as const,
      expectedStartingSequence: 8,
      receivedStartingSequence: 10,
    };

    expect(Value.Check(evidenceProblemSchema, gap)).toBe(true);
    expect(Value.Check(evidenceProblemSchema, { ...gap, metadata: { arbitrary: true } })).toBe(
      false,
    );
  });
});
