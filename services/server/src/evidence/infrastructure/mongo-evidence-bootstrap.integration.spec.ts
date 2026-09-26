import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEvidenceStream } from '@devrandom/domain';

import {
  evidenceCollectionContracts,
  evidenceCollectionNames,
  evidenceIndexDefinitions,
} from './evidence-storage-contract.js';
import {
  evidenceUsageInitialDocument,
  type EvidenceUsageDocument,
} from './evidence-usage-document.js';
import {
  EvidenceStorageDrift,
  MongoEvidenceBootstrap,
  evidenceEventCollectionValidator,
  previousEvidenceArtifactCollectionValidator,
  previousEvidenceCheckpointCollectionValidator,
  previousEvidenceEventCollectionValidator,
} from './mongo-evidence-bootstrap.js';
import {
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const integration = mongodbUri === undefined ? describe.skip : describe;

function indexName(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string'
  ) {
    throw new Error('MongoDB returned an index without a name');
  }
  return value.name;
}

integration('Mongo Evidence bootstrap', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(`devrandom_evidence_bootstrap_${randomUUID().replaceAll('-', '')}`);
  const bootstrap = new MongoEvidenceBootstrap(database);

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('creates the strict storage contract idempotently and refuses validator drift', async () => {
    await bootstrap.bootstrap();
    await bootstrap.bootstrap();

    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    expect(collections.map((collection) => collection.name).sort()).toEqual(
      evidenceCollectionContracts.map((contract) => contract.name).sort(),
    );
    for (const contract of evidenceCollectionContracts) {
      const indexes = await database.collection(contract.name).listIndexes().toArray();
      expect(indexes.map(indexName).sort()).toEqual(
        [
          '_id_',
          ...evidenceIndexDefinitions
            .filter((definition) => definition.collection === contract.name)
            .map((definition) => definition.name),
        ].sort(),
      );
    }
    await expect(
      database
        .collection<EvidenceUsageDocument>(evidenceCollectionNames.usage)
        .findOne({ _id: evidenceUsageInitialDocument._id }),
    ).resolves.toEqual(evidenceUsageInitialDocument);

    await database.command({
      collMod: evidenceCollectionNames.checkpoints,
      validator: previousEvidenceCheckpointCollectionValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await expect(bootstrap.verify()).rejects.toEqual(
      new EvidenceStorageDrift('EvidenceCheckpointCollection'),
    );
    await bootstrap.bootstrap();
    await expect(bootstrap.verify()).resolves.toBeUndefined();

    await database.command({
      collMod: evidenceCollectionNames.streams,
      validator: { $jsonSchema: { bsonType: 'object' } },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await expect(bootstrap.verify()).rejects.toEqual(
      new EvidenceStorageDrift('EvidenceStreamCollection'),
    );
  });

  it('upgrades only the prior wrong run index and preserves the first stream before a second insert', async () => {
    const migrationDatabase = client.db(`stream_migration_${randomUUID().replaceAll('-', '')}`);
    const migration = new MongoEvidenceBootstrap(migrationDatabase);
    const streams = migrationDatabase.collection<EvidenceStreamDocument>(
      evidenceCollectionNames.streams,
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    function stream(runId: string) {
      const created = createEvidenceStream({
        streamId: randomUUID(),
        runId,
        ownerAid: `E${'o'.repeat(43)}`,
        taskId: randomUUID(),
        taskRevisionSaid: `E${'t'.repeat(43)}`,
        incarnationId: randomUUID(),
        harnessRevisionSaid: `E${'h'.repeat(43)}`,
        personalAgentAid: `E${'p'.repeat(43)}`,
        taskMandateSaid: `E${'m'.repeat(43)}`,
        combinedByteCeiling: 1_024,
      });
      if (created.kind !== 'Created') throw new Error('expected stream fixture');
      return encodeEvidenceStreamDocument(created.stream);
    }

    try {
      await migration.bootstrap();
      await streams.dropIndex('evidence-stream-binding-run-unique');
      await streams.createIndex({ runId: 1 }, { name: 'evidence-stream-run-unique', unique: true });
      const first = stream(firstRunId);
      await streams.insertOne(first);
      await expect(migration.verify()).rejects.toEqual(
        new EvidenceStorageDrift('EvidenceStreamIndexes'),
      );

      await streams.createIndex({ unrecognized: 1 }, { name: 'unrecognized-stream-index' });
      await expect(migration.bootstrap()).rejects.toEqual(
        new EvidenceStorageDrift('EvidenceStreamIndexes'),
      );
      expect((await streams.listIndexes().toArray()).map(indexName)).not.toContain(
        'evidence-stream-binding-run-unique',
      );
      await streams.dropIndex('unrecognized-stream-index');

      await migration.bootstrap();
      await migration.verify();
      await streams.createIndex({ runId: 1 }, { name: 'evidence-stream-run-unique', unique: true });
      await migration.bootstrap();
      await migration.verify();
      expect(await streams.listIndexes().toArray()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'evidence-stream-binding-run-unique',
            key: { 'binding.runId': 1 },
            unique: true,
          }),
        ]),
      );
      expect((await streams.listIndexes().toArray()).map(indexName)).not.toContain(
        'evidence-stream-run-unique',
      );
      await expect(streams.findOne({ _id: first._id })).resolves.toEqual(first);
      const second = stream(secondRunId);
      await streams.insertOne(second);
      await expect(streams.countDocuments()).resolves.toBe(2);
      await expect(
        streams.insertOne({ ...stream(firstRunId), binding: { ...first.binding } }),
      ).rejects.toMatchObject({ code: 11_000 });
    } finally {
      await migrationDatabase.dropDatabase();
    }
  });

  it('upgrades the prior content-only artifact validator and creates the Run-content index', async () => {
    const migrationDatabase = client.db(`artifact_migration_${randomUUID().replaceAll('-', '')}`);
    const migration = new MongoEvidenceBootstrap(migrationDatabase);
    try {
      await migration.bootstrap();
      await migrationDatabase.command({
        collMod: evidenceCollectionNames.artifacts,
        validator: previousEvidenceArtifactCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(migration.verify()).rejects.toEqual(
        new EvidenceStorageDrift('EvidenceArtifactCollection'),
      );
      await migration.bootstrap();
      await migration.verify();
      expect(
        (
          await migrationDatabase
            .collection(evidenceCollectionNames.artifacts)
            .listIndexes()
            .toArray()
        ).map(indexName),
      ).toContain('evidence-artifact-run-content-unique');
    } finally {
      await migrationDatabase.dropDatabase();
    }
  });

  it('upgrades only the prior EffectFailed failure enum and refuses other event validator drift', async () => {
    const migrationDatabase = client.db(`event_migration_${randomUUID().replaceAll('-', '')}`);
    const migration = new MongoEvidenceBootstrap(migrationDatabase);
    const previous = structuredClone(evidenceEventCollectionValidator);
    let failures: unknown = previous;
    for (const key of [
      '$jsonSchema',
      'properties',
      'event',
      'properties',
      'event',
      'anyOf',
      10,
      'properties',
      'failure',
      'anyOf',
    ]) {
      if (failures === null || typeof failures !== 'object') {
        throw new Error('expected prior EffectFailed validator path');
      }
      failures = Reflect.get(failures, key) as unknown;
    }
    if (!Array.isArray(failures)) throw new Error('expected failure alternatives');
    const removed = failures.splice(4, 1);
    expect(removed).toEqual([{ enum: ['ArtifactUnavailable'], type: 'string' }]);
    expect(previous).toEqual(previousEvidenceEventCollectionValidator);

    try {
      await migration.bootstrap();
      await migrationDatabase.command({
        collMod: evidenceCollectionNames.events,
        validator: previous,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(migration.verify()).rejects.toEqual(
        new EvidenceStorageDrift('EvidenceEventCollection'),
      );
      await migration.bootstrap();
      await migration.verify();
      const observed = await migrationDatabase
        .listCollections({ name: evidenceCollectionNames.events }, { nameOnly: false })
        .next();
      expect(observed?.options?.validator).toEqual(evidenceEventCollectionValidator);

      await migrationDatabase.command({
        collMod: evidenceCollectionNames.events,
        validator: { $jsonSchema: { bsonType: 'object' } },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(migration.bootstrap()).rejects.toEqual(
        new EvidenceStorageDrift('EvidenceEventCollection'),
      );
    } finally {
      await migrationDatabase.dropDatabase();
    }
  });
});
