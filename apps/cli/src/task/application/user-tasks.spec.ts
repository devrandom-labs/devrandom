import { ProtectedCredentials } from '@devrandom/domain';
import { describe, expect, it, vi } from 'vitest';

import {
  preparedRepositoryFixture,
  taskProjectionFixture,
  taskSourceFixture,
} from '../../../test/task-source-fixture.js';
import {
  CurrentTaskAuthority,
  UserTasks,
  type HostedTasks,
  type TaskAuthority,
} from './user-tasks.js';

function authorized(tasks: HostedTasks): TaskAuthority {
  return {
    acquire: () =>
      Promise.resolve({
        kind: 'Authorized',
        tasks,
        protectedCredentials: new ProtectedCredentials(),
      }),
  };
}

function hostedTasks(overrides?: Partial<HostedTasks>): HostedTasks {
  const task = taskProjectionFixture();
  return {
    create: () => Promise.resolve({ kind: 'Created', task }),
    list: () =>
      Promise.resolve({ kind: 'Listed', page: { version: 1, tasks: [], nextCursor: null } }),
    inspect: () => Promise.resolve({ kind: 'Inspected', task }),
    ...overrides,
  };
}

describe('authenticated user Task commands', () => {
  it.each(['LocalCredential', 'GrantCredential', 'AuthorizationHeader'] as const)(
    'rejects Task source containing %s before repository resolution, identity allocation or hosted creation',
    async (location) => {
      const secret = 'opaque-task-source-fixture-635719';
      const source = taskSourceFixture();
      const document = {
        ...source,
        objective:
          location === 'AuthorizationHeader' ? `Authorization: Bearer ${secret}` : source.objective,
        completionConditions: source.completionConditions.map((condition) => ({
          ...condition,
          argv: location === 'AuthorizationHeader' ? condition.argv : [...condition.argv, secret],
        })),
      };
      const resolve = vi.fn(() =>
        Promise.resolve({ kind: 'Resolved' as const, repository: preparedRepositoryFixture }),
      );
      const create = vi.fn<HostedTasks['create']>(() =>
        Promise.resolve({ kind: 'Created', task: taskProjectionFixture() }),
      );
      const acquire = vi.fn<TaskAuthority['acquire']>(() =>
        Promise.resolve({
          kind: 'Authorized',
          tasks: hostedTasks({ create }),
          protectedCredentials: new ProtectedCredentials(
            location === 'GrantCredential' ? [secret] : [],
          ),
        }),
      );
      const newCommandId = vi.fn(() => '97e16745-4b76-4de3-9ae5-a183496e73e8');
      const tasks = new UserTasks({
        documents: { read: () => Promise.resolve({ kind: 'Read', document }) },
        protectedCredentials: new ProtectedCredentials(
          location === 'LocalCredential' ? [secret] : [],
        ),
        repository: { resolve },
        authority: { acquire },
        newCommandId,
        wait: () => Promise.resolve(),
      });

      await expect(tasks.create('task.devrandom.json')).resolves.toEqual({
        kind: 'TaskSecretDetected',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(newCommandId).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledTimes(location === 'GrantCredential' ? 1 : 0);
    },
  );

  it('does not attempt Work Access when current identity admission is unavailable', async () => {
    const acquireWorkAccess = vi.fn();
    const authority = new CurrentTaskAuthority(
      {
        admitHostedWork: () =>
          Promise.resolve({
            kind: 'RecoveryRequired',
            reason: 'CustodyUnavailable',
          }),
      },
      'https://server.example',
      acquireWorkAccess,
    );

    await expect(authority.acquire()).resolves.toEqual({
      kind: 'TaskIdentityRejected',
      identity: { kind: 'RecoveryRequired', reason: 'CustodyUnavailable' },
    });
    expect(acquireWorkAccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid local document before repository inspection or authentication', async () => {
    const resolve = vi.fn();
    const acquire = vi.fn();
    const tasks = new UserTasks({
      protectedCredentials: new ProtectedCredentials(),
      documents: { read: () => Promise.resolve({ kind: 'Read', document: { version: 2 } }) },
      repository: { resolve },
      authority: { acquire },
      newCommandId: () => '97e16745-4b76-4de3-9ae5-a183496e73e8',
      wait: () => Promise.resolve(),
    });

    await expect(tasks.create('task.devrandom.json')).resolves.toEqual({
      kind: 'TaskContractRejected',
      reason: 'SchemaInvalid',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects an impossible calendar deadline before Work Access or repository resolution', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve({ kind: 'Resolved' as const, repository: preparedRepositoryFixture }),
    );
    const acquire = vi.fn<TaskAuthority['acquire']>(() =>
      Promise.resolve({
        kind: 'Authorized',
        tasks: hostedTasks(),
        protectedCredentials: new ProtectedCredentials(),
      }),
    );
    const tasks = new UserTasks({
      protectedCredentials: new ProtectedCredentials(),
      documents: {
        read: () =>
          Promise.resolve({
            kind: 'Read',
            document: { ...taskSourceFixture(), expiresAt: '2027-02-30T12:00:00.000Z' },
          }),
      },
      repository: { resolve },
      authority: { acquire },
      newCommandId: () => '97e16745-4b76-4de3-9ae5-a183496e73e8',
      wait: () => Promise.resolve(),
    });

    await expect(tasks.create('task.devrandom.json')).resolves.toEqual({
      kind: 'TaskContractRejected',
      reason: 'DeadlineInvalid',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('retries one prepared command unchanged and returns the reconciled durable Task', async () => {
    const submitted: unknown[] = [];
    let request = 0;
    const task = taskProjectionFixture();
    const server = hostedTasks({
      create: (command) => {
        submitted.push(command);
        request += 1;
        return Promise.resolve(
          request === 1 ? { kind: 'ServerUnavailable' } : { kind: 'Reconciled', task },
        );
      },
    });
    const tasks = new UserTasks({
      protectedCredentials: new ProtectedCredentials(),
      documents: { read: () => Promise.resolve({ kind: 'Read', document: taskSourceFixture() }) },
      repository: {
        resolve: () => Promise.resolve({ kind: 'Resolved', repository: preparedRepositoryFixture }),
      },
      authority: authorized(server),
      newCommandId: () => '97e16745-4b76-4de3-9ae5-a183496e73e8',
      wait: () => Promise.resolve(),
    });

    await expect(tasks.create('task.devrandom.json')).resolves.toEqual({
      kind: 'TaskReconciled',
      task,
    });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toEqual(submitted[1]);
  });

  it('lists and inspects only through newly acquired owner authority', async () => {
    const task = taskProjectionFixture();
    const server = hostedTasks({
      list: () =>
        Promise.resolve({
          kind: 'Listed',
          page: {
            version: 1,
            tasks: [
              {
                version: 1,
                taskId: task.taskId,
                ownerAid: task.ownerAid,
                label: task.label,
                harnessLineageId: task.harnessLineageId,
                revisionSaid: task.revisionSaid,
                lifecycle: task.lifecycle,
                commandId: task.commandId,
                createdAt: task.createdAt,
                expectedVersion: 0,
              },
            ],
            nextCursor: null,
          },
        }),
      inspect: () => Promise.resolve({ kind: 'Inspected', task }),
    });
    const tasks = new UserTasks({
      protectedCredentials: new ProtectedCredentials(),
      documents: { read: () => Promise.resolve({ kind: 'Read', document: taskSourceFixture() }) },
      repository: {
        resolve: () => Promise.resolve({ kind: 'Resolved', repository: preparedRepositoryFixture }),
      },
      authority: authorized(server),
      newCommandId: () => '97e16745-4b76-4de3-9ae5-a183496e73e8',
      wait: () => Promise.resolve(),
    });

    await expect(tasks.list()).resolves.toMatchObject({
      kind: 'TasksListed',
      page: { tasks: [{ label: 'repair-parser' }] },
    });
    await expect(tasks.inspect('repair-parser')).resolves.toEqual({
      kind: 'TaskInspected',
      task,
    });
    await expect(tasks.inspect('INVALID')).resolves.toEqual({
      kind: 'TaskLabelRejected',
    });
  });
});
