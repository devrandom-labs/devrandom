import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { prepareEvidenceArtifact } from '@devrandom/protocol';

import { experienceRoutes } from './experience-routes.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

describe('listening experience HTTP boundary', () => {
  it('serves exact ranged query-receipt bytes under current Work Access and rejects owner overrides', async () => {
    const bytes = Buffer.from('{"query":"legacy parser","sources":["E1"]}', 'utf8');
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('fixture receipt invalid');
    const taskId = randomUUID();
    const sourceInventorySaid = said('i');
    const ownerAid = said('o');
    const reads: string[] = [];
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    server.register(
      experienceRoutes({
        access: {
          authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid }),
        },
        conversation: {
          retrieve: () => Promise.resolve({ kind: 'Irrelevant' }),
          readReceipt: (input) => {
            reads.push(input.ownerAid);
            return Promise.resolve({
              kind: 'Read',
              artifact: prepared.artifact,
              bytes: bytes.subarray(input.offset, input.offset + input.maximumBytes),
              totalBytes: bytes.byteLength,
              offset: input.offset,
            });
          },
        },
        now: () => '2026-09-26T04:00:00.000Z',
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const url = `${address}/api/experience/query-receipts/${prepared.artifact.d}?taskId=${taskId}&sourceInventorySaid=${sourceInventorySaid}&offset=2&maximumBytes=5`;
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        version: 1,
        kind: 'Read',
        artifact: prepared.artifact,
        totalBytes: bytes.byteLength,
        offset: 2,
        bytesBase64Url: bytes.subarray(2, 7).toString('base64url'),
      });
      expect(reads).toEqual([ownerAid]);
      const override = await fetch(`${url}&ownerAid=${said('x')}`, {
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(override.status).toBe(400);
      expect(reads).toEqual([ownerAid]);
    } finally {
      await server.close();
    }
  });

  it('derives owner from the grant and rejects caller vectors and owner overrides', async () => {
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    let ownerUsed: string | undefined;
    server.register(
      experienceRoutes({
        access: {
          authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid: said('o') }),
        },
        conversation: {
          retrieve: ({ ownerAid }) => {
            ownerUsed = ownerAid;
            return Promise.resolve({ kind: 'Irrelevant' });
          },
          readReceipt: () => Promise.resolve({ kind: 'Denied' }),
        },
        now: () => '2026-09-26T04:00:00.000Z',
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const query = {
      version: 1,
      taskId: randomUUID(),
      sourceInventorySaid: said('i'),
      corpusSaid: said('c'),
      failureQuery: 'parser rejects a legacy receipt',
      maximumResults: 3,
    };
    try {
      const headers = {
        authorization: `Bearer ${'a'.repeat(43)}`,
        'content-type': 'application/json',
      };
      const accepted = await fetch(`${address}/api/experience/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify(query),
      });
      expect(accepted.status).toBe(422);
      expect(ownerUsed).toBe(said('o'));
      ownerUsed = undefined;
      const denied = await fetch(`${address}/api/experience/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...query, ownerAid: said('x'), vector: [1, 0, 0] }),
      });
      expect(denied.status).toBe(400);
      expect(ownerUsed).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
