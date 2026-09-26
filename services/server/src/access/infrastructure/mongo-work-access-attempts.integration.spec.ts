import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CreateWorkAccessAttemptDependencies } from '../application/create-work-access-attempt.js';
import { observeWorkAccessAttempt } from '../application/observe-work-access-attempt.js';
import { submitWorkAccessProof } from '../application/submit-work-access-proof.js';
import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
  releaseWorkAccessGrant,
  workAccessCommandFingerprint,
  workAccessGrantSecretHash,
} from '../domain/work-access.js';
import {
  workAccessPolicy,
  workAccessPolicyForGrantLifetime,
} from '../domain/work-access-policy.js';
import { MongoWorkAccessAttempts } from './mongo-work-access-attempts.js';
import {
  MongoWorkAccessBootstrap,
  workAccessAttemptCollectionValidator,
} from './mongo-work-access-bootstrap.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const describeWithMongo = mongodbUri === undefined ? describe.skip : describe;
const databaseName = `work_access_${String(process.pid)}_${String(Date.now())}`;

describeWithMongo('Mongo Work Access Grant authorization', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(databaseName);
  const attempts = new MongoWorkAccessAttempts(database);
  const secret = Buffer.alloc(32, 7).toString('base64url');

  beforeAll(async () => {
    await client.connect();
    await new MongoWorkAccessBootstrap(database).bootstrap();
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('atomically debits the exact request budget and rejects scope and exhaustion without another effect', async () => {
    const command = {
      commandId: '33333333-3333-4333-8333-333333333333',
      clientInstanceId: '22222222-2222-4222-8222-222222222222',
      userAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
      grantSecretHash: workAccessGrantSecretHash(secret),
    } as const;
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);
    const awaiting = createAwaitingWorkAccessAttempt({
      ...command,
      attemptId: '11111111-1111-4111-8111-111111111111',
      issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
      challengeWords,
      createdAt: '2026-09-24T17:00:00.000Z',
      expiresAt: '2026-09-24T17:05:00.000Z',
    });
    const created = await attempts.create(awaiting, workAccessCommandFingerprint(command));
    if (created.kind !== 'AttemptCreated') {
      throw new Error(`expected a new attempt, received ${created.kind}`);
    }
    const verification = beginWorkAccessVerification(
      awaiting,
      'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'operation.challenge.verify.1',
    );
    if (verification.kind !== 'VerificationStarted') {
      throw new Error('expected verification to start');
    }
    const verifying = await attempts.commit(created.stored, verification.attempt);
    if (verifying.kind !== 'AttemptCommitted') {
      throw new Error(`expected verification commit, received ${verifying.kind}`);
    }
    const grant = grantWorkAccessAttempt(
      verifying.stored.attempt,
      ['CreateTask'],
      '2026-09-24T17:01:00.000Z',
      '2026-09-24T17:31:00.000Z',
      workAccessPolicy,
    );
    const granted = await attempts.commit(verifying.stored, grant);
    if (granted.kind !== 'AttemptCommitted') {
      throw new Error(`expected grant commit, received ${granted.kind}`);
    }
    const terminalDocument: unknown = await database
      .collection<{ readonly _id: string }>('workAccessAttempts')
      .findOne({ _id: awaiting.binding.attemptId });
    const encodedTerminalDocument = JSON.stringify(terminalDocument);
    expect(encodedTerminalDocument).toContain('"kind":"Granted"');
    expect(encodedTerminalDocument).not.toContain('challengeWords');
    expect(encodedTerminalDocument).not.toContain(secret);
    for (const word of challengeWords) {
      expect(encodedTerminalDocument).not.toContain(word);
    }

    await expect(
      attempts.authorizeGrant({
        grantSecretHash: command.grantSecretHash,
        scope: 'run:read',
        observedAt: '2026-09-24T17:02:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'GrantScopeRejected' });

    for (let request = 1; request <= workAccessPolicy.requestsPerGrant; request += 1) {
      const authorized = await attempts.authorizeGrant({
        grantSecretHash: command.grantSecretHash,
        scope: 'task:read',
        observedAt: '2026-09-24T17:02:00.000Z',
      });
      expect(authorized).toMatchObject({
        kind: 'GrantAuthorized',
        remainingRequests: workAccessPolicy.requestsPerGrant - request,
      });
    }

    await expect(
      attempts.authorizeGrant({
        grantSecretHash: command.grantSecretHash,
        scope: 'task:read',
        observedAt: '2026-09-24T17:02:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'GrantExhausted' });
    await expect(database.collection('workAccessAttempts').countDocuments()).resolves.toBe(1);
  }, 30_000);

  it('recovers lost create and proof responses from one retained attempt across repository instances', async () => {
    const recoveryDatabase = client.db(`${databaseName}_recovery`);
    await new MongoWorkAccessBootstrap(recoveryDatabase).bootstrap();
    const original = new MongoWorkAccessAttempts(recoveryDatabase);
    const restarted = new MongoWorkAccessAttempts(recoveryDatabase);
    const command = {
      commandId: randomUUID(),
      clientInstanceId: randomUUID(),
      userAid: `E${'u'.repeat(43)}`,
      credentialSaid: `E${'c'.repeat(43)}`,
      grantSecretHash: workAccessGrantSecretHash(secret),
    };
    const createdAt = new Date(Date.now() + 60_000).toISOString();
    const grantedAt = new Date(Date.parse(createdAt) + 60_000).toISOString();
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);
    const awaiting = createAwaitingWorkAccessAttempt({
      ...command,
      attemptId: randomUUID(),
      issuerRecipientAid: `E${'i'.repeat(43)}`,
      challengeWords,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(),
    });
    const fingerprint = workAccessCommandFingerprint(command);
    const responseSaid = `E${'r'.repeat(43)}`;
    const operationName = 'operation.challenge.verify.retained';
    const observeVerification = vi
      .fn<CreateWorkAccessAttemptDependencies['challenge']['observeVerification']>()
      .mockResolvedValueOnce({ kind: 'ChallengeVerificationPending' })
      .mockResolvedValue({ kind: 'ChallengeVerified' });
    const dependencies: CreateWorkAccessAttemptDependencies = {
      issuerRecipientAid: awaiting.binding.issuerRecipientAid,
      policy: workAccessPolicy,
      attempts: restarted,
      credential: {
        verify: () => Promise.resolve({ kind: 'CurrentCredential', claims: ['CreateTask'] }),
      },
      challenge: {
        issue: () => Promise.reject(new Error('must not issue another challenge')),
        beginVerification: () => Promise.reject(new Error('must not start another operation')),
        observeVerification,
        acknowledgeResponse: () => Promise.resolve({ kind: 'ChallengeAcknowledged' }),
        cleanupVerification: () => Promise.resolve({ kind: 'VerificationCleaned' }),
      },
      quota: { admit: () => ({ kind: 'AttemptQuotaAdmitted' }) },
      now: () => grantedAt,
      newAttemptId: () => randomUUID(),
    };
    try {
      const created = await original.create(awaiting, fingerprint);
      if (created.kind !== 'AttemptCreated') throw new Error('expected persisted first attempt');
      await expect(restarted.reconcileCommand(command, fingerprint)).resolves.toMatchObject({
        kind: 'ExistingAttempt',
        stored: { attempt: { binding: { attemptId: awaiting.binding.attemptId } } },
      });
      await expect(restarted.create(awaiting, fingerprint)).resolves.toMatchObject({
        kind: 'ExistingAttempt',
      });
      const substitutedSecret = {
        ...command,
        grantSecretHash: workAccessGrantSecretHash(Buffer.alloc(32, 8).toString('base64url')),
      };
      await expect(
        restarted.reconcileCommand(
          substitutedSecret,
          workAccessCommandFingerprint(substitutedSecret),
        ),
      ).resolves.toEqual({ kind: 'CommandConflict' });

      const verification = beginWorkAccessVerification(awaiting, responseSaid, operationName);
      if (verification.kind !== 'VerificationStarted') throw new Error('expected verification');
      await expect(original.commit(created.stored, verification.attempt)).resolves.toMatchObject({
        kind: 'AttemptCommitted',
      });
      const proof = {
        attemptId: awaiting.binding.attemptId,
        bearerSecret: secret,
        responseSaid,
      };
      await expect(submitWorkAccessProof(proof, dependencies)).resolves.toMatchObject({
        kind: 'ProofPending',
        attempt: { kind: 'VerifyingProof', responseSaid },
      });
      const poll = { attemptId: proof.attemptId, bearerSecret: secret };
      await expect(observeWorkAccessAttempt(poll, dependencies)).resolves.toMatchObject({
        kind: 'ProofPending',
      });
      await expect(observeWorkAccessAttempt(poll, dependencies)).resolves.toMatchObject({
        kind: 'AttemptObserved',
        attempt: { kind: 'Granted', verifiedResponseSaid: responseSaid },
      });
      expect(observeVerification).toHaveBeenCalledTimes(2);
      expect(observeVerification).toHaveBeenCalledWith({
        attemptId: proof.attemptId,
        sourceAid: command.userAid,
        recipientAid: awaiting.binding.issuerRecipientAid,
        challengeWords,
        responseSaid,
        operationName,
      });
      await expect(submitWorkAccessProof(proof, dependencies)).resolves.toMatchObject({
        kind: 'AttemptObserved',
        attempt: { kind: 'Granted', verifiedResponseSaid: responseSaid },
      });
      const fresh = new MongoWorkAccessAttempts(recoveryDatabase);
      await expect(fresh.reconcileCommand(command, fingerprint)).resolves.toMatchObject({
        kind: 'ExistingAttempt',
        stored: { attempt: { state: { kind: 'Granted', verifiedResponseSaid: responseSaid } } },
      });
      const collection = recoveryDatabase.collection('workAccessAttempts');
      await expect(collection.countDocuments({ commandId: command.commandId })).resolves.toBe(1);
      await expect(
        collection.countDocuments({
          grantSecretHash: command.grantSecretHash,
          'state.kind': 'Granted',
        }),
      ).resolves.toBe(1);
    } finally {
      await recoveryDatabase.dropDatabase();
    }
  }, 30_000);

  it('releases an expired grant slot before applying the two-active-grant limit', async () => {
    const loweredPolicy = workAccessPolicyForGrantLifetime(45);
    const loweredDatabase = client.db(`${databaseName}_lowered`);
    await new MongoWorkAccessBootstrap(loweredDatabase, loweredPolicy).bootstrap();
    const loweredAttempts = new MongoWorkAccessAttempts(loweredDatabase, loweredPolicy);
    const clientInstanceId = '99999999-9999-4999-8999-999999999999';
    const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
    const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
    const issuerRecipientAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

    async function storeGrant(index: 1 | 2 | 3, grantedAt: string) {
      const grantMilliseconds = Date.parse(grantedAt);
      const createdAt = new Date(grantMilliseconds - 5_000).toISOString();
      const command = {
        commandId: `33333333-3333-4333-8333-33333333333${String(index)}`,
        clientInstanceId,
        userAid,
        credentialSaid,
        grantSecretHash: workAccessGrantSecretHash(Buffer.alloc(32, index).toString('base64url')),
      };
      const awaiting = createAwaitingWorkAccessAttempt({
        ...command,
        attemptId: `11111111-1111-4111-8111-11111111111${String(index)}`,
        issuerRecipientAid,
        challengeWords,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(),
      });
      const created = await loweredAttempts.create(awaiting, workAccessCommandFingerprint(command));
      if (created.kind !== 'AttemptCreated') {
        throw new Error(`expected a new attempt, received ${created.kind}`);
      }
      const verification = beginWorkAccessVerification(
        awaiting,
        `E${String(index).repeat(43)}`,
        `operation.challenge.verify.${String(index)}`,
      );
      if (verification.kind !== 'VerificationStarted') {
        throw new Error('expected verification to start');
      }
      const verifying = await loweredAttempts.commit(created.stored, verification.attempt);
      if (verifying.kind !== 'AttemptCommitted') {
        throw new Error(`expected verification commit, received ${verifying.kind}`);
      }
      const grant = grantWorkAccessAttempt(
        verifying.stored.attempt,
        ['CreateTask'],
        grantedAt,
        new Date(grantMilliseconds + 45_000).toISOString(),
        loweredPolicy,
      );
      const granted = await loweredAttempts.commit(verifying.stored, grant);
      return granted.kind;
    }

    try {
      await expect(storeGrant(1, '2026-09-24T17:00:10.000Z')).resolves.toBe('AttemptCommitted');
      await expect(storeGrant(2, '2026-09-24T17:00:20.000Z')).resolves.toBe('AttemptCommitted');
      await expect(storeGrant(3, '2026-09-24T17:01:00.000Z')).resolves.toBe('AttemptCommitted');
    } finally {
      await loweredDatabase.dropDatabase();
    }
  });

  it('releases only one authenticated grant slot and admits a third command without evicting its peer', async () => {
    const releaseDatabase = client.db(`${databaseName}_release`);
    await new MongoWorkAccessBootstrap(releaseDatabase).bootstrap();
    const repository = new MongoWorkAccessAttempts(releaseDatabase);
    const createdAt = new Date(Date.now() + 60_000).toISOString();
    const grantedAt = new Date(Date.parse(createdAt) + 10_000).toISOString();
    const releasedAt = new Date(Date.parse(createdAt) + 20_000).toISOString();
    const userAid = `E${'u'.repeat(43)}`;
    const clientInstanceId = randomUUID();
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

    async function preparedGrant(index: number) {
      const bearerSecret = Buffer.alloc(32, index).toString('base64url');
      const command = {
        commandId: randomUUID(),
        clientInstanceId,
        userAid,
        credentialSaid: `E${'c'.repeat(43)}`,
        grantSecretHash: workAccessGrantSecretHash(bearerSecret),
      };
      const awaiting = createAwaitingWorkAccessAttempt({
        ...command,
        attemptId: randomUUID(),
        issuerRecipientAid: `E${'i'.repeat(43)}`,
        challengeWords,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(),
      });
      const created = await repository.create(awaiting, workAccessCommandFingerprint(command));
      if (created.kind !== 'AttemptCreated') throw new Error('expected created attempt');
      const verification = beginWorkAccessVerification(
        awaiting,
        `E${String(index).repeat(43)}`,
        `operation.challenge.verify.${String(index)}`,
      );
      if (verification.kind !== 'VerificationStarted') throw new Error('expected verification');
      const verifying = await repository.commit(created.stored, verification.attempt);
      if (verifying.kind !== 'AttemptCommitted') throw new Error('expected verifying commit');
      return {
        bearerSecret,
        verifying: verifying.stored,
        granted: grantWorkAccessAttempt(
          verifying.stored.attempt,
          ['CreateTask'],
          grantedAt,
          new Date(Date.parse(grantedAt) + 1_800_000).toISOString(),
          workAccessPolicy,
        ),
      };
    }

    try {
      const first = await preparedGrant(1);
      const firstCommit = await repository.commit(first.verifying, first.granted);
      const second = await preparedGrant(2);
      const secondCommit = await repository.commit(second.verifying, second.granted);
      if (firstCommit.kind !== 'AttemptCommitted' || secondCommit.kind !== 'AttemptCommitted') {
        throw new Error('expected two active grants');
      }
      const third = await preparedGrant(3);
      await expect(repository.commit(third.verifying, third.granted)).resolves.toEqual({
        kind: 'GrantCapacityExceeded',
      });
      const release = releaseWorkAccessGrant(firstCommit.stored.attempt, releasedAt);
      if (release.kind !== 'GrantReleased') throw new Error('expected lawful grant release');
      await expect(repository.commit(firstCommit.stored, release.attempt)).resolves.toMatchObject({
        kind: 'AttemptCommitted',
      });
      await expect(repository.commit(third.verifying, third.granted)).resolves.toMatchObject({
        kind: 'AttemptCommitted',
      });
      await expect(
        repository.authorizeGrant({
          grantSecretHash: workAccessGrantSecretHash(first.bearerSecret),
          scope: 'task:read',
          observedAt: releasedAt,
        }),
      ).resolves.toEqual({ kind: 'GrantReleased' });
      await expect(
        repository.authorizeGrant({
          grantSecretHash: workAccessGrantSecretHash(second.bearerSecret),
          scope: 'task:read',
          observedAt: releasedAt,
        }),
      ).resolves.toMatchObject({ kind: 'GrantAuthorized' });
      const collection = releaseDatabase.collection('workAccessAttempts');
      await expect(collection.countDocuments({ grantSlot: { $exists: true } })).resolves.toBe(2);
      await expect(
        collection.countDocuments({ 'state.disposition.kind': 'Released' }),
      ).resolves.toBe(1);
    } finally {
      await releaseDatabase.dropDatabase();
    }
  }, 30_000);

  it('admits only one of two concurrent proofs competing for the last grant slot', async () => {
    const raceDatabase = client.db(`${databaseName}_grant_race`);
    await new MongoWorkAccessBootstrap(raceDatabase).bootstrap();
    const preparation = new MongoWorkAccessAttempts(raceDatabase);
    const createdAt = new Date(Date.now() + 60_000).toISOString();
    const grantedAt = new Date(Date.parse(createdAt) + 10_000).toISOString();
    const userAid = `E${'u'.repeat(43)}`;
    const clientInstanceId = randomUUID();
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

    async function verifyingGrant(index: number) {
      const command = {
        commandId: randomUUID(),
        clientInstanceId,
        userAid,
        credentialSaid: `E${'c'.repeat(43)}`,
        grantSecretHash: workAccessGrantSecretHash(Buffer.alloc(32, index).toString('base64url')),
      };
      const awaiting = createAwaitingWorkAccessAttempt({
        ...command,
        attemptId: randomUUID(),
        issuerRecipientAid: `E${'i'.repeat(43)}`,
        challengeWords,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(),
      });
      const created = await preparation.create(awaiting, workAccessCommandFingerprint(command));
      if (created.kind !== 'AttemptCreated') throw new Error('expected created attempt');
      const verification = beginWorkAccessVerification(
        awaiting,
        `E${String(index).repeat(43)}`,
        `operation.challenge.verify.race.${String(index)}`,
      );
      if (verification.kind !== 'VerificationStarted') throw new Error('expected verification');
      const verifying = await preparation.commit(created.stored, verification.attempt);
      if (verifying.kind !== 'AttemptCommitted') throw new Error('expected verifying commit');
      return {
        stored: verifying.stored,
        grant: grantWorkAccessAttempt(
          verifying.stored.attempt,
          ['CreateTask'],
          grantedAt,
          new Date(Date.parse(grantedAt) + 1_800_000).toISOString(),
          workAccessPolicy,
        ),
      };
    }

    try {
      const incumbent = await verifyingGrant(1);
      await expect(preparation.commit(incumbent.stored, incumbent.grant)).resolves.toMatchObject({
        kind: 'AttemptCommitted',
      });
      const contenders = await Promise.all([verifyingGrant(2), verifyingGrant(3)]);
      const outcomes = await Promise.all(
        contenders.map(({ stored, grant }) =>
          new MongoWorkAccessAttempts(raceDatabase).commit(stored, grant),
        ),
      );
      expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
        'AttemptCommitted',
        'GrantCapacityExceeded',
      ]);
      const loser = contenders[outcomes.findIndex(({ kind }) => kind === 'GrantCapacityExceeded')];
      if (loser === undefined) throw new Error('expected losing proof');
      const collection = raceDatabase.collection<{ readonly _id: string }>('workAccessAttempts');
      await expect(collection.countDocuments({ grantSlot: { $exists: true } })).resolves.toBe(2);
      await expect(
        collection.countDocuments({
          _id: loser.stored.attempt.binding.attemptId,
          'state.kind': 'VerifyingProof',
          grantSlot: { $exists: false },
        }),
      ).resolves.toBe(1);
    } finally {
      await raceDatabase.dropDatabase();
    }
  }, 30_000);

  it('migrates only known prior grant validators and rejects unknown collection drift', async () => {
    const migrationDatabase = client.db(`${databaseName}_release_migration`);
    const activationScopeDatabase = client.db(`${databaseName}_activation_scope_migration`);
    const driftDatabase = client.db(`${databaseName}_release_unknown_drift`);
    const currentState = workAccessAttemptCollectionValidator.$jsonSchema.properties.state;
    const currentGrant = currentState.oneOf[2];
    if (currentGrant?.properties.disposition === undefined) {
      throw new Error('expected current grant validator');
    }
    const previousValidator = {
      $jsonSchema: {
        ...workAccessAttemptCollectionValidator.$jsonSchema,
        properties: {
          ...workAccessAttemptCollectionValidator.$jsonSchema.properties,
          state: {
            ...currentState,
            oneOf: [
              currentState.oneOf[0],
              currentState.oneOf[1],
              {
                ...currentGrant,
                properties: {
                  ...currentGrant.properties,
                  disposition: {
                    ...currentGrant.properties.disposition,
                    oneOf: currentGrant.properties.disposition.oneOf.filter(
                      (alternative) => alternative.properties.kind.enum[0] !== 'Released',
                    ),
                  },
                },
              },
              currentState.oneOf[3],
              currentState.oneOf[4],
            ],
          },
        },
      },
    };
    const previousActivationScopeValidator = {
      $jsonSchema: {
        ...workAccessAttemptCollectionValidator.$jsonSchema,
        properties: {
          ...workAccessAttemptCollectionValidator.$jsonSchema.properties,
          state: {
            ...currentState,
            oneOf: [
              currentState.oneOf[0],
              currentState.oneOf[1],
              {
                ...currentGrant,
                properties: {
                  ...currentGrant.properties,
                  scopes: {
                    ...currentGrant.properties.scopes,
                    maxItems: 15,
                    items: {
                      enum: currentGrant.properties.scopes.items.enum.filter(
                        (scope) => scope !== 'activation:commit',
                      ),
                    },
                  },
                },
              },
              currentState.oneOf[3],
              currentState.oneOf[4],
            ],
          },
        },
      },
    };
    try {
      await migrationDatabase.createCollection('workAccessAttempts', {
        validator: previousValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      const bootstrap = new MongoWorkAccessBootstrap(migrationDatabase);
      await expect(bootstrap.verify()).rejects.toThrow();
      await expect(bootstrap.bootstrap()).resolves.toBeUndefined();
      await expect(bootstrap.verify()).resolves.toBeUndefined();
      const migrated = await migrationDatabase
        .listCollections({ name: 'workAccessAttempts' }, { nameOnly: false })
        .next();
      expect(migrated?.options?.validator).toEqual(workAccessAttemptCollectionValidator);

      await activationScopeDatabase.createCollection('workAccessAttempts', {
        validator: previousActivationScopeValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      const activationBootstrap = new MongoWorkAccessBootstrap(activationScopeDatabase);
      await expect(activationBootstrap.verify()).rejects.toThrow();
      await expect(activationBootstrap.bootstrap()).resolves.toBeUndefined();
      await expect(activationBootstrap.verify()).resolves.toBeUndefined();
      const migratedActivation = await activationScopeDatabase
        .listCollections({ name: 'workAccessAttempts' }, { nameOnly: false })
        .next();
      expect(migratedActivation?.options?.validator).toEqual(workAccessAttemptCollectionValidator);

      const unknownValidator = { $jsonSchema: { bsonType: 'object' } } as const;
      await driftDatabase.createCollection('workAccessAttempts', {
        validator: unknownValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(new MongoWorkAccessBootstrap(driftDatabase).bootstrap()).rejects.toThrow();
      const unchanged = await driftDatabase
        .listCollections({ name: 'workAccessAttempts' }, { nameOnly: false })
        .next();
      expect(unchanged?.options?.validator).toEqual(unknownValidator);
    } finally {
      await migrationDatabase.dropDatabase();
      await activationScopeDatabase.dropDatabase();
      await driftDatabase.dropDatabase();
    }
  }, 30_000);

  it('releases all expired nonterminal slots before admitting a new attempt under concurrent demand', async () => {
    const capacityDatabase = client.db(`${databaseName}_capacity`);
    await new MongoWorkAccessBootstrap(capacityDatabase).bootstrap();
    const capacityAttempts = new MongoWorkAccessAttempts(capacityDatabase);
    const createdAt = new Date(Date.now() + 60_000).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 300_000).toISOString();
    const sharedUserAid = `E${'u'.repeat(43)}`;
    const sharedClientInstanceId = randomUUID();
    const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);
    const createAttempt = (index: number, at: string) => {
      const command = {
        commandId: randomUUID(),
        clientInstanceId: index < 2 || index === 32 ? sharedClientInstanceId : randomUUID(),
        userAid: index < 2 || index === 32 ? sharedUserAid : `E${String(index).padStart(43, 'a')}`,
        credentialSaid: `E${'c'.repeat(43)}`,
        grantSecretHash: workAccessGrantSecretHash(
          Buffer.alloc(32, index + 1).toString('base64url'),
        ),
      };
      const attempt = createAwaitingWorkAccessAttempt({
        ...command,
        attemptId: randomUUID(),
        issuerRecipientAid: `E${'i'.repeat(43)}`,
        challengeWords,
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + 300_000).toISOString(),
      });
      return capacityAttempts.create(attempt, workAccessCommandFingerprint(command));
    };

    try {
      const initial = await Promise.all(
        Array.from({ length: 32 }, (_, index) => createAttempt(index, createdAt)),
      );
      expect(initial.map((outcome) => outcome.kind)).toEqual(
        Array.from({ length: 32 }, () => 'AttemptCreated'),
      );
      await expect(createAttempt(32, createdAt)).resolves.toMatchObject({
        kind: 'AttemptCapacityExceeded',
      });
      await expect(createAttempt(33, createdAt)).resolves.toMatchObject({
        kind: 'AttemptCapacityExceeded',
      });
      await expect(createAttempt(32, expiresAt)).resolves.toMatchObject({
        kind: 'AttemptCreated',
      });
      const collection = capacityDatabase.collection('workAccessAttempts');
      await expect(collection.countDocuments({ 'state.kind': 'Expired' })).resolves.toBe(32);
      await expect(collection.countDocuments({ attemptSlot: { $exists: true } })).resolves.toBe(1);
      await expect(
        collection.countDocuments({ globalAttemptSlot: { $exists: true } }),
      ).resolves.toBe(1);
    } finally {
      await capacityDatabase.dropDatabase();
    }
  }, 30_000);
});
