import { randomUUID } from 'node:crypto';
import { createTask } from '../application/create-task.js';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  decodeTaskProjection,
  prepareTaskCommandV2,
  taskEvaluationBudgetCeilings,
} from '@devrandom/protocol';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { taskRoutes, type TaskRoutesConfiguration } from './task-routes.js';
import {
  taskCommandFixture,
  taskCredentialSaid,
  taskOwnerAid,
} from '../test/task-command-fixture.js';

const task = {
  version: 1 as const,
  taskId: '22222222-2222-4222-8222-222222222222',
  ownerAid: taskOwnerAid,
  label: 'compatibility-fix',
  harnessLineageId: '33333333-3333-4333-8333-333333333333',
  revisionSaid: taskCommandFixture().revision.d,
  revision: taskCommandFixture().revision,
  lifecycle: { kind: 'Open' as const },
  commandId: taskCommandFixture().commandId,
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0 as const,
};
const bearerSecret = 's'.repeat(43);

function configuration(overrides: Partial<TaskRoutesConfiguration> = {}): TaskRoutesConfiguration {
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'TaskAccessAuthorized',
          owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        }),
    },
    conversation: {
      create: () => Promise.resolve({ kind: 'TaskCreated', task }),
      list: () =>
        Promise.resolve({
          kind: 'TasksListed',
          page: { version: 1, tasks: [], nextCursor: null },
        }),
      inspect: () => Promise.resolve({ kind: 'TaskFound', task }),
    },
    now: () => '2026-09-24T12:00:00.000Z',
    newCorrelationId: randomUUID,
    ...overrides,
  };
}

async function server(configurationInput: TaskRoutesConfiguration) {
  const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await instance.register(taskRoutes(configurationInput));
  return instance;
}

describe('Task HTTP routes', () => {
  it('returns a canonically ordered signed v2 revision through the real HTTP serializer', async () => {
    const old = taskCommandFixture();
    const { d: oldSaid, repository, ...contract } = old.revision;
    expect(oldSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
    const prepared = prepareTaskCommandV2(
      {
        ...contract,
        version: 2,
        label: old.label,
        repository: { kind: 'gitCommit', commit: repository.commit },
        constraints: {
          ...contract.constraints,
          dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
          experience: {
            corpusSaid: `E${'c'.repeat(43)}`,
            repositoryResourceSaid: `E${'r'.repeat(43)}`,
            disclosure: 'AuthorizedAnalogy',
          },
        },
        requestedCapabilities: [...contract.requestedCapabilities, 'ReadTaskMemory'],
        budgets: { ...contract.budgets, ...taskEvaluationBudgetCeilings },
      },
      old.commandId,
      repository,
    );
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('v2 Task fixture rejected');
    const v2 = {
      ...task,
      revisionSaid: prepared.command.revision.d,
      revision: prepared.command.revision,
    };
    const defaults = configuration();
    const instance = await server(
      configuration({
        conversation: {
          ...defaults.conversation,
          create: () => Promise.resolve({ kind: 'TaskCreated', task: v2 }),
          inspect: () => Promise.resolve({ kind: 'TaskFound', task: v2 }),
        },
      }),
    );
    try {
      const response = await instance.inject({
        method: 'GET',
        url: `/api/tasks/by-label/${old.label}`,
        headers: { authorization: `Bearer ${bearerSecret}` },
      });
      expect(response.statusCode).toBe(200);
      expect(decodeTaskProjection(response.json())).toEqual({
        kind: 'Accepted',
        projection: v2,
      });
    } finally {
      await instance.close();
    }
  });

  it('rejects a mixed-case Task label without normalizing or creating a Task', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>(() =>
      Promise.resolve({ kind: 'TaskCreated', task }),
    );
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );
    try {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${bearerSecret}` },
        payload: { ...taskCommandFixture(), label: 'Compatibility-Fix' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'TaskRequestInvalid' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('rejects an unknown Task command member instead of silently removing it', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>(() =>
      Promise.resolve({ kind: 'TaskCreated', task }),
    );
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );
    try {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${bearerSecret}` },
        payload: { ...taskCommandFixture(), personality: 'eager' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'TaskRequestInvalid' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('rejects a string timeout instead of coercing it into the closed Task command', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>(() =>
      Promise.resolve({ kind: 'TaskCreated', task }),
    );
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );
    try {
      const command = taskCommandFixture();
      const response = await instance.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${bearerSecret}` },
        payload: {
          ...command,
          revision: {
            ...command.revision,
            completionConditions: [
              { ...command.revision.completionConditions[0], timeoutSeconds: '300' },
            ],
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'TaskRequestInvalid' });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('rejects a released grant distinctly at the public Task boundary', async () => {
    const instance = await server(
      configuration({
        access: { authorize: () => Promise.resolve({ kind: 'TaskAccessReleased' }) },
      }),
    );
    try {
      const response = await instance.inject({
        method: 'GET',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${bearerSecret}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'WorkAccessGrantReleased', status: 401 });
    } finally {
      await instance.close();
    }
  });

  it.each([
    bearerSecret,
    'Authorization: Bearer opaque-http-fixture-715938',
    '-----BEGIN PRIVATE KEY----- fixture -----END PRIVATE KEY-----',
    'PROVIDER_API_KEY=opaque-http-fixture-715938',
  ])('rejects protected Task payload over localhost without storage effects', async (content) => {
    const reconcile = vi.fn(() => Promise.resolve({ kind: 'NoTask' as const }));
    const persist = vi.fn(() => Promise.resolve({ kind: 'TaskCreated' as const, task }));
    const instance = await server(
      configuration({
        conversation: {
          ...configuration().conversation,
          create: (input) =>
            createTask(input, {
              tasks: {
                reconcile,
                create: persist,
                list: () => Promise.reject(new Error('not used')),
                findByLabel: () => Promise.reject(new Error('not used')),
                findById: () => Promise.reject(new Error('not used')),
              },
              eligibility: { authorize: () => Promise.resolve({ kind: 'Eligible' }) },
              now: () => '2026-09-24T12:00:00.000Z',
              newTaskId: randomUUID,
              newHarnessLineageId: randomUUID,
            }),
        },
      }),
    );
    try {
      const origin = await instance.listen({ host: '127.0.0.1', port: 0 });
      const command = taskCommandFixture(undefined, undefined, undefined, content);
      const response = await fetch(`${origin}/api/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(command),
      });
      const body = await response.text();
      expect(response.status).toBe(422);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(JSON.parse(body)).toMatchObject({
        code: 'TaskContractRejected',
        reason: 'SecretDetected',
      });
      expect(body).not.toContain(content);
      expect(body).not.toContain(command.revision.d);
      expect(reconcile).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('authorizes task:create and derives owner facts outside the request body', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>(() =>
      Promise.resolve({ kind: 'TaskCreated', task }),
    );
    const authorize = vi.fn<TaskRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({
        kind: 'TaskAccessAuthorized',
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
      }),
    );
    const instance = await server(
      configuration({
        access: { authorize },
        conversation: { ...configuration().conversation, create },
      }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: taskCommandFixture(),
    });

    expect(response.statusCode).toBe(201);
    expect(authorize).toHaveBeenCalledWith({
      bearerSecret,
      scope: 'task:create',
      observedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(create).toHaveBeenCalledOnce();
    const input = create.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
      command: taskCommandFixture(),
    });
    expect(input?.protectedCredentials.inspect(new TextEncoder().encode(bearerSecret))).toEqual({
      kind: 'WithheldSecret',
      reason: 'Credential',
      byteLength: 43,
    });
    await instance.close();
  });

  it('rejects a forged owner field before the Task application is invoked', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>();
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { ...taskCommandFixture(), ownerAid: `E${'z'.repeat(43)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'TaskRequestInvalid' });
    expect(create).not.toHaveBeenCalled();
    await instance.close();
  });

  it('enforces the 256 KiB ordinary JSON body ceiling', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>();
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );
    const command = taskCommandFixture();

    const response = await instance.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        authorization: `Bearer ${bearerSecret}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        ...command,
        revision: { ...command.revision, objective: 'x'.repeat(262_144) },
      }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'TaskBodyTooLarge' });
    expect(create).not.toHaveBeenCalled();
    await instance.close();
  });

  it('accepts the exact 256 KiB HTTP body boundary and rejects the next byte before creation', async () => {
    const create = vi.fn<TaskRoutesConfiguration['conversation']['create']>(() =>
      Promise.resolve({ kind: 'TaskCreated', task }),
    );
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, create } }),
    );
    try {
      const address = await instance.listen({ host: '127.0.0.1', port: 0 });
      const body = JSON.stringify(taskCommandFixture());
      const exact = body.padEnd(262_144, ' ');
      expect(Buffer.byteLength(exact)).toBe(262_144);

      const admitted = await fetch(`${address}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerSecret}`,
          'content-type': 'application/json',
        },
        body: exact,
      });
      expect(admitted.status).toBe(201);
      expect(create).toHaveBeenCalledTimes(1);

      const rejected = await fetch(`${address}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerSecret}`,
          'content-type': 'application/json',
        },
        body: `${exact} `,
      });
      expect(rejected.status).toBe(413);
      expect(await rejected.json()).toMatchObject({ code: 'TaskBodyTooLarge' });
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await instance.close();
    }
  });

  it.each<
    readonly [
      reason:
        | 'RepositoryBindingInvalid'
        | 'BudgetUnacceptable'
        | 'DeadlineUnacceptable'
        | 'CapabilityConflict'
        | 'CheckpointReferenceInvalid',
    ]
  >([
    ['RepositoryBindingInvalid'],
    ['BudgetUnacceptable'],
    ['DeadlineUnacceptable'],
    ['CapabilityConflict'],
    ['CheckpointReferenceInvalid'],
  ])('preserves the exact Task contract rejection reason %s', async (reason) => {
    const instance = await server(
      configuration({
        conversation: {
          ...configuration().conversation,
          create: () => Promise.resolve({ kind: 'TaskContractRejected', reason }),
        },
      }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: taskCommandFixture(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'TaskContractRejected', reason });
    await instance.close();
  });

  it('keeps an unexpected application failure opaque and server-attributed', async () => {
    const instance = await server(
      configuration({
        conversation: {
          ...configuration().conversation,
          create: () => Promise.reject(new Error('private application failure')),
        },
      }),
    );

    const response = await instance.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: taskCommandFixture(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('');
    expect(response.body).not.toContain('private application failure');
    expect(response.body).not.toContain('task-routes.spec');
    await instance.close();
  });

  it.each([
    [{ kind: 'TaskAccessInvalid' as const }, 401, 'TaskCapabilityInvalid'],
    [{ kind: 'TaskAccessExpired' as const }, 401, 'WorkAccessGrantExpired'],
    [
      { kind: 'TaskAccessRevoked' as const, reason: 'SecurityIncident' as const },
      403,
      'WorkAccessGrantRevoked',
    ],
    [{ kind: 'TaskAccessScopeRejected' as const }, 403, 'WorkAccessGrantScopeRejected'],
    [{ kind: 'TaskAccessConcurrentUpdate' as const }, 409, 'WorkAccessGrantConcurrentUpdate'],
    [{ kind: 'TaskAccessExhausted' as const }, 429, 'WorkAccessGrantExhausted'],
    [
      { kind: 'TaskAccessUnavailable' as const, dependency: 'HostedMongoDB' as const },
      503,
      'TaskUnavailable',
    ],
  ])('maps grant failure %j to a distinct public problem', async (authorization, status, code) => {
    const instance = await server(
      configuration({
        access: { authorize: () => Promise.resolve(authorization) },
      }),
    );

    const response = await instance.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${bearerSecret}` },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    await instance.close();
  });

  it('rejects arbitrary query filters and owner-scopes label inspection', async () => {
    const inspect = vi.fn<TaskRoutesConfiguration['conversation']['inspect']>(() =>
      Promise.resolve({ kind: 'TaskFound', task }),
    );
    const instance = await server(
      configuration({ conversation: { ...configuration().conversation, inspect } }),
    );

    const arbitrary = await instance.inject({
      method: 'GET',
      url: '/api/tasks?ownerAid=forged',
      headers: { authorization: `Bearer ${bearerSecret}` },
    });
    const inspected = await instance.inject({
      method: 'GET',
      url: '/api/tasks/by-label/compatibility-fix',
      headers: { authorization: `Bearer ${bearerSecret}` },
    });

    expect(arbitrary.statusCode).toBe(400);
    expect(inspected.statusCode).toBe(200);
    expect(inspect).toHaveBeenCalledWith({
      ownerAid: taskOwnerAid,
      label: 'compatibility-fix',
    });
    await instance.close();
  });
});
