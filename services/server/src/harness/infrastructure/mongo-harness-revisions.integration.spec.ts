import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harnessCommandFingerprint, type BaselineHarnessProjection } from '@devrandom/protocol';

import { taskCommandFixture, taskOwnerAid } from '../../task/test/task-command-fixture.js';
import { admitBaselineHarness } from '../application/admit-baseline-harness.js';
import { harnessRoutes } from '../route/harness-routes.js';
import { baselineHarnessCommandFixture, harnessTask } from '../test/harness-command-fixture.js';
import { MongoHarnessBootstrap } from './mongo-harness-bootstrap.js';
import {
  MongoHarnessRevisions,
  harnessRevisionsCollectionName,
} from './mongo-harness-revisions.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const integration = mongodbUri === undefined ? describe.skip : describe;

function projection(command = baselineHarnessCommandFixture()): BaselineHarnessProjection {
  return {
    version: 1,
    ownerAid: taskOwnerAid,
    commandId: command.commandId,
    acceptedAt: '2026-09-24T12:30:00.000Z',
    revision: command.revision,
  };
}

integration('Mongo Harness Revision storage', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(`devrandom_harness_${randomUUID().replaceAll('-', '')}`);
  const revisions = new MongoHarnessRevisions(database);

  beforeAll(async () => {
    await client.connect();
    await new MongoHarnessBootstrap(database).bootstrap();
  });

  beforeEach(async () => {
    await database.collection(harnessRevisionsCollectionName).deleteMany({});
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('inserts one immutable H1, reconciles exact retry, and rejects another lineage root', async () => {
    const command = baselineHarnessCommandFixture();
    const accepted = projection(command);
    const fingerprint = harnessCommandFingerprint(command);

    await expect(
      revisions.create({ projection: accepted, commandFingerprint: fingerprint }),
    ).resolves.toEqual({ kind: 'HarnessRevisionCreated' });
    await expect(revisions.findAccepted(taskOwnerAid, accepted.revision.d)).resolves.toEqual({
      kind: 'AcceptedHarnessFound',
      projection: accepted,
      activation: {
        kind: 'AwaitingRunAdmission',
        harnessLineageId: accepted.revision.task.harnessLineageId,
        harnessRevisionSaid: accepted.revision.d,
      },
    });
    await expect(
      revisions.reconcile(taskOwnerAid, command.commandId, fingerprint),
    ).resolves.toEqual({ kind: 'ExistingHarnessRevision', projection: accepted });
    await expect(
      revisions.create({ projection: accepted, commandFingerprint: fingerprint }),
    ).resolves.toEqual({ kind: 'ExistingHarnessRevision', projection: accepted });

    const changedCommand = baselineHarnessCommandFixture(randomUUID(), 'different-model');
    await expect(
      revisions.create({
        projection: projection(changedCommand),
        commandFingerprint: harnessCommandFingerprint(changedCommand),
      }),
    ).resolves.toEqual({ kind: 'HarnessLineageConflict' });
  });

  it('does not insert an H1 when BSON would normalize its accepted timestamp', async () => {
    const command = baselineHarnessCommandFixture();
    const altered = { ...projection(command), acceptedAt: '2026-02-30T12:30:00.000Z' };

    await expect(
      revisions.create({
        projection: altered,
        commandFingerprint: harnessCommandFingerprint(command),
      }),
    ).resolves.toEqual({ kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' });
    await expect(
      database.collection(harnessRevisionsCollectionName).countDocuments({}),
    ).resolves.toBe(0);
  });

  it('does not persist an authorized H1 whose model field contains the current Grant bearer', async () => {
    const bearerSecret = 's'.repeat(43);
    const command = baselineHarnessCommandFixture(randomUUID(), bearerSecret);
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(
      harnessRoutes({
        access: {
          authorize: () =>
            Promise.resolve({
              kind: 'HarnessAccessAuthorized',
              owner: { ownerAid: taskOwnerAid, credentialSaid: `E${'b'.repeat(43)}` },
            }),
        },
        conversation: {
          admit: (input) =>
            admitBaselineHarness(input, {
              currentUserCredential: {
                verify: () => Promise.resolve({ kind: 'UserCredentialNotCurrent' }),
              },
              currentTaskMandate: {
                authorize: () => Promise.resolve({ kind: 'TaskNotFound' }),
              },
              revisions,
              now: () => '2026-09-24T12:30:00.000Z',
            }),
        },
        now: () => '2026-09-24T12:30:00.000Z',
        newCorrelationId: randomUUID,
      }),
    );

    const response = await server.inject({
      method: 'PUT',
      url: `/api/harness-revisions/${command.revision.d}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: command,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'HarnessRevisionRejected',
      reason: 'SecretDetected',
    });
    expect(await database.collection(harnessRevisionsCollectionName).countDocuments({})).toBe(0);
    await server.close();
  });

  it('preserves both command classes and their capability bindings through durable storage', async () => {
    const taskCommand = taskCommandFixture(undefined, undefined, undefined, undefined, [
      {
        capability: 'RunFormatter',
        id: 'format',
        argv: ['just', 'format'],
        timeoutSeconds: 30,
        expected: { kind: 'exitCode', code: 0 },
      },
      {
        capability: 'RunStaticAnalysis',
        id: 'analyze',
        argv: ['just', 'analyze'],
        timeoutSeconds: 45,
        expected: { kind: 'exitCode', code: 0 },
      },
    ]);
    const command = baselineHarnessCommandFixture(undefined, undefined, {
      ...harnessTask,
      revision: taskCommand.revision,
      revisionSaid: taskCommand.revision.d,
    });
    const accepted = projection(command);
    await expect(
      revisions.create({
        projection: accepted,
        commandFingerprint: harnessCommandFingerprint(command),
      }),
    ).resolves.toEqual({ kind: 'HarnessRevisionCreated' });
    const stored = await revisions.findAccepted(taskOwnerAid, accepted.revision.d);
    expect(stored).toMatchObject({ kind: 'AcceptedHarnessFound', projection: accepted });
    if (stored.kind !== 'AcceptedHarnessFound') throw new Error('Expected accepted harness');
    expect(stored.projection.revision.toolCommands).toHaveLength(2);
    expect(stored.projection.revision.completionCommands).toHaveLength(1);
  });

  it('fails closed when one stable command identity is reused for changed H1 content', async () => {
    const original = baselineHarnessCommandFixture();
    await revisions.create({
      projection: projection(original),
      commandFingerprint: harnessCommandFingerprint(original),
    });
    const changed = baselineHarnessCommandFixture(original.commandId, 'different-model');

    await expect(
      revisions.create({
        projection: projection(changed),
        commandFingerprint: harnessCommandFingerprint(changed),
      }),
    ).resolves.toEqual({ kind: 'HarnessCommandConflict' });
  });
});
