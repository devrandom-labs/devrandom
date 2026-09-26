import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { prepareEvaluationEvidenceEvent, prepareEvidenceArtifact } from '@devrandom/protocol';

import { evaluationRoutes } from './evaluation-routes.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

describe('owner-scoped accepted Evaluation evidence reads', () => {
  it('serves exact accepted events and raw public bytes through listening HTTP', async () => {
    const evaluationId = randomUUID();
    const streamId = randomUUID();
    const ownerAid = said('o');
    const bytes = new TextEncoder().encode('parent-measured raw receipt');
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const event = prepareEvaluationEvidenceEvent({
      evaluationId,
      streamId,
      originRunId: randomUUID(),
      taskId: randomUUID(),
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      harnessRevisionSaid: said('h'),
      phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
      sequence: 0,
      previous: { kind: 'Genesis' },
      occurredAt: '2026-09-26T10:00:00.000Z',
      detail: { kind: 'ModelExchange', rawArtifactSaid: prepared.artifact.d },
    });
    if (event.kind !== 'Prepared') throw new Error(event.reason);
    const readPage = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId,
          streamId,
          afterSequence: -1,
          throughSequence: 0,
          throughHeadSaid: event.event.d,
          events: [event.event],
        },
      }),
    );
    const readPublicArtifact = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        artifact: prepared.artifact,
        bytes,
      }),
    );
    const server = Fastify();
    server.register(
      evaluationRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve(
              bearerSecret === 'b'.repeat(43)
                ? { kind: 'Authorized' as const, ownerAid }
                : { kind: 'Denied' as const },
            ),
        },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: {
          lock: () => Promise.resolve({ kind: 'Unavailable' }),
          inspect: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        evidence: {
          accept: () => Promise.resolve({ kind: 'Unavailable' }),
          close: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        reading: { readPage, readPublicArtifact },
        now: () => new Date().toISOString(),
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const path = `/api/evaluations/${evaluationId}/evidence?after=-1&through=0&head=${event.event.d}`;
      const response = await fetch(`${address}${path}`, {
        headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        version: 1,
        evaluationId,
        streamId,
        afterSequence: -1,
        throughSequence: 0,
        throughHeadSaid: event.event.d,
        events: [event.event],
      });
      expect(readPage).toHaveBeenCalledWith({
        ownerAid,
        evaluationId,
        afterSequence: -1,
        throughSequence: 0,
        throughHeadSaid: event.event.d,
      });
      const raw = await fetch(
        `${address}/api/evaluations/${evaluationId}/artifacts/${prepared.artifact.d}`,
        { headers: { authorization: `Bearer ${'b'.repeat(43)}` } },
      );
      expect(raw.status).toBe(200);
      expect(await raw.json()).toEqual({
        version: 1,
        evaluationId,
        artifact: prepared.artifact,
        bytesBase64Url: Buffer.from(bytes).toString('base64url'),
      });
      expect(readPublicArtifact).toHaveBeenCalledWith({
        ownerAid,
        evaluationId,
        artifactSaid: prepared.artifact.d,
      });
      const denied = await fetch(`${address}${path}`, {
        headers: { authorization: `Bearer ${'c'.repeat(43)}` },
      });
      expect(denied.status).toBe(403);
      expect(readPage).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
