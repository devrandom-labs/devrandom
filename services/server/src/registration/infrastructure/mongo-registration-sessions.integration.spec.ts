import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approveRegistration,
  createRegistrationSession,
  rejectRegistration,
  submitAidProof,
} from '../domain/registration-session.js';
import { MongoRegistrationSessions } from './mongo-registration-sessions.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const describeWithMongo = mongodbUri === undefined ? describe.skip : describe;

const createdAt = Date.parse('2026-09-24T16:00:00.000Z');
const expiresAt = createdAt + 60_000;
const testUserAid = 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz';
const testIssuerAid = 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk';

function testSaid(label: string): string {
  return `E${createHash('sha256').update(label).digest('base64url').slice(0, 43)}`;
}

function pending(label: string) {
  const registrationId = createHash('sha256').update(label).digest('hex').slice(0, 32);
  return createRegistrationSession({
    registrationId,
    protocolVersion: '1',
    userAid: testUserAid,
    userAgentOobi: `http://keria.example/oobi/${testUserAid}/agent/EAgent`,
    issuerAid: testIssuerAid,
    challengeWords: ['amber', 'cabin', registrationId],
    cliCapabilityHash: createHash('sha256').update(`${registrationId}-cli`).digest('hex'),
    browserCapabilityHash: createHash('sha256').update(`${registrationId}-browser`).digest('hex'),
    createdAt,
    expiresAt,
  });
}

describeWithMongo('Mongo Registration Session repository', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017');
  const databaseName = `registration_${process.pid.toString()}_${Date.now().toString()}`;
  const sessions = new MongoRegistrationSessions(client.db(databaseName), 300_000);

  async function persist(session: ReturnType<typeof pending>) {
    const creation = await sessions.create(
      session,
      createHash('sha256').update(session.binding.registrationId).digest('hex'),
    );
    if (creation.kind !== 'registration-created') {
      throw new Error('test Registration Session already exists');
    }
    return { revision: creation.revision, session: creation.session };
  }

  beforeAll(async () => {
    await client.connect();
    await sessions.bootstrap();
  });

  afterAll(async () => {
    await client.db(databaseName).dropDatabase();
    await client.close();
  });

  it('durably round-trips one lawful session and provisions replay and TTL indexes', async () => {
    const session = pending('registration-roundtrip');
    const creation = await sessions.create(
      session,
      createHash('sha256').update(session.binding.registrationId).digest('hex'),
    );
    const created = { revision: creation.revision, session: creation.session };

    expect(creation).toMatchObject({ kind: 'registration-created', revision: 0, session });
    await expect(sessions.retrieve(session.binding.registrationId, createdAt)).resolves.toEqual(
      created,
    );

    const indexes = await client.db(databaseName).collection('registration_sessions').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'registration-expiry', expireAfterSeconds: 0 }),
        expect.objectContaining({ name: 'registration-creation-key', unique: true }),
        expect.objectContaining({ name: 'registration-proof-response', unique: true }),
      ]),
    );
    const collection = await client
      .db(databaseName)
      .listCollections({ name: 'registration_sessions' })
      .next();
    if (collection === null || !('options' in collection)) {
      throw new Error('registration collection metadata is unavailable');
    }
    expect(collection.options).toEqual({
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'revision', 'session', 'creationKeyHash', 'purgeAt'],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string' },
            revision: { bsonType: 'int', minimum: 0 },
            session: { bsonType: 'string' },
            creationKeyHash: {
              bsonType: 'string',
              pattern: '^[a-f0-9]{64}$',
            },
            proofResponseSaid: { bsonType: 'string' },
            purgeAt: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  });

  it('bootstraps idempotently without replacing an existing PRD 01 session', async () => {
    const migrationDatabaseName = `${databaseName}_migration`;
    const migrationDatabase = client.db(migrationDatabaseName);
    const migrationSessions = new MongoRegistrationSessions(migrationDatabase, 300_000);
    const session = pending('registration-storage-migration');
    const creationKeyHash = createHash('sha256')
      .update(session.binding.registrationId)
      .digest('hex');

    await migrationSessions.create(session, creationKeyHash);
    await migrationSessions.bootstrap();
    await migrationSessions.bootstrap();

    await expect(
      migrationSessions.retrieve(session.binding.registrationId, createdAt),
    ).resolves.toMatchObject({ revision: 0, session });
    await expect(
      migrationDatabase.collection('registration_sessions').countDocuments(),
    ).resolves.toBe(1);
    await expect(migrationSessions.verify()).resolves.toBeUndefined();
    await migrationDatabase.dropDatabase();
  });

  it('keeps verification read-only when a legacy collection lacks its validator', async () => {
    const legacyDatabaseName = `${databaseName}_legacy`;
    const legacyDatabase = client.db(legacyDatabaseName);
    await legacyDatabase.createCollection('registration_sessions');
    const legacySessions = new MongoRegistrationSessions(legacyDatabase, 300_000);

    await expect(legacySessions.verify()).rejects.toMatchObject({
      detail: {
        kind: 'registration-storage-drift',
        conflict: { kind: 'collection-validator-missing' },
      },
    });
    const collection = await legacyDatabase
      .listCollections({ name: 'registration_sessions' })
      .next();
    if (collection === null || !('options' in collection)) {
      throw new Error('legacy registration collection metadata is unavailable');
    }
    expect(collection.options).toEqual({});
    await expect(
      legacyDatabase.collection('registration_sessions').indexExists('registration-expiry'),
    ).resolves.toBe(false);
    await legacyDatabase.dropDatabase();
  });

  it('fails closed without replacing an incompatible validator', async () => {
    const driftDatabaseName = `${databaseName}_validator_drift`;
    const driftDatabase = client.db(driftDatabaseName);
    const incompatibleValidator = { $jsonSchema: { bsonType: 'object' } };
    await driftDatabase.createCollection('registration_sessions', {
      validator: incompatibleValidator,
    });
    const before = await driftDatabase.listCollections({ name: 'registration_sessions' }).next();
    if (before === null || !('options' in before)) {
      throw new Error('registration collection drift metadata is unavailable');
    }
    const driftSessions = new MongoRegistrationSessions(driftDatabase, 300_000);

    await expect(driftSessions.bootstrap()).rejects.toMatchObject({
      detail: {
        kind: 'registration-storage-drift',
        conflict: { kind: 'collection-validator-conflict' },
      },
    });
    const collection = await driftDatabase
      .listCollections({ name: 'registration_sessions' })
      .next();
    if (collection === null || !('options' in collection)) {
      throw new Error('registration collection metadata is unavailable after drift rejection');
    }
    expect(collection.options).toEqual(before.options);
    await driftDatabase.dropDatabase();
  });

  it('fails closed without replacing a conflicting named index', async () => {
    const driftDatabaseName = `${databaseName}_index_drift`;
    const driftDatabase = client.db(driftDatabaseName);
    const collection = driftDatabase.collection('registration_sessions');
    await collection.createIndex(
      { creationKeyHash: 1 },
      { name: 'registration-expiry', unique: true },
    );
    const driftSessions = new MongoRegistrationSessions(driftDatabase, 300_000);

    await expect(driftSessions.bootstrap()).rejects.toMatchObject({
      detail: {
        kind: 'registration-storage-drift',
        conflict: {
          kind: 'index-definition-conflict',
          indexName: 'registration-expiry',
        },
      },
    });
    const indexes = await collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'registration-expiry',
          key: { creationKeyHash: 1 },
          unique: true,
        }),
      ]),
    );
    await driftDatabase.dropDatabase();
  });

  it('does not recreate a missing index during read-only verification', async () => {
    const driftDatabaseName = `${databaseName}_missing_index`;
    const driftDatabase = client.db(driftDatabaseName);
    const driftSessions = new MongoRegistrationSessions(driftDatabase, 300_000);
    await driftSessions.bootstrap();
    await driftDatabase
      .collection('registration_sessions')
      .dropIndex('registration-proof-response');

    await expect(driftSessions.verify()).rejects.toMatchObject({
      detail: {
        kind: 'registration-storage-drift',
        conflict: {
          kind: 'index-missing',
          indexName: 'registration-proof-response',
        },
      },
    });
    await expect(
      driftDatabase.collection('registration_sessions').indexExists('registration-proof-response'),
    ).resolves.toBe(false);
    await driftDatabase.dropDatabase();
  });

  it('returns one durable session for concurrent use of the same creation key', async () => {
    const creationKeyHash = createHash('sha256').update('equivalent-create').digest('hex');
    const firstSession = pending('registration-idempotent-first');
    const competingSession = pending('registration-idempotent-competing');

    const first = await sessions.create(firstSession, creationKeyHash);
    const retry = await sessions.create(competingSession, creationKeyHash);

    expect(first).toMatchObject({ kind: 'registration-created', session: firstSession });
    expect(retry).toMatchObject({
      kind: 'registration-already-created',
      session: firstSession,
    });
    await expect(
      sessions.retrieveByCreationKeyHash(creationKeyHash, createdAt),
    ).resolves.toMatchObject({ session: firstSession });
    await expect(
      client
        .db(databaseName)
        .collection('registration_sessions')
        .countDocuments({ creationKeyHash }),
    ).resolves.toBe(1);
  });

  it('accepts one compare-and-swap transition and reports a concurrent retry', async () => {
    const initial = await persist(pending('registration-cas'));
    const first = approveRegistration(initial.session, {
      contactEmail: 'first@example.com',
      approvedAt: createdAt + 1_000,
    });
    const second = approveRegistration(initial.session, {
      contactEmail: 'second@example.com',
      approvedAt: createdAt + 1_000,
    });

    await expect(sessions.commit(initial, first)).resolves.toMatchObject({
      kind: 'registration-committed',
      snapshot: { revision: 1, session: first },
    });
    await expect(sessions.commit(initial, second)).resolves.toEqual({
      kind: 'registration-concurrently-modified',
    });
  });

  it('durably advances a proved session through browser approval', async () => {
    const initial = await persist(pending('registration-proved-approval'));
    const proved = submitAidProof(initial.session, {
      registrationId: initial.session.binding.registrationId,
      sourceAid: initial.session.binding.userAid,
      recipientAid: initial.session.binding.issuerAid,
      challengeWords: initial.session.binding.challengeWords,
      responseSaid: testSaid('approval-response'),
      acceptedAt: createdAt + 1_000,
    });
    const proofCommit = await sessions.commit(initial, proved);
    if (proofCommit.kind !== 'registration-committed') {
      throw new Error('proof commit did not succeed');
    }
    const approved = approveRegistration(proofCommit.snapshot.session, {
      contactEmail: 'browser@example.test',
      approvedAt: createdAt + 2_000,
    });

    await expect(sessions.commit(proofCommit.snapshot, approved)).resolves.toMatchObject({
      kind: 'registration-committed',
      snapshot: {
        revision: 2,
        session: {
          kind: 'approved',
          approval: { contactEmail: 'browser@example.test', approvedAt: createdAt + 2_000 },
        },
      },
    });
  });

  it('rejects reuse of one response SAID by another Registration Session', async () => {
    const first = await persist(pending('registration-proof-one'));
    const second = await persist(pending('registration-proof-two'));
    const firstProof = submitAidProof(first.session, {
      registrationId: first.session.binding.registrationId,
      sourceAid: first.session.binding.userAid,
      recipientAid: first.session.binding.issuerAid,
      challengeWords: first.session.binding.challengeWords,
      responseSaid: testSaid('one-time-response'),
      acceptedAt: createdAt + 1_000,
    });
    const replayedProof = submitAidProof(second.session, {
      registrationId: second.session.binding.registrationId,
      sourceAid: second.session.binding.userAid,
      recipientAid: second.session.binding.issuerAid,
      challengeWords: second.session.binding.challengeWords,
      responseSaid: testSaid('one-time-response'),
      acceptedAt: createdAt + 1_000,
    });

    await expect(sessions.commit(first, firstProof)).resolves.toMatchObject({
      kind: 'registration-committed',
    });
    await expect(sessions.commit(second, replayedProof)).resolves.toEqual({
      kind: 'registration-proof-replayed',
    });
  });

  it('enforces expiry on retrieval independently of TTL cleanup', async () => {
    const initial = await persist(pending('registration-expired'));
    const observed = await sessions.retrieve(initial.session.binding.registrationId, expiresAt);

    expect(observed).toMatchObject({
      revision: 1,
      session: { kind: 'expired', expiredAt: expiresAt },
    });
  });

  it('retains a consumed proof response after terminal rejection', async () => {
    const initial = await persist(pending('registration-rejected-proof'));
    const proved = submitAidProof(initial.session, {
      registrationId: initial.session.binding.registrationId,
      sourceAid: initial.session.binding.userAid,
      recipientAid: initial.session.binding.issuerAid,
      challengeWords: initial.session.binding.challengeWords,
      responseSaid: testSaid('retained-response'),
      acceptedAt: createdAt + 1_000,
    });
    const proofCommit = await sessions.commit(initial, proved);
    if (proofCommit.kind !== 'registration-committed') {
      throw new Error('proof commit did not succeed');
    }
    const rejected = rejectRegistration(proofCommit.snapshot.session, {
      rejection: { kind: 'browser-declined' },
      rejectedAt: createdAt + 2_000,
    });
    const rejectionCommit = await sessions.commit(proofCommit.snapshot, rejected);
    expect(rejectionCommit).toMatchObject({ kind: 'registration-committed' });

    const replay = await persist(pending('registration-replay-after-rejection'));
    const replayedProof = submitAidProof(replay.session, {
      registrationId: replay.session.binding.registrationId,
      sourceAid: replay.session.binding.userAid,
      recipientAid: replay.session.binding.issuerAid,
      challengeWords: replay.session.binding.challengeWords,
      responseSaid: testSaid('retained-response'),
      acceptedAt: createdAt + 3_000,
    });
    await expect(sessions.commit(replay, replayedProof)).resolves.toEqual({
      kind: 'registration-proof-replayed',
    });
  });

  it('rejects proof replay metadata that disagrees with an active session proof', async () => {
    const initial = await persist(pending('registration-proof-metadata'));
    const proved = submitAidProof(initial.session, {
      registrationId: initial.session.binding.registrationId,
      sourceAid: initial.session.binding.userAid,
      recipientAid: initial.session.binding.issuerAid,
      challengeWords: initial.session.binding.challengeWords,
      responseSaid: testSaid('expected-proof-metadata'),
      acceptedAt: createdAt + 1_000,
    });
    await sessions.commit(initial, proved);
    await client
      .db(databaseName)
      .collection<{ readonly _id: string; readonly proofResponseSaid?: string }>(
        'registration_sessions',
      )
      .updateOne(
        { _id: initial.session.binding.registrationId },
        { $set: { proofResponseSaid: testSaid('conflicting-proof-metadata') } },
      );

    await expect(
      sessions.retrieve(initial.session.binding.registrationId, createdAt + 2_000),
    ).rejects.toMatchObject({
      detail: { kind: 'registration-document-invalid' },
    });
  });
});
