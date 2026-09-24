import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { credentialSchema } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildIssuerServer } from './route/issuer-server.js';
import { issuerReadinessFixture } from '../test/issuer-readiness-fixture.js';
import { registrationRoutesFixture } from '../test/registration-routes-fixture.js';
import { verifiedIssuerFixture } from '../test/verified-issuer-fixture.js';

const servers: ReturnType<typeof buildIssuerServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('issuer service', () => {
  it('reports readiness through its public health contract', async () => {
    const server = buildIssuerServer(verifiedIssuerFixture(), registrationRoutesFixture(), {
      verify: () => Promise.resolve(),
    });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const issuer = verifiedIssuerFixture();
    expect(response.json()).toEqual({
      service: 'issuer',
      status: 'ready',
      issuerAid: issuer.profile.issuerAid,
      issuerOobi: issuer.profile.issuerOobi,
      registryId: issuer.profile.registryId,
      schemaId: credentialSchema.$id,
    });
  });

  it('reports unavailability when a live issuer dependency cannot be verified', async () => {
    const server = buildIssuerServer(verifiedIssuerFixture(), registrationRoutesFixture(), {
      verify: () => Promise.reject(new Error('MongoDB unavailable')),
    });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ service: 'issuer', status: 'unavailable' });
  });

  it('publishes the content-addressed Devrandom Credential schema', async () => {
    expect(credentialSchema).toMatchObject({
      title: 'Devrandom Credential',
      credentialType: 'DevrandomCredential',
    });
    const committedSchema: unknown = JSON.parse(
      await readFile(resolve(process.cwd(), 'schemas', 'devrandom-credential.json'), 'utf8'),
    );
    expect(committedSchema).toEqual(credentialSchema);

    const server = buildIssuerServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
    );
    servers.push(server);
    const response = await server.inject({
      method: 'GET',
      url: `/oobi/${credentialSchema.$id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/schema+json');
    expect(response.body).toBe(JSON.stringify(credentialSchema));
    expect(response.json()).toEqual(credentialSchema);
  });

  it('does not publish a schema under an unrecognized SAID', async () => {
    const server = buildIssuerServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/oobi/not-the-schema-said' });

    expect(response.statusCode).toBe(404);
  });

  it('derives an OpenAPI document from route schemas', async () => {
    const server = buildIssuerServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
    );
    servers.push(server);
    await server.ready();

    expect(server.swagger()).toMatchObject({
      info: {
        title: 'Devrandom issuer service',
      },
      paths: {
        '/health': {
          get: {
            operationId: 'getIssuerHealth',
            responses: {
              200: {},
            },
          },
        },
      },
    });
    expect(server.swagger().paths?.['/oobi/{said}']).toBeUndefined();

    const committedDocument: unknown = JSON.parse(
      await readFile(resolve(import.meta.dirname, '..', 'openapi.json'), 'utf8'),
    );
    expect(committedDocument).toEqual(server.swagger());
  });
});
