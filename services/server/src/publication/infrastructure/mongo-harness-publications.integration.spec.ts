import {
  preparePortableHarnessVerification,
  prepareEvidenceArtifact as preparePortableFixtureArtifact,
} from '@devrandom/protocol';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { prepareHarnessPackage, type PublishedHarness } from '@devrandom/protocol';
import { MongoPublicationBootstrap } from './mongo-publication-bootstrap.js';
import { MongoHarnessPublications } from './mongo-harness-publications.js';
const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
describe.skipIf(mongoUri === undefined)('Mongo publication custody', () => {
  it('reopens exact sanitized publication, reconciles lost ACK, rejects changed retry and exhausted owner budget', async () => {
    if (mongoUri === undefined) throw new Error('isolated Mongo URI required');
    const client = new MongoClient(mongoUri);
    await client.connect();
    const database = client.db(`publication_${randomUUID().replaceAll('-', '')}`);
    try {
      const bootstrap = new MongoPublicationBootstrap(database);
      await bootstrap.bootstrap();
      await bootstrap.bootstrap();
      await bootstrap.verify();
      const prepared = prepareHarnessPackage({
        publisherAid: `E${'a'.repeat(43)}`,
        sourceRevisionSaid: `E${'b'.repeat(43)}`,
        behavior: { kind: 'Instruction', text: 'Run public verification before completion.' },
      });
      if (prepared.kind !== 'Prepared') throw new Error('package');
      const verificationBytes = Buffer.from('{"kind":"PublicPortableFixture"}');
      const verificationArtifact = preparePortableFixtureArtifact(
        verificationBytes,
        'application/json',
      );
      if (verificationArtifact.kind !== 'Prepared') throw new Error('verification artifact');
      const verification = preparePortableHarnessVerification({
        packageSaid: prepared.package.d,
        checks: [
          'Sanitization',
          'CapabilityIsolation',
          'PortableBehavior',
          'FreshPublicVerification',
          'ProtectedRegression',
        ].map((name) => ({ name, evidenceSaid: verificationArtifact.artifact.d })),
        rawEvidence: [
          {
            artifact: verificationArtifact.artifact,
            bytesBase64Url: verificationBytes.toString('base64url'),
          },
        ],
      });
      if (verification.kind !== 'Prepared') throw new Error('verification');

      const published: PublishedHarness = {
        package: prepared.package,
        verification: verification.verification,
        signature: {
          exchange: {},
          signatures: ['A'.repeat(88)],
          keyStateSaid: `E${'c'.repeat(43)}`,
        },
      };
      const input = {
        ownerAid: prepared.package.publisherAid,
        commandId: randomUUID(),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        published,
      };
      const storage = new MongoHarnessPublications(client, database);
      expect(await storage.publish(input)).toEqual({
        kind: 'Published',
        packageSaid: prepared.package.d,
      });
      const reopened = new MongoHarnessPublications(client, database);
      expect(await reopened.publish(input)).toEqual({
        kind: 'AlreadyPublished',
        packageSaid: prepared.package.d,
      });
      expect(await reopened.read(prepared.package.d)).toEqual({ kind: 'Read', published });
      expect(await reopened.publish({ ...input, fingerprint: 'changed' })).toEqual({
        kind: 'Conflict',
      });
      expect(
        await database
          .collection<{ _id: string; count: number; bytes: number }>('harnessPublicationBudgets')
          .findOne({ _id: input.ownerAid }),
      ).toMatchObject({ count: 1 });
      await database
        .collection<{ _id: string; count: number; bytes: number }>('harnessPublicationBudgets')
        .updateOne({ _id: input.ownerAid }, { $set: { count: 128 } });
      expect(await reopened.publish({ ...input, commandId: randomUUID() })).toEqual({
        kind: 'Rejected',
      });
      expect(await reopened.publish(input)).toEqual({
        kind: 'AlreadyPublished',
        packageSaid: prepared.package.d,
      });
      const other = prepareHarnessPackage({
        publisherAid: `E${'d'.repeat(43)}`,
        sourceRevisionSaid: `E${'e'.repeat(43)}`,
        behavior: prepared.package.behavior,
      });
      if (other.kind !== 'Prepared') throw new Error('package');
      await database
        .collection<{ _id: string; count: number; bytes: number }>('harnessPublicationBudgets')
        .insertOne({ _id: other.package.publisherAid, count: 128, bytes: 0 });
      expect(
        await reopened.publish({
          ...input,
          ownerAid: other.package.publisherAid,
          commandId: randomUUID(),
          published: { ...published, package: other.package },
        }),
      ).toEqual({ kind: 'Rejected' });
      expect(await reopened.read(other.package.d)).toEqual({ kind: 'Absent' });
      expect(await database.collection('harnessPublications').countDocuments()).toBe(1);
      await expect(
        database.collection('harnessPublications').insertOne({ privateTask: 'forbidden' }),
      ).rejects.toThrow();
      await database.command({ collMod: 'harnessPublications', validationAction: 'warn' });
      await expect(bootstrap.verify()).rejects.toThrow('HarnessPublicationStorageDrift');
      await expect(bootstrap.bootstrap()).rejects.toThrow('HarnessPublicationStorageDrift');
      expect(
        (
          await database
            .listCollections({ name: 'harnessPublications' }, { nameOnly: false })
            .next()
        )?.options?.validationAction,
      ).toBe('warn');
    } finally {
      await database.dropDatabase();
      await client.close();
    }
  }, 30000);
});
