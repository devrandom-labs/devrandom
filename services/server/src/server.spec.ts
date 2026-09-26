import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { credentialSchema, projectRun } from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDevrandomServer } from './server.js';
import {
  manifestWorkAccessPolicy,
  workAccessPolicy,
  workAccessPolicyForGrantLifetime,
} from './access/domain/work-access-policy.js';
import { issuerReadinessFixture } from '../test/issuer-readiness-fixture.js';
import { baselineHarnessCommandFixture } from './harness/test/harness-command-fixture.js';
import { registrationRoutesFixture } from '../test/registration-routes-fixture.js';
import { verifiedIssuerFixture } from '../test/verified-issuer-fixture.js';
import { runFixture } from './run/test/run-fixture.js';

const servers: ReturnType<typeof buildDevrandomServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('Devrandom Server identity boundary', () => {
  it('exposes terminal calibration reconciliation through the listening server', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(
      `${address}/api/runs/11111111-1111-4111-8111-111111111111/evidence-terminal-reconciliation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' },
        body: '{}',
      },
    );
    expect(response.status).toBe(400);
  });

  it('reports process liveness without consulting capability dependencies', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.reject(new Error('identity unavailable')) },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'devrandom-server', status: 'live' });
  });

  it('reports readiness through its public health contract', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health' });
    const capabilityResponse = await server.inject({ method: 'GET', url: '/ready/identity' });

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
    expect(capabilityResponse.statusCode).toBe(200);
    expect(capabilityResponse.json()).toEqual(response.json());
  });

  it('reports unavailability when a live issuer dependency cannot be verified', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.reject(new Error('MongoDB unavailable')) },
      { verify: () => Promise.resolve() },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ service: 'issuer', status: 'unavailable' });
  });

  it('keeps identity ready when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('Atlas unavailable')) },
    );
    servers.push(server);

    const identityResponse = await server.inject({ method: 'GET', url: '/ready/identity' });
    const workResponse = await server.inject({ method: 'GET', url: '/ready/work' });

    expect(identityResponse.statusCode).toBe(200);
    expect(workResponse.statusCode).toBe(503);
    expect(workResponse.json()).toEqual({ service: 'hosted-work', status: 'unavailable' });
  });

  it('retains the Work Access resource when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/work-access-attempts',
      payload: {
        version: 1,
        commandId: '33333333-3333-4333-8333-333333333333',
        clientInstanceId: '22222222-2222-4222-8222-222222222222',
        userAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
        credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
        grantSecretHash: `sha256:${'a'.repeat(64)}`,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 503,
      code: 'WorkAccessUnavailable',
    });
  });

  it('retains the Task resource when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 503,
      code: 'TaskUnavailable',
      dependency: 'HostedMongoDB',
    });
  });

  it('retains the Harness Revision resource when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);
    const command = baselineHarnessCommandFixture();

    const response = await server.inject({
      method: 'PUT',
      url: `/api/harness-revisions/${command.revision.d}`,
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
      payload: command,
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 503,
      code: 'HarnessUnavailable',
      dependency: 'HostedMongoDB',
    });
  });

  it('retains the Run admission resource when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
      payload: {
        version: 1,
        commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
        admissionExchangeSaid: `E${'z'.repeat(43)}`,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 503,
      code: 'RunUnavailable',
      dependency: 'HostedMongoDB',
    });
  });

  it('retains the Evidence timeline resource when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/runs/1cc482f1-98e9-4454-8e4c-5566cb47ce3d/timeline',
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 503,
      code: 'EvidenceUnavailable',
      dependency: 'HostedMongoDB',
    });
  });

  it('keeps the scoped Experience query public and fails closed when hosted work is unavailable', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('hosted work unavailable')) },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/experience/query',
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
      payload: {
        version: 1,
        taskId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
        sourceInventorySaid: `E${'i'.repeat(43)}`,
        corpusSaid: `E${'c'.repeat(43)}`,
        failureQuery: 'receipt grammar mismatch',
        maximumResults: 3,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 503 });
  });

  it('serves Task, Run, and Evidence queries through the composed hosted-work boundary', async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        kind: 'TasksListed' as const,
        page: { version: 1 as const, tasks: [], nextCursor: null },
      }),
    );
    const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
    const inspectRun = vi.fn(() =>
      Promise.resolve({ kind: 'RunFound' as const, projection: projectRun(runFixture()) }),
    );
    const inspectTimeline = vi.fn(() =>
      Promise.resolve({
        kind: 'EvidenceTimelineFound' as const,
        page: {
          version: 1 as const,
          stream: {
            version: 1 as const,
            runId,
            evidenceStreamId: 'a30aae94-a652-485f-a2cc-8980134f4acc',
            cursor: { kind: 'Empty' as const },
            checkpoint: { kind: 'Absent' as const },
            seal: { kind: 'Unsealed' as const },
          },
          events: [],
          nextCursor: null,
        },
      }),
    );
    const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.resolve() },
      {
        kind: 'Available',
        access: {
          conversation: {
            create: () => Promise.resolve(unavailable),
            submitProof: () => Promise.resolve(unavailable),
            observe: () => Promise.resolve(unavailable),
            release: () => Promise.resolve(unavailable),
          },
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
        tasks: {
          access: {
            authorize: () =>
              Promise.resolve({
                kind: 'TaskAccessAuthorized',
                owner: {
                  ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
                  credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
                },
              }),
          },
          conversation: {
            create: () => Promise.resolve(unavailable),
            list,
            inspect: () => Promise.resolve({ kind: 'TaskNotFound' }),
          },
          now: () => '2026-09-24T12:00:00.000Z',
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
        mandates: {
          access: {
            authorize: () =>
              Promise.resolve({
                kind: 'MandateAccessUnavailable',
                dependency: 'HostedMongoDB',
              }),
          },
          conversation: {
            present: () => Promise.resolve(unavailable),
          },
          now: () => '2026-09-24T12:00:00.000Z',
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
        harness: {
          access: {
            authorize: () =>
              Promise.resolve({
                kind: 'HarnessAccessUnavailable',
                dependency: 'HostedMongoDB',
              }),
          },
          conversation: { admit: () => Promise.resolve(unavailable) },
          now: () => '2026-09-24T12:00:00.000Z',
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
        runs: {
          access: {
            authorize: () =>
              Promise.resolve({
                kind: 'RunAccessAuthorized',
                owner: {
                  ownerAid: runFixture().binding.ownerAid,
                  credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
                },
              }),
          },
          conversation: {
            admit: () => Promise.resolve(unavailable),
            inspect: inspectRun,
            acquireLease: () => Promise.resolve(unavailable),
            renewLease: () => Promise.resolve(unavailable),
          },
          now: () => '2026-09-24T12:00:00.000Z',
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
        evidence: {
          access: {
            authorize: () =>
              Promise.resolve({
                kind: 'EvidenceAccessAuthorized',
                ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
              }),
          },
          conversation: {
            admitArtifact: () => Promise.resolve(unavailable),
            readArtifact: () => Promise.resolve({ kind: 'Unavailable' }),
            acceptBatch: () => Promise.resolve(unavailable),
            reconcileSeal: () => Promise.resolve(unavailable),
            inspectTimeline,
          },
          now: () => '2026-09-24T12:00:00.000Z',
          newCorrelationId: () => '11111111-1111-4111-8111-111111111111',
        },
      },
    );
    servers.push(server);

    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/tasks?limit=25`, {
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: 1, tasks: [], nextCursor: null });
    expect(list).toHaveBeenCalledWith({
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      query: { limit: 25 },
    });

    const runResponse = await fetch(`${address}/api/runs/${runId}`, {
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
    });
    expect(runResponse.status).toBe(200);
    await expect(runResponse.json()).resolves.toEqual(projectRun(runFixture()));
    expect(inspectRun).toHaveBeenCalledWith({
      ownerAid: runFixture().binding.ownerAid,
      runId,
    });

    const timelineResponse = await fetch(`${address}/api/runs/${runId}/timeline?limit=25`, {
      headers: { authorization: `Bearer ${'s'.repeat(43)}` },
    });
    expect(timelineResponse.status).toBe(200);
    await expect(timelineResponse.json()).resolves.toMatchObject({
      version: 1,
      stream: { runId, cursor: { kind: 'Empty' } },
      events: [],
      nextCursor: null,
    });
    expect(inspectTimeline).toHaveBeenCalledWith({
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      runId,
      query: { limit: 25 },
    });
  });

  it('reports hosted-work readiness through its own capability contract', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.resolve() },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/ready/work' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'hosted-work',
      status: 'ready',
      workAccessPolicy: manifestWorkAccessPolicy(workAccessPolicy),
    });
  });

  it('publishes the effective lowered Work Access Grant lifetime without configuration secrets', async () => {
    const policyManifest = manifestWorkAccessPolicy(workAccessPolicyForGrantLifetime(45));
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      { verify: () => Promise.resolve() },
      { verify: () => Promise.resolve() },
      { kind: 'Unavailable' },
      policyManifest,
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/ready/work' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'hosted-work',
      status: 'ready',
      workAccessPolicy: policyManifest,
    });
    expect(response.body).not.toContain('MONGODB');
    expect(response.body).not.toContain('Bearer');
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

    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
      { verify: () => Promise.resolve() },
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
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
      { verify: () => Promise.resolve() },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/oobi/not-the-schema-said' });

    expect(response.statusCode).toBe(404);
  });

  it('derives an OpenAPI document from route schemas', async () => {
    const server = buildDevrandomServer(
      verifiedIssuerFixture(),
      registrationRoutesFixture(),
      issuerReadinessFixture(),
      { verify: () => Promise.resolve() },
    );
    servers.push(server);
    await server.ready();

    expect(server.swagger()).toMatchObject({
      info: {
        title: 'Devrandom Server',
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
        '/health/live': {
          get: {
            operationId: 'getServerLiveness',
            responses: {
              200: {},
            },
          },
        },
        '/ready/identity': {
          get: {
            operationId: 'getIdentityReadiness',
            responses: {
              200: {},
            },
          },
        },
        '/ready/work': {
          get: {
            operationId: 'getWorkReadiness',
            responses: {
              200: {},
            },
          },
        },
        '/api/tasks': {
          get: {
            operationId: 'listTasks',
          },
          post: {
            operationId: 'createTask',
          },
        },
        '/api/tasks/by-label/{label}': {
          get: {
            operationId: 'inspectTaskByLabel',
          },
        },
        '/api/mandate-presentations/{credentialSaid}': {
          put: {
            operationId: 'presentMandate',
          },
        },
        '/api/harness-revisions/{harnessSaid}': {
          put: {
            operationId: 'admitBaselineHarness',
          },
        },
        '/api/runs': {
          post: {
            operationId: 'admitRun',
          },
        },
        '/api/runs/{runId}': {
          get: {
            operationId: 'inspectRun',
          },
        },
        '/api/runs/{runId}/incarnations/{incarnationId}': {
          put: {
            operationId: 'acquireRunLease',
          },
        },
        '/api/runs/{runId}/artifacts/{artifactSaid}': {
          put: {
            operationId: 'admitEvidenceArtifact',
            requestBody: {
              content: {
                'application/octet-stream': {},
                'application/json': {},
                'text/plain; charset=utf-8': {},
                'text/x-diff; charset=utf-8': {},
              },
            },
          },
        },
        '/api/runs/{runId}/evidence-batches/{batchSaid}': {
          put: {
            operationId: 'acceptEvidenceBatch',
          },
        },
        '/api/runs/{runId}/evidence-seal': {
          put: {
            operationId: 'reconcileEvidenceSeal',
          },
        },
        '/api/runs/{runId}/timeline': {
          get: {
            operationId: 'inspectEvidenceTimeline',
          },
        },
      },
    });
    expect(server.swagger().paths?.['/oobi/{said}']).toBeUndefined();

    expect(server.swagger().paths?.['/api/work-access-attempts/{attemptId}/grant']).toMatchObject({
      delete: {
        operationId: 'releaseWorkAccessGrant',
        responses: {
          204: {},
          401: { content: { 'application/problem+json': {} } },
          409: { content: { 'application/problem+json': {} } },
        },
      },
    });
    expect(server.swagger().paths).toMatchObject({
      '/api/tasks': {
        post: {
          responses: {
            201: { content: { 'application/json': {} } },
            401: { content: { 'application/problem+json': {} } },
          },
        },
      },
      '/api/runs': {
        post: { responses: { 409: { content: { 'application/problem+json': {} } } } },
      },
      '/api/runs/{runId}/evidence-batches/{batchSaid}': {
        put: { responses: { 401: { content: { 'application/problem+json': {} } } } },
      },
    });
    const committedDocument: unknown = JSON.parse(
      await readFile(resolve(import.meta.dirname, '..', 'openapi.json'), 'utf8'),
    );
    expect(committedDocument).toEqual(server.swagger());
  });
});
