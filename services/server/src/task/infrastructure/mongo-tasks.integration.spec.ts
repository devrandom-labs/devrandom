import { ProtectedCredentials } from '@devrandom/domain';
import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  prepareTaskCommandV2,
  taskCommandFingerprint,
  taskRecoveryBudgetCeilings,
} from '@devrandom/protocol';

import { createTask } from '../application/create-task.js';
import { MongoTaskBootstrap } from './mongo-task-bootstrap.js';
import { MongoTasks, taskIndexNames, tasksCollectionName } from './mongo-tasks.js';
import type { TaskDocument } from './task-document.js';
import {
  taskCommandFixture,
  taskCredentialSaid,
  taskOwnerAid,
} from '../test/task-command-fixture.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const integration = mongodbUri === undefined ? describe.skip : describe;

integration('Mongo Task storage', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const databaseName = `devrandom_task_${randomUUID().replaceAll('-', '')}`;
  const database = client.db(databaseName);
  const tasks = new MongoTasks(database);

  beforeAll(async () => {
    await client.connect();
    await new MongoTaskBootstrap(database).bootstrap();
  });

  beforeEach(async () => {
    await database.collection(tasksCollectionName).deleteMany({});
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('bootstraps idempotently and verifies the exact retained storage contract', async () => {
    const bootstrap = new MongoTaskBootstrap(database);
    await expect(bootstrap.bootstrap()).resolves.toBeUndefined();
    await expect(bootstrap.verify()).resolves.toBeUndefined();
  });

  it('does not insert a Task when BSON would normalize its creation timestamp', async () => {
    const command = taskCommandFixture('2026-03-01T14:00:00.000Z');
    const task = {
      version: 1 as const,
      taskId: randomUUID(),
      ownerAid: taskOwnerAid,
      label: command.label,
      harnessLineageId: randomUUID(),
      revisionSaid: command.revision.d,
      revision: command.revision,
      lifecycle: { kind: 'Open' as const },
      commandId: command.commandId,
      createdAt: '2026-02-29T12:00:00.000Z',
      expectedVersion: 0,
    };
    await expect(
      tasks.create({ task, commandFingerprint: taskCommandFingerprint(command) }),
    ).resolves.toEqual({ kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' });
    await expect(database.collection(tasksCollectionName).countDocuments({})).resolves.toBe(0);
  });

  it('rejects a changed Task validator without repairing it during verification', async () => {
    const driftDatabase = client.db(`${databaseName}_validator_drift`);
    const bootstrap = new MongoTaskBootstrap(driftDatabase);
    const changedValidator = { $jsonSchema: { bsonType: 'object', required: ['ownerAid'] } };
    try {
      await bootstrap.bootstrap();
      await driftDatabase.command({
        collMod: tasksCollectionName,
        validator: changedValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });

      await expect(bootstrap.verify()).rejects.toMatchObject({
        name: 'TaskStorageDrift',
        resource: 'TaskCollection',
      });
      const observed = await driftDatabase
        .listCollections({ name: tasksCollectionName }, { nameOnly: false })
        .next();
      expect(observed?.options?.validator).toEqual(changedValidator);
    } finally {
      await driftDatabase.dropDatabase();
    }
  });

  it('rejects a changed named Task index without repairing it during verification', async () => {
    const driftDatabase = client.db(`${databaseName}_index_drift`);
    const bootstrap = new MongoTaskBootstrap(driftDatabase);
    const collection = driftDatabase.collection(tasksCollectionName);
    try {
      await bootstrap.bootstrap();
      await collection.dropIndex(taskIndexNames.ownerPage);
      await collection.createIndex({ label: 1 }, { name: taskIndexNames.ownerPage });

      await expect(bootstrap.verify()).rejects.toMatchObject({
        name: 'TaskStorageDrift',
        resource: 'TaskIndexes',
      });
      await expect(collection.listIndexes().toArray()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: taskIndexNames.ownerPage, key: { label: 1 } }),
        ]),
      );
    } finally {
      await driftDatabase.dropDatabase();
    }
  });

  it('does not recreate a missing named Task index during verification', async () => {
    const driftDatabase = client.db(`${databaseName}_missing_index`);
    const bootstrap = new MongoTaskBootstrap(driftDatabase);
    const collection = driftDatabase.collection(tasksCollectionName);
    try {
      await bootstrap.bootstrap();
      await collection.dropIndex(taskIndexNames.ownerPage);

      await expect(bootstrap.verify()).rejects.toMatchObject({
        name: 'TaskStorageDrift',
        resource: 'TaskIndexes',
      });
      await expect(collection.indexExists(taskIndexNames.ownerPage)).resolves.toBe(false);
    } finally {
      await driftDatabase.dropDatabase();
    }
  });

  it('retains ordered tool declarations separately from public completion conditions', async () => {
    const command = taskCommandFixture(undefined, undefined, undefined, undefined, [
      {
        capability: 'RunFormatter',
        id: 'format',
        argv: ['just', 'format'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
      {
        capability: 'RunStaticAnalysis',
        id: 'analyze',
        argv: ['just', 'lint'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
    ]);
    const outcome = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command,
      },
      {
        tasks,
        eligibility: { authorize: () => Promise.resolve({ kind: 'Eligible' }) },
        now: () => '2026-09-24T12:00:00.000Z',
        newTaskId: randomUUID,
        newHarnessLineageId: randomUUID,
      },
    );
    expect(outcome.kind).toBe('TaskCreated');
    if (outcome.kind !== 'TaskCreated') throw new Error('declared commands must persist');
    await expect(tasks.findById(taskOwnerAid, outcome.task.taskId)).resolves.toEqual({
      kind: 'TaskFound',
      task: outcome.task,
    });
    expect(outcome.task.revision.toolCommands).toEqual(command.revision.toolCommands);
    expect(outcome.task.revision.completionConditions).toEqual(
      command.revision.completionConditions,
    );
    expect(outcome.task.revisionSaid).toBe(command.revision.d);
  });

  it('does not persist a protected Task or consume its command identity', async () => {
    const secret = 'opaque-hosted-task-fixture-926571';
    const dependencies = {
      tasks,
      eligibility: { authorize: () => Promise.resolve({ kind: 'Eligible' as const }) },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const input = {
      owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
      protectedCredentials: new ProtectedCredentials([secret]),
      command: taskCommandFixture(undefined, undefined, undefined, secret),
    };

    await expect(createTask(input, dependencies)).resolves.toEqual({
      kind: 'TaskContractRejected',
      reason: 'SecretDetected',
    });
    await expect(database.collection(tasksCollectionName).countDocuments()).resolves.toBe(0);
    await expect(
      createTask({ ...input, command: taskCommandFixture() }, dependencies),
    ).resolves.toMatchObject({ kind: 'TaskCreated' });
    await expect(database.collection(tasksCollectionName).countDocuments()).resolves.toBe(1);
  });

  it('atomically creates once, reconciles exact retry, and scopes reads to the owner', async () => {
    const dependencies = {
      tasks,
      eligibility: {
        authorize: () => Promise.resolve({ kind: 'Eligible' as const }),
      },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: () => randomUUID(),
    };
    const input = {
      owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
      protectedCredentials: new ProtectedCredentials(),
      command: taskCommandFixture(),
    };

    const created = await createTask(input, dependencies);
    const retried = await createTask(input, dependencies);

    expect(created.kind).toBe('TaskCreated');
    expect(retried).toEqual(
      created.kind === 'TaskCreated' ? { kind: 'ExistingTask', task: created.task } : created,
    );
    await expect(tasks.findByLabel(taskOwnerAid, 'compatibility-fix')).resolves.toMatchObject({
      kind: 'TaskFound',
    });
    if (created.kind === 'TaskCreated') {
      await expect(tasks.findById(taskOwnerAid, created.task.taskId)).resolves.toEqual({
        kind: 'TaskFound',
        task: created.task,
      });
      await expect(tasks.findById(`E${'z'.repeat(43)}`, created.task.taskId)).resolves.toEqual({
        kind: 'TaskNotFound',
      });
    }
    await expect(tasks.findByLabel(`E${'z'.repeat(43)}`, 'compatibility-fix')).resolves.toEqual({
      kind: 'TaskNotFound',
    });
  });

  it('returns one stable Task identity for concurrent exact command retries within one owner', async () => {
    const dependencies = {
      tasks,
      eligibility: { authorize: () => Promise.resolve({ kind: 'Eligible' as const }) },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const command = taskCommandFixture();
    const owner = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        createTask(
          { owner, protectedCredentials: new ProtectedCredentials(), command },
          dependencies,
        ),
      ),
    );
    const created = outcomes.filter((outcome) => outcome.kind === 'TaskCreated');
    expect(created).toHaveLength(1);
    const task = created[0]?.task;
    if (task === undefined) throw new Error('one concurrent Task must be created');
    expect(outcomes.filter((outcome) => outcome.kind === 'ExistingTask')).toHaveLength(7);
    expect(
      outcomes.every((outcome) => 'task' in outcome && outcome.task.taskId === task.taskId),
    ).toBe(true);
    await expect(database.collection(tasksCollectionName).countDocuments()).resolves.toBe(1);
    await expect(tasks.findByLabel(`E${'z'.repeat(43)}`, command.label)).resolves.toEqual({
      kind: 'TaskNotFound',
    });
  });

  it('retains a completed lifecycle and incremented aggregate version as authoritative Task state', async () => {
    const dependencies = {
      tasks,
      eligibility: {
        authorize: () => Promise.resolve({ kind: 'Eligible' as const }),
      },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const created = await createTask(
      {
        owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
        protectedCredentials: new ProtectedCredentials(),
        command: taskCommandFixture(),
      },
      dependencies,
    );
    if (created.kind !== 'TaskCreated') {
      throw new Error('fixture Task must be created');
    }

    await expect(
      database.collection<TaskDocument>(tasksCollectionName).updateOne(
        {
          _id: created.task.taskId,
          ownerAid: taskOwnerAid,
          expectedVersion: 0,
          'lifecycle.kind': 'Open',
        },
        {
          $set: { lifecycle: { kind: 'Completed' }, expectedVersion: 1 },
        },
      ),
    ).resolves.toMatchObject({ modifiedCount: 1 });
    await expect(tasks.findById(taskOwnerAid, created.task.taskId)).resolves.toMatchObject({
      kind: 'TaskFound',
      task: { lifecycle: { kind: 'Completed' }, expectedVersion: 1 },
    });
  });

  it('fails closed for command reuse, label collision, and per-owner capacity', async () => {
    const dependencies = {
      tasks,
      eligibility: {
        authorize: () => Promise.resolve({ kind: 'Eligible' as const }),
      },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const owner = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };
    await expect(
      createTask(
        { owner, protectedCredentials: new ProtectedCredentials(), command: taskCommandFixture() },
        dependencies,
      ),
    ).resolves.toMatchObject({ kind: 'TaskCreated' });
    await expect(
      createTask(
        {
          owner,
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture(
            '2026-09-24T14:00:00.000Z',
            '11111111-1111-4111-8111-111111111111',
            'changed-command',
          ),
        },
        dependencies,
      ),
    ).resolves.toEqual({
      kind: 'CommandConflict',
      commandId: '11111111-1111-4111-8111-111111111111',
    });
    await expect(
      createTask(
        {
          owner,
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture(
            '2026-09-24T14:00:00.000Z',
            randomUUID(),
            'compatibility-fix',
          ),
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'LabelConflict', label: 'compatibility-fix' });

    for (let index = 2; index <= 4; index += 1) {
      await expect(
        createTask(
          {
            owner,
            protectedCredentials: new ProtectedCredentials(),
            command: taskCommandFixture(
              '2026-09-24T14:00:00.000Z',
              randomUUID(),
              `task-${String(index)}`,
            ),
          },
          dependencies,
        ),
      ).resolves.toMatchObject({ kind: 'TaskCreated' });
    }
    await expect(
      createTask(
        {
          owner,
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture('2026-09-24T14:00:00.000Z', randomUUID(), 'task-5'),
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'TaskCapacityExceeded' });
  });

  it('stores the approved fifth Task in owner slot four with its signed five-Task and ten-Run ceilings', async () => {
    const owner = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };
    const dependencies = {
      tasks,
      eligibility: { authorize: () => Promise.resolve({ kind: 'Eligible' as const }) },
      approvedRecoveryOwnerAid: taskOwnerAid,
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    for (let index = 1; index <= 4; index += 1) {
      const outcome = await createTask(
        {
          owner,
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture(
            '2026-09-24T14:00:00.000Z',
            randomUUID(),
            `prior-${String(index)}`,
          ),
        },
        dependencies,
      );
      expect(outcome.kind).toBe('TaskCreated');
    }
    const old = taskCommandFixture('2026-09-24T14:00:00.000Z', randomUUID(), 'recovery');
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
        budgets: { ...contract.budgets, ...taskRecoveryBudgetCeilings },
      },
      old.commandId,
      repository,
    );
    if (prepared.kind !== 'Prepared') throw new Error('recovery Task preparation rejected');
    const outcome = await createTask(
      { owner, protectedCredentials: new ProtectedCredentials(), command: prepared.command },
      dependencies,
    );
    expect(outcome.kind).toBe('TaskCreated');
    expect(
      await database.collection(tasksCollectionName).countDocuments({ ownerAid: taskOwnerAid }),
    ).toBe(5);
    const stored = await database
      .collection<TaskDocument>(tasksCollectionName)
      .findOne({ label: old.label });
    expect(stored?.ownerSlot).toBe(4);
    expect(stored?.revision.budgets).toMatchObject({
      tasksPerAdmittedUser: 5,
      runsPerAdmittedUser: 10,
    });
  });

  it('returns a bounded stable owner-scoped page from an explicit keyset position', async () => {
    const dependencies = {
      tasks,
      eligibility: {
        authorize: () => Promise.resolve({ kind: 'Eligible' as const }),
      },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const owner = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };
    for (let index = 1; index <= 3; index += 1) {
      await createTask(
        {
          owner,
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture(
            '2026-09-24T14:00:00.000Z',
            randomUUID(),
            `page-${String(index)}`,
          ),
        },
        dependencies,
      );
    }

    const first = await tasks.list(taskOwnerAid, { limit: 2, after: null });
    expect(first.kind).toBe('TaskPage');
    if (first.kind !== 'TaskPage') {
      return;
    }
    expect(first.tasks).toHaveLength(2);
    expect(first.nextPosition).not.toBeNull();
    if (first.nextPosition === null) {
      return;
    }
    const second = await tasks.list(taskOwnerAid, { limit: 2, after: first.nextPosition });
    expect(second).toMatchObject({ kind: 'TaskPage', nextPosition: null });
    if (second.kind === 'TaskPage') {
      expect(second.tasks).toHaveLength(1);
      expect(
        new Set([...first.tasks, ...second.tasks].map((taskSummary) => taskSummary.taskId)).size,
      ).toBe(3);
    }
  });

  it('enforces the sixteen-Task global capacity through unique allocation slots', async () => {
    const dependencies = {
      tasks,
      eligibility: {
        authorize: () => Promise.resolve({ kind: 'Eligible' as const }),
      },
      now: () => '2026-09-24T12:00:00.000Z',
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    for (let index = 0; index < 16; index += 1) {
      const ownerAid = `E${String(index).padStart(43, '0')}`;
      await expect(
        createTask(
          {
            owner: { ownerAid, credentialSaid: taskCredentialSaid },
            protectedCredentials: new ProtectedCredentials(),
            command: taskCommandFixture('2026-09-24T14:00:00.000Z', randomUUID(), 'one-task'),
          },
          dependencies,
        ),
      ).resolves.toMatchObject({ kind: 'TaskCreated' });
    }
    await expect(
      createTask(
        {
          owner: { ownerAid: `E${'z'.repeat(43)}`, credentialSaid: taskCredentialSaid },
          protectedCredentials: new ProtectedCredentials(),
          command: taskCommandFixture('2026-09-24T14:00:00.000Z', randomUUID(), 'one-task'),
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'TaskCapacityExceeded' });
  });
});
