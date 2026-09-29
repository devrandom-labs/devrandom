import {
  credentialSchema,
  promotionMandateSchema,
  promotionMandateV2Schema,
  promotionMandateV3Schema,
  taskMandateSchema,
  taskMandateV2Schema,
  taskMandateV3Schema,
  taskMandateV4Schema,
  promotionMandateV4Schema,
  promotionMandateV6Schema,
  promotionMandateV5Schema,
  promotionMandateV7Schema,
  promotionMandateV8Schema,
  promotionMandateV9Schema,
  promotionMandateV10Schema,
  promotionMandateV11Schema,
  taskMandateV5Schema,
  taskMandateV6Schema,
} from '@devrandom/protocol';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaOobiRoute } from './schema-oobi-route.js';

const instances: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

describe('credential schema OOBI route', () => {
  it.each([
    ['user credential', credentialSchema],
    ['Task Mandate', taskMandateSchema],
    ['Task Mandate v2', taskMandateV2Schema],
    ['Task Mandate v3', taskMandateV3Schema],
    ['Task Mandate v4', taskMandateV4Schema],
    ['Task Mandate v5', taskMandateV5Schema],
    ['Task Mandate v6', taskMandateV6Schema],
    ['Promotion Mandate v6', promotionMandateV6Schema],
    ['Promotion Mandate v7', promotionMandateV7Schema],
    ['Promotion Mandate v8', promotionMandateV8Schema],
    ['Promotion Mandate v9', promotionMandateV9Schema],
    ['Promotion Mandate v10', promotionMandateV10Schema],
    ['Promotion Mandate v11', promotionMandateV11Schema],
    ['Promotion Mandate v4', promotionMandateV4Schema],
    ['Promotion Mandate v5', promotionMandateV5Schema],
    ['Promotion Mandate', promotionMandateSchema],
    ['Promotion Mandate v2', promotionMandateV2Schema],
    ['Promotion Mandate v3', promotionMandateV3Schema],
  ])('publishes the exact deterministic %s schema bytes', async (_label, schema) => {
    const server = Fastify();
    instances.push(server);
    await server.register(schemaOobiRoute);

    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/oobi/${schema.$id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/schema+json');
    expect(await response.json()).toEqual(schema);
  });

  it('does not publish a substituted digest-shaped identifier', async () => {
    const server = Fastify();
    instances.push(server);
    await server.register(schemaOobiRoute);

    const response = await server.inject({ method: 'GET', url: `/oobi/E${'x'.repeat(43)}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toBeNull();
  });
});
