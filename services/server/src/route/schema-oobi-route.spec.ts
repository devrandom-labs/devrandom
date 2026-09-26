import {
  credentialSchema,
  promotionMandateSchema,
  promotionMandateV2Schema,
  taskMandateSchema,
  taskMandateV2Schema,
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
    ['Promotion Mandate', promotionMandateSchema],
    ['Promotion Mandate v2', promotionMandateV2Schema],
  ])('publishes the exact deterministic %s schema bytes', async (_label, schema) => {
    const server = Fastify();
    instances.push(server);
    await server.register(schemaOobiRoute);

    const response = await server.inject({ method: 'GET', url: `/oobi/${schema.$id}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/schema+json');
    expect(response.json()).toEqual(schema);
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
