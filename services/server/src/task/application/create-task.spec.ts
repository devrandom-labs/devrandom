import { ProtectedCredentials } from '@devrandom/domain';
import {
  prepareTaskCommandV2,
  taskEvaluationBudgetCeilings,
  type PreparedTaskCommand,
  type TaskProjection,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createTask, type CreateTaskDependencies } from './create-task.js';
import {
  taskCommandFixture,
  taskCredentialSaid,
  taskOwnerAid,
} from '../test/task-command-fixture.js';

const createdAt = '2026-09-24T12:00:00.000Z';

function dependencies(overrides: Partial<CreateTaskDependencies> = {}): CreateTaskDependencies {
  return {
    tasks: {
      reconcile: () => Promise.resolve({ kind: 'NoTask' }),
      create: (proposedTask) => Promise.resolve({ kind: 'TaskCreated', task: proposedTask.task }),
      list: () => Promise.resolve({ kind: 'TaskPage', tasks: [], nextPosition: null }),
      findByLabel: () => Promise.resolve({ kind: 'TaskNotFound' }),
      findById: () => Promise.resolve({ kind: 'TaskNotFound' }),
    },
    eligibility: {
      authorize: () => Promise.resolve({ kind: 'Eligible' }),
    },
    now: () => createdAt,
    newTaskId: () => '22222222-2222-4222-8222-222222222222',
    newHarnessLineageId: () => '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

describe('Task creation application', () => {
  it('creates a v2 Task with exact authorized experience and finite evaluation ceilings', async () => {
    const old = taskCommandFixture();
    const { d: oldRevisionSaid, repository, ...contract } = old.revision;
    expect(oldRevisionSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
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
    if (prepared.kind !== 'Prepared') throw new Error('expected v2 task');
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: prepared.command,
      },
      dependencies(),
    );
    expect(outcome.kind).toBe('TaskCreated');
    if (outcome.kind !== 'TaskCreated') throw new Error('expected Task creation');
    expect(outcome.task.revision.version).toBe(2);
    expect(outcome.task.revision.budgets.providerRequests).toBe(256);
  });
  it.each([
    's'.repeat(43),
    'Authorization: Bearer opaque-fixture-763518',
    '-----BEGIN PRIVATE KEY----- fixture -----END PRIVATE KEY-----',
    'PROVIDER_API_KEY=opaque-fixture-763518',
  ])('rejects protected Task content before identity verification and storage', async (content) => {
    const defaults = dependencies();
    const reconcile = vi.fn(defaults.tasks.reconcile.bind(defaults.tasks));
    const create = vi.fn(defaults.tasks.create.bind(defaults.tasks));
    const authorize = vi.fn(defaults.eligibility.authorize.bind(defaults.eligibility));
    const newTaskId = vi.fn(defaults.newTaskId.bind(defaults));
    const newHarnessLineageId = vi.fn(defaults.newHarnessLineageId.bind(defaults));
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(['s'.repeat(43)]),
        command: taskCommandFixture(undefined, undefined, undefined, content),
      },
      {
        ...defaults,
        tasks: { ...defaults.tasks, reconcile, create },
        eligibility: { authorize },
        newTaskId,
        newHarnessLineageId,
      },
    );

    expect(outcome).toEqual({ kind: 'TaskContractRejected', reason: 'SecretDetected' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(newTaskId).not.toHaveBeenCalled();
    expect(newHarnessLineageId).not.toHaveBeenCalled();
  });

  it('derives ownership from authenticated grant facts and opens one immutable first revision', async () => {
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: taskCommandFixture(),
      },
      dependencies(),
    );

    expect(outcome.kind).toBe('TaskCreated');
    if (outcome.kind !== 'TaskCreated') {
      return;
    }
    expect(outcome.task).toEqual({
      version: 1,
      taskId: '22222222-2222-4222-8222-222222222222',
      ownerAid: taskOwnerAid,
      label: 'compatibility-fix',
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      revisionSaid: outcome.task.revision.d,
      revision: outcome.task.revision,
      lifecycle: { kind: 'Open' },
      commandId: '11111111-1111-4111-8111-111111111111',
      createdAt,
      expectedVersion: 0,
    } satisfies TaskProjection);
  });

  it('rejects a deadline at creation time or beyond four hours', async () => {
    await expect(
      createTask(
        {
          owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture(createdAt),
        },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: 'TaskContractRejected', reason: 'DeadlineUnacceptable' });

    await expect(
      createTask(
        {
          owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture('2026-09-24T16:00:00.001Z'),
        },
        dependencies(),
      ),
    ).resolves.toEqual({ kind: 'TaskContractRejected', reason: 'DeadlineUnacceptable' });
  });

  it('rejects an impossible calendar deadline before durable Task creation', async () => {
    const defaults = dependencies();
    const create = vi.fn(defaults.tasks.create.bind(defaults.tasks));
    const command = taskCommandFixture();
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: {
          ...command,
          revision: { ...command.revision, expiresAt: '2026-02-30T14:00:00.000Z' },
        },
      },
      {
        ...defaults,
        now: () => '2026-03-02T12:00:00.000Z',
        tasks: { ...defaults.tasks, create },
      },
    );

    expect(outcome).toEqual({ kind: 'TaskContractRejected', reason: 'DeadlineUnacceptable' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each<
    readonly [
      invalidity: string,
      corrupt: (command: PreparedTaskCommand) => PreparedTaskCommand,
      reason:
        | 'RepositoryBindingInvalid'
        | 'BudgetUnacceptable'
        | 'CapabilityConflict'
        | 'CheckpointReferenceInvalid',
    ]
  >([
    [
      'two repository deliverables share one path',
      (command) => ({
        ...command,
        revision: {
          ...command.revision,
          deliverables: [
            { kind: 'repositoryFile', id: 'implementation', path: 'src/index.ts' },
            { kind: 'repositoryFile', id: 'copy', path: 'src/index.ts' },
          ],
        },
      }),
      'RepositoryBindingInvalid',
    ],
    [
      'content no longer matches its SAID',
      (command) => ({
        ...command,
        revision: { ...command.revision, objective: 'changed after SAID allocation' },
      }),
      'RepositoryBindingInvalid',
    ],
    [
      'completion condition exceeds the declared child-command budget',
      (command) => ({
        ...command,
        revision: {
          ...command.revision,
          budgets: { ...command.revision.budgets, oneChildCommandTimeSeconds: 299 },
        },
      }),
      'BudgetUnacceptable',
    ],
    [
      'requested capability is also unavailable',
      (command) => ({
        ...command,
        revision: { ...command.revision, unavailableCapabilities: ['ReadRepository'] },
      }),
      'CapabilityConflict',
    ],
    [
      'checkpoint names an absent deliverable',
      (command) => ({
        ...command,
        revision: {
          ...command.revision,
          checkpointExpectations: [{ kind: 'deliverable', deliverableId: 'absent' }],
        },
      }),
      'CheckpointReferenceInvalid',
    ],
  ])('maps %s to its exact public rejection', async (_invalidity, corrupt, reason) => {
    const reconcile = vi.fn();

    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: corrupt(taskCommandFixture()),
      },
      dependencies({ tasks: { ...dependencies().tasks, reconcile } }),
    );

    expect(outcome).toEqual({ kind: 'TaskContractRejected', reason });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rechecks current CreateTask eligibility before inserting', async () => {
    const create = vi.fn();
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: taskCommandFixture(),
      },
      dependencies({
        tasks: {
          reconcile: () => Promise.resolve({ kind: 'NoTask' }),
          create,
          list: () => Promise.resolve({ kind: 'TaskPage', tasks: [], nextPosition: null }),
          findByLabel: () => Promise.resolve({ kind: 'TaskNotFound' }),
          findById: () => Promise.resolve({ kind: 'TaskNotFound' }),
        },
        eligibility: {
          authorize: () => Promise.resolve({ kind: 'CredentialNotCurrent' }),
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'CredentialNotCurrent' });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns the accepted task for an exact command retry without another mutation', async () => {
    const projection = {
      version: 1,
      taskId: '22222222-2222-4222-8222-222222222222',
      ownerAid: taskOwnerAid,
      label: 'compatibility-fix',
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      revisionSaid: taskCommandFixture().revision.d,
      revision: taskCommandFixture().revision,
      lifecycle: { kind: 'Open' },
      commandId: '11111111-1111-4111-8111-111111111111',
      createdAt,
      expectedVersion: 0,
    } satisfies TaskProjection;
    const create = vi.fn();
    const authorize = vi.fn(() => Promise.resolve({ kind: 'Eligible' as const }));

    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: taskCommandFixture(),
      },
      dependencies({
        tasks: {
          reconcile: () => Promise.resolve({ kind: 'ExistingTask', task: projection }),
          create,
          list: () => Promise.resolve({ kind: 'TaskPage', tasks: [], nextPosition: null }),
          findByLabel: () => Promise.resolve({ kind: 'TaskNotFound' }),
          findById: () => Promise.resolve({ kind: 'TaskNotFound' }),
        },
        eligibility: { authorize },
      }),
    );

    expect(outcome).toEqual({ kind: 'ExistingTask', task: projection });
    expect(authorize).toHaveBeenCalledWith({
      ownerAid: taskOwnerAid,
      credentialSaid: taskCredentialSaid,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an exact command retry when its credential is no longer current', async () => {
    const projection = {
      version: 1,
      taskId: '22222222-2222-4222-8222-222222222222',
      ownerAid: taskOwnerAid,
      label: 'compatibility-fix',
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      revisionSaid: taskCommandFixture().revision.d,
      revision: taskCommandFixture().revision,
      lifecycle: { kind: 'Open' },
      commandId: '11111111-1111-4111-8111-111111111111',
      createdAt,
      expectedVersion: 0,
    } satisfies TaskProjection;
    const create = vi.fn();

    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: taskCommandFixture(),
      },
      dependencies({
        tasks: {
          reconcile: () => Promise.resolve({ kind: 'ExistingTask', task: projection }),
          create,
          list: () => Promise.resolve({ kind: 'TaskPage', tasks: [], nextPosition: null }),
          findByLabel: () => Promise.resolve({ kind: 'TaskNotFound' }),
          findById: () => Promise.resolve({ kind: 'TaskNotFound' }),
        },
        eligibility: {
          authorize: () => Promise.resolve({ kind: 'CredentialNotCurrent' }),
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'CredentialNotCurrent' });
    expect(create).not.toHaveBeenCalled();
  });
});
