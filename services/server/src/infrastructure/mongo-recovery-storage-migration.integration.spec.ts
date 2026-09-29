import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { describe, it, expect } from 'vitest';
import {
  MongoRecoveryStorageMigration,
  recoveryStorageMigrationCatalog,
} from './mongo-recovery-storage-migration.js';
import { MongoRunBootstrap } from '../run/infrastructure/mongo-run-bootstrap.js';
import { MongoTaskBootstrap } from '../task/infrastructure/mongo-task-bootstrap.js';
import { MongoHarnessBootstrap } from '../harness/infrastructure/mongo-harness-bootstrap.js';
import { MongoEvidenceBootstrap } from '../evidence/infrastructure/mongo-evidence-bootstrap.js';
import { encodeRunDocument, type RunDocument } from '../run/infrastructure/run-document.js';
import { runFixture } from '../run/test/run-fixture.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const integration = uri === undefined ? describe.skip : describe;
integration('explicit recovery storage migration inspection', () => {
  it('plans only exact ten-to-sixteen validators and sixth owner slot while preserving documents and indexes', async () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`devrandom_sixteen_migration_${randomUUID().replaceAll('-', '')}`);
    try {
      await client.connect();
      const bootstraps = [
        new MongoRunBootstrap(db),
        new MongoTaskBootstrap(db),
        new MongoHarnessBootstrap(db),
        new MongoEvidenceBootstrap(db),
      ];
      for (const bootstrap of bootstraps) await bootstrap.bootstrap();
      const stored = encodeRunDocument(runFixture(), `sha256:${'a'.repeat(64)}`);
      await db.collection<RunDocument>('runs').insertOne(stored);
      for (const entry of recoveryStorageMigrationCatalog)
        await db.command({ collMod: entry.name, validator: entry.previousValidator });
      await expect(new MongoRunBootstrap(db).verify()).rejects.toThrow();
      const inspector = new MongoRecoveryStorageMigration(db);
      const prepared = await inspector.inspect();
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') throw new Error('migration plan');
      expect(prepared.collections.map((entry) => entry.disposition)).toEqual(
        Array(4).fill('RequiresMigration'),
      );
      expect(prepared.collections.find((entry) => entry.name === 'runs')?.documentCount).toBe(1);
      // Inspection must leave the old strict validator in place.
      await expect(new MongoRunBootstrap(db).verify()).rejects.toThrow();
      for (const entry of prepared.collections)
        await db.command({ collMod: entry.name, validator: entry.targetValidator });
      for (const bootstrap of bootstraps) await bootstrap.verify();
      const after = await inspector.inspect();
      expect(after.kind).toBe('Prepared');
      if (after.kind !== 'Prepared') throw new Error('current inspection');
      expect(after.collections.map((entry) => entry.disposition)).toEqual(Array(4).fill('Current'));
      expect(
        after.collections.map((entry) => [
          entry.name,
          entry.documentCount,
          entry.documentHash,
          entry.indexes,
        ]),
      ).toEqual(
        prepared.collections.map((entry) => [
          entry.name,
          entry.documentCount,
          entry.documentHash,
          entry.indexes,
        ]),
      );
      expect(await db.collection<RunDocument>('runs').findOne({ _id: stored._id })).toEqual(stored);
      await db.command({ collMod: 'runs', validator: { $jsonSchema: { bsonType: 'object' } } });
      expect(await inspector.inspect()).toMatchObject({
        kind: 'Rejected',
        collection: 'runs',
        reason: 'ValidatorDrift',
      });
      const runEntry = recoveryStorageMigrationCatalog.find((entry) => entry.name === 'runs');
      if (runEntry === undefined) throw new Error('Run validator');
      await db.command({ collMod: 'runs', validator: runEntry.targetValidator });
      await db.collection('runs').createIndex({ unexpected: 1 }, { name: 'unexpected-index' });
      expect(await inspector.inspect()).toMatchObject({
        kind: 'Rejected',
        collection: 'runs',
        reason: 'IndexDrift',
      });
      await db.collection('runs').dropIndex('unexpected-index');
      await db
        .collection<RunDocument>('runs')
        .updateOne(
          { _id: stored._id },
          { $set: { 'binding.budget.runsPerAdmittedUser': 17 } },
          { bypassDocumentValidation: true },
        );
      expect(await inspector.inspect()).toMatchObject({
        kind: 'Rejected',
        collection: 'runs',
        reason: 'DocumentInvalid',
      });
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  });
});
