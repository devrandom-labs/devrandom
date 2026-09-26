import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  mandatePresentationIndexNames,
  mandatePresentationsCollectionName,
  MongoMandatePresentations,
} from './mongo-mandate-presentations.js';
import { MongoMandateBootstrap } from './mongo-mandate-bootstrap.js';
import type { MandatePresentation } from '../domain/presentation.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const integration = mongodbUri === undefined ? describe.skip : describe;

const presentation: MandatePresentation = {
  version: 1,
  binding: {
    ownerAid: `E${'a'.repeat(43)}`,
    userCredentialSaid: `E${'b'.repeat(43)}`,
    mandateKind: 'TaskMandate',
    credentialSaid: `E${'c'.repeat(43)}`,
    grantSaid: `E${'d'.repeat(43)}`,
    requestedAt: '2026-09-24T12:00:00.000Z',
    expiresAt: '2026-09-24T12:30:00.000Z',
  },
  acceptedReference: null,
  state: { kind: 'AwaitingGrant' },
};

integration('Mongo Mandate Presentation storage', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const databaseName = `dm_${randomUUID().replaceAll('-', '')}`;
  const database = client.db(databaseName);

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('bootstraps idempotently and verifies the exact retained storage contract', async () => {
    const bootstrap = new MongoMandateBootstrap(database);

    await expect(bootstrap.bootstrap()).resolves.toBeUndefined();
    await expect(bootstrap.bootstrap()).resolves.toBeUndefined();
    await expect(bootstrap.verify()).resolves.toBeUndefined();
  });

  it('reconciles the stable owner/credential/grant binding and commits by revision', async () => {
    const presentations = new MongoMandatePresentations(database);
    const created = await presentations.create(presentation);
    expect(created.kind).toBe('PresentationCreated');
    if (created.kind !== 'PresentationCreated') {
      return;
    }

    await expect(
      presentations.reconcile(
        presentation.binding.ownerAid,
        presentation.binding.credentialSaid,
        presentation.binding.grantSaid,
      ),
    ).resolves.toEqual({ kind: 'ExistingPresentation', stored: created.stored });
    await expect(
      presentations.reconcile(
        presentation.binding.ownerAid,
        presentation.binding.credentialSaid,
        `E${'e'.repeat(43)}`,
      ),
    ).resolves.toEqual({ kind: 'PresentationConflict' });

    const admitting = {
      ...presentation,
      state: { kind: 'Admitting' as const, operationName: 'operation.123' },
    };
    const committed = await presentations.commit(created.stored, admitting);
    expect(committed).toMatchObject({
      kind: 'PresentationCommitted',
      stored: { revision: 1, presentation: admitting },
    });
    await expect(presentations.commit(created.stored, admitting)).resolves.toEqual({
      kind: 'PresentationConcurrentlyModified',
    });
    if (committed.kind !== 'PresentationCommitted') {
      return;
    }
    const acceptedReference = {
      issueeAid: `E${'e'.repeat(43)}`,
      registryId: `E${'f'.repeat(43)}`,
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      taskRevisionSaid: `E${'g'.repeat(43)}`,
    };
    const admitted: MandatePresentation = {
      ...admitting,
      acceptedReference,
      state: {
        kind: 'Admitted',
        credentialSaid: presentation.binding.credentialSaid,
        admittedAt: '2026-09-24T12:02:00.000Z',
      },
    };
    await expect(presentations.commit(committed.stored, admitted)).resolves.toMatchObject({
      kind: 'PresentationCommitted',
      stored: { revision: 2, presentation: admitted },
    });
    await expect(
      presentations.findAdmittedTaskMandates(
        presentation.binding.ownerAid,
        acceptedReference.taskId,
        acceptedReference.taskRevisionSaid,
      ),
    ).resolves.toMatchObject({
      kind: 'AdmittedTaskMandatesFound',
      presentations: [{ revision: 2, presentation: admitted }],
    });
    await expect(
      presentations.findAdmittedTaskMandates(
        `E${'z'.repeat(43)}`,
        acceptedReference.taskId,
        acceptedReference.taskRevisionSaid,
      ),
    ).resolves.toEqual({ kind: 'NoAdmittedTaskMandate' });
  });

  it('rejects validator drift without repairing it during verification', async () => {
    const driftDatabase = client.db(`${databaseName}_validator_drift`);
    const bootstrap = new MongoMandateBootstrap(driftDatabase);
    const changedValidator = { $jsonSchema: { bsonType: 'object' } };
    try {
      await bootstrap.bootstrap();
      await driftDatabase.command({
        collMod: mandatePresentationsCollectionName,
        validator: changedValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });

      await expect(bootstrap.verify()).rejects.toMatchObject({
        name: 'MandateStorageDrift',
        resource: 'MandateCollection',
      });
      const observed = await driftDatabase
        .listCollections({ name: mandatePresentationsCollectionName }, { nameOnly: false })
        .next();
      if (observed === null || observed.options === undefined) {
        throw new Error('drifted collection options were not observable');
      }
      expect(observed.options.validator).toEqual(changedValidator);
    } finally {
      await driftDatabase.dropDatabase();
    }
  });

  it('rejects changed and missing named indexes without repairing during verification', async () => {
    const changedDatabase = client.db(`${databaseName}_index_drift`);
    const changedBootstrap = new MongoMandateBootstrap(changedDatabase);
    const changedCollection = changedDatabase.collection(mandatePresentationsCollectionName);
    const missingDatabase = client.db(`${databaseName}_missing_index`);
    const missingBootstrap = new MongoMandateBootstrap(missingDatabase);
    const missingCollection = missingDatabase.collection(mandatePresentationsCollectionName);
    try {
      await changedBootstrap.bootstrap();
      await changedCollection.dropIndex(mandatePresentationIndexNames.ownerCredential);
      await changedCollection.createIndex(
        { credentialSaid: 1 },
        { name: mandatePresentationIndexNames.ownerCredential },
      );
      await expect(changedBootstrap.verify()).rejects.toMatchObject({
        name: 'MandateStorageDrift',
        resource: 'MandateIndexes',
      });

      await missingBootstrap.bootstrap();
      await missingCollection.dropIndex(mandatePresentationIndexNames.pendingExpiry);
      await expect(missingBootstrap.verify()).rejects.toMatchObject({
        name: 'MandateStorageDrift',
        resource: 'MandateIndexes',
      });
      await expect(
        missingCollection.indexExists(mandatePresentationIndexNames.pendingExpiry),
      ).resolves.toBe(false);
    } finally {
      await Promise.all([changedDatabase.dropDatabase(), missingDatabase.dropDatabase()]);
    }
  });
});
