import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { projectRun, runContinuationRequestSchema } from '@devrandom/protocol';
import Value from 'typebox/value';

import { runFixture } from '../test/run-fixture.js';
import { runRoutes, type RunRoutesConfiguration } from './run-routes.js';

const bearerSecret = 's'.repeat(43);
const owner = {
  ownerAid: runFixture().binding.ownerAid,
  credentialSaid: `E${'w'.repeat(43)}`,
};
const admissionCommand = {
  version: 1 as const,
  commandId: runFixture().binding.commandId,
  admissionExchangeSaid: runFixture().binding.admissionExchangeSaid,
};
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';

function configuration(overrides: Partial<RunRoutesConfiguration> = {}): RunRoutesConfiguration {
  const run = runFixture();
  return {
    access: {
      authorize: () => Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
    },
    conversation: {
      admit: () => Promise.resolve({ kind: 'RunCreated', projection: projectRun(run) }),
      inspect: () => Promise.resolve({ kind: 'RunFound', projection: projectRun(run) }),
      acquireLease: () =>
        Promise.resolve({
          kind: 'RunLeaseAcquired',
          projection: {
            version: 1,
            disposition: 'Acquired',
            runId: run.binding.runId,
            incarnationId,
            runVersion: 1,
            serverTime: '2026-09-24T20:00:00.000Z',
            expiresAt: '2026-09-24T20:00:45.000Z',
          },
        }),
      renewLease: () =>
        Promise.resolve({
          kind: 'RunLeaseRenewed',
          receipt: {
            version: 1,
            runId: run.binding.runId,
            incarnationId,
            runVersion: 2,
            serverTime: '2026-09-24T20:00:15.000Z',
            expiresAt: '2026-09-24T20:01:00.000Z',
          },
        }),
    },
    now: () => '2026-09-24T20:00:00.000Z',
    newCorrelationId: randomUUID,
    ...overrides,
  };
}

async function server(configurationInput: RunRoutesConfiguration) {
  const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await instance.register(runRoutes(configurationInput));
  return instance;
}

describe('Run HTTP routes', () => {
  it('rejects replacement-incarnation admission without an acknowledged sealed checkpoint', async () => {
    const run = runFixture();
    const admit = vi.fn(() =>
      Promise.resolve({ kind: 'Rejected' as const, reason: 'PredecessorNotSealed' as const }),
    );
    const instance = await server(Object.assign(configuration(), { continuation: { admit } }));
    try {
      const payload = {
        version: 1,
        expectedRunVersion: run.version,
        predecessorCheckpointSaid: `E${'c'.repeat(43)}`,
        predecessorSealSaid: `E${'s'.repeat(43)}`,
        predecessorHeadSaid: `E${'h'.repeat(43)}`,
        successorIncarnationId: randomUUID(),
        successorStreamId: randomUUID(),
        expectedActivePointerVersion: 2,
        expectedActivationReceiptSaid: `E${'a'.repeat(43)}`,
      };
      expect(Value.Check(runContinuationRequestSchema, payload)).toBe(true);
      const response = await instance.inject({
        method: 'POST',
        url: `/api/runs/${run.binding.runId}/continuations`,
        headers: { authorization: `Bearer ${bearerSecret}` },
        payload,
      });
      expect(admit).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(409);
    } finally {
      await instance.close();
    }
  });

  it('inspects one owner-scoped authoritative Run through run:read', async () => {
    const authorize = vi.fn<RunRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
    );
    const inspect = vi.fn(() =>
      Promise.resolve({ kind: 'RunFound' as const, projection: projectRun(runFixture()) }),
    );
    const instance = await server(
      configuration({
        access: { authorize },
        conversation: { ...configuration().conversation, inspect },
      }),
    );

    const response = await instance.inject({
      method: 'GET',
      url: `/api/runs/${runFixture().binding.runId}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(projectRun(runFixture()));
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      bearerSecret,
      scope: 'run:read',
      observedAt: '2026-09-24T20:00:00.000Z',
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith({
      ownerAid: owner.ownerAid,
      runId: runFixture().binding.runId,
    });
    await instance.close();
  });

  it('does not reveal whether another owner has the requested Run', async () => {
    const instance = await server(
      configuration({
        conversation: {
          ...configuration().conversation,
          inspect: () => Promise.resolve({ kind: 'RunResourceNotFound', resource: 'Run' }),
        },
      }),
    );

    const response = await instance.inject({
      method: 'GET',
      url: `/api/runs/${runFixture().binding.runId}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: 'RunResourceNotFound',
      resource: 'Run',
    });
    await instance.close();
  });

  it('derives the owner from run:create and returns the durable Run receipt', async () => {
    const authorize = vi.fn<RunRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
    );
    const admit = vi.fn<RunRoutesConfiguration['conversation']['admit']>(() =>
      Promise.resolve({ kind: 'RunCreated', projection: projectRun(runFixture()) }),
    );
    const instance = await server(
      configuration({
        access: { authorize },
        conversation: { ...configuration().conversation, admit },
      }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: admissionCommand,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(projectRun(runFixture()));
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      bearerSecret,
      scope: 'run:create',
      observedAt: '2026-09-24T20:00:00.000Z',
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith({ owner, command: admissionCommand });
    await instance.close();
  });

  it('persists a pending exchange response instead of constructing a Run', async () => {
    const projection = {
      version: 1 as const,
      disposition: 'RunAdmissionExchangePending' as const,
      commandId: admissionCommand.commandId,
      admissionExchangeSaid: admissionCommand.admissionExchangeSaid,
    };
    const instance = await server(
      configuration({
        conversation: {
          ...configuration().conversation,
          admit: () => Promise.resolve({ kind: 'RunAdmissionExchangePending', projection }),
        },
      }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: admissionCommand,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(projection);
    await instance.close();
  });

  it('uses run:execute for the path-bound first lease and returns its server deadline', async () => {
    const authorize = vi.fn<RunRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
    );
    const acquireLease = vi.fn<RunRoutesConfiguration['conversation']['acquireLease']>(() =>
      configuration().conversation.acquireLease({
        owner,
        runId: runFixture().binding.runId,
        incarnationId,
        command: { version: 1, expectedRunVersion: 0 },
      }),
    );
    const instance = await server(
      configuration({
        access: { authorize },
        conversation: { ...configuration().conversation, acquireLease },
      }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/runs/${runFixture().binding.runId}/incarnations/${incarnationId}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, expectedRunVersion: 0 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      disposition: 'Acquired',
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      bearerSecret,
      scope: 'run:execute',
      observedAt: '2026-09-24T20:00:00.000Z',
    });
    expect(acquireLease).toHaveBeenCalledExactlyOnceWith({
      owner,
      runId: runFixture().binding.runId,
      incarnationId,
      command: { version: 1, expectedRunVersion: 0 },
    });
    await instance.close();
  });

  it('renews through run:execute and returns its receipt only in typed 204 headers', async () => {
    const authorize = vi.fn<RunRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
    );
    const renewLease = vi.fn<RunRoutesConfiguration['conversation']['renewLease']>(() =>
      configuration().conversation.renewLease({
        ownerAid: owner.ownerAid,
        runId: runFixture().binding.runId,
        incarnationId,
        command: { version: 1, expectedRunVersion: 1 },
      }),
    );
    const instance = await server(
      configuration({
        access: { authorize },
        conversation: { ...configuration().conversation, renewLease },
      }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/runs/${runFixture().binding.runId}/incarnations/${incarnationId}/lease`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, expectedRunVersion: 1 },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers).toMatchObject({
      'x-devrandom-server-time': '2026-09-24T20:00:15.000Z',
      'x-devrandom-lease-expires-at': '2026-09-24T20:01:00.000Z',
      'x-devrandom-run-version': '2',
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      bearerSecret,
      scope: 'run:execute',
      observedAt: '2026-09-24T20:00:00.000Z',
    });
    expect(renewLease).toHaveBeenCalledExactlyOnceWith({
      ownerAid: owner.ownerAid,
      runId: runFixture().binding.runId,
      incarnationId,
      command: { version: 1, expectedRunVersion: 1 },
    });
    await instance.close();
  });
});
