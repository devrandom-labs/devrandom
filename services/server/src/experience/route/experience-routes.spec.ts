import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { experienceRoutes } from './experience-routes.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

describe('listening experience HTTP boundary', () => {
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
