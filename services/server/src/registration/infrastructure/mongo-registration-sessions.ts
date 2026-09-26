import { isDeepStrictEqual } from 'node:util';

import { MongoServerError, type Collection, type Db, type WithId } from 'mongodb';

import {
  observeRegistrationSession,
  type RegistrationSession,
} from '../domain/registration-session.js';
import type {
  RegistrationCommit,
  RegistrationCreation,
  RegistrationSessions,
  RegistrationSnapshot,
} from '../application/registration-enrollment.js';
import {
  decodeRegistrationSessionDocument,
  encodeRegistrationSessionDocument,
  RegistrationSessionDocumentFailure,
} from './registration-session-document.js';

interface RegistrationSessionDocument {
  readonly _id: string;
  readonly revision: number;
  readonly session: string;
  readonly creationKeyHash: string;
  readonly proofResponseSaid?: string;
  readonly purgeAt: Date;
}

export type RegistrationRepositoryError =
  | { readonly kind: 'registration-already-exists'; readonly registrationId: string }
  | { readonly kind: 'registration-document-invalid'; readonly reason: string }
  | {
      readonly kind: 'registration-storage-drift';
      readonly conflict: RegistrationStorageConflict;
    }
  | {
      readonly kind: 'registration-storage-unavailable';
      readonly operation: RegistrationStorageOperation;
    };

export type RegistrationStorageConflict =
  | { readonly kind: 'collection-missing' }
  | { readonly kind: 'collection-validator-missing' }
  | { readonly kind: 'collection-validator-conflict' }
  | { readonly kind: 'index-metadata-invalid' }
  | { readonly kind: 'index-missing'; readonly indexName: RegistrationIndexName }
  | {
      readonly kind: 'index-definition-conflict';
      readonly indexName: RegistrationIndexName;
    }
  | { readonly kind: 'index-unexpected'; readonly indexName: string };

export type RegistrationStorageOperation = 'bootstrap' | 'verify';

type RegistrationIndexName =
  '_id_' | 'registration-expiry' | 'registration-creation-key' | 'registration-proof-response';

type RegistrationStorageInspection =
  | { readonly kind: 'collection-absent' }
  | {
      readonly kind: 'collection-present';
      readonly validator: 'missing' | 'current';
      readonly missingIndexes: readonly RegistrationIndexName[];
    };

const registrationSessionCollectionName = 'registration_sessions';

const registrationIndexNames: readonly RegistrationIndexName[] = [
  '_id_',
  'registration-expiry',
  'registration-creation-key',
  'registration-proof-response',
];

export class RegistrationRepositoryFailure extends Error {
  readonly detail: RegistrationRepositoryError;

  constructor(detail: RegistrationRepositoryError) {
    super(registrationRepositoryErrorMessage(detail));
    this.name = 'RegistrationRepositoryFailure';
    this.detail = detail;
  }
}

export class MongoRegistrationSessions implements RegistrationSessions {
  readonly #database: Db;
  readonly #sessions: Collection<RegistrationSessionDocument>;
  readonly #retentionMilliseconds: number;

  constructor(database: Db, retentionMilliseconds: number) {
    if (!Number.isSafeInteger(retentionMilliseconds) || retentionMilliseconds < 0) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'retention must be a non-negative integer number of milliseconds',
      });
    }

    this.#database = database;
    this.#sessions = database.collection<RegistrationSessionDocument>(
      registrationSessionCollectionName,
    );
    this.#retentionMilliseconds = retentionMilliseconds;
  }

  async bootstrap(): Promise<void> {
    try {
      await this.#database.command({ ping: 1 });
      const inspection = await this.#inspectStorage();
      if (inspection.kind === 'collection-absent') {
        await this.#database.createCollection<RegistrationSessionDocument>(
          registrationSessionCollectionName,
          {
            validator: registrationSessionValidator(),
            validationLevel: 'strict',
            validationAction: 'error',
          },
        );
        await this.#createIndexes([
          'registration-expiry',
          'registration-creation-key',
          'registration-proof-response',
        ]);
      } else {
        if (inspection.validator === 'missing') {
          await this.#database.command({
            collMod: registrationSessionCollectionName,
            validator: registrationSessionValidator(),
            validationLevel: 'strict',
            validationAction: 'error',
          });
        }
        await this.#createIndexes(inspection.missingIndexes);
      }
      await this.#verifyStorage();
    } catch (error) {
      throw storageFailure(error, 'bootstrap');
    }
  }

  async verify(): Promise<void> {
    try {
      await this.#database.command({ ping: 1 });
      await this.#verifyStorage();
    } catch (error) {
      throw storageFailure(error, 'verify');
    }
  }

  async create(
    session: RegistrationSession,
    creationKeyHash: string,
  ): Promise<RegistrationCreation> {
    if (!/^[a-f0-9]{64}$/u.test(creationKeyHash)) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'creation key hash is invalid',
      });
    }
    const document = this.#document(session, creationKeyHash);
    try {
      await this.#sessions.insertOne(document);
    } catch (error) {
      if (duplicateKey(error)) {
        const existing = await this.#sessions.findOne({ creationKeyHash });
        if (existing !== null) {
          return { kind: 'registration-already-created', ...decodeSnapshot(existing) };
        }
        throw new RegistrationRepositoryFailure({
          kind: 'registration-already-exists',
          registrationId: session.binding.registrationId,
        });
      }
      throw error;
    }

    return { kind: 'registration-created', revision: 0, session };
  }

  async retrieveByCreationKeyHash(
    creationKeyHash: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot | undefined> {
    const stored = await this.#sessions.findOne({ creationKeyHash });
    if (stored === null) {
      return undefined;
    }
    const snapshot = decodeSnapshot(stored);
    return this.retrieve(snapshot.session.binding.registrationId, observedAt);
  }

  async retrieve(
    registrationId: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot | undefined> {
    for (;;) {
      const stored = await this.#sessions.findOne({ _id: registrationId });
      if (stored === null) {
        return undefined;
      }

      const snapshot = decodeSnapshot(stored);
      const observed = observeRegistrationSession(snapshot.session, observedAt);
      if (observed.kind !== 'expired' || snapshot.session.kind === 'expired') {
        return snapshot;
      }

      const expiration = await this.commit(snapshot, observed);
      if (expiration.kind === 'registration-committed') {
        return expiration.snapshot;
      }
      if (expiration.kind === 'registration-proof-replayed') {
        throw new RegistrationRepositoryFailure({
          kind: 'registration-document-invalid',
          reason: 'expiry attempted to consume proof evidence',
        });
      }
    }
  }

  async commit(
    current: RegistrationSnapshot,
    next: RegistrationSession,
  ): Promise<RegistrationCommit> {
    const registrationId = current.session.binding.registrationId;
    if (next.binding.registrationId !== registrationId) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'a transition cannot replace the Registration Session identity',
      });
    }

    const set: RegistrationSessionUpdate = {
      revision: current.revision + 1,
      session: encodeRegistrationSessionDocument(next),
      purgeAt: this.#purgeAt(next.binding.expiresAt),
    };
    const responseSaid = proofResponseSaid(next);
    if (responseSaid !== undefined) {
      set.proofResponseSaid = responseSaid;
    }

    try {
      const result = await this.#sessions.updateOne(
        { _id: registrationId, revision: current.revision },
        { $set: set },
      );
      if (result.modifiedCount !== 1) {
        return { kind: 'registration-concurrently-modified' };
      }
    } catch (error) {
      if (duplicateKey(error)) {
        return { kind: 'registration-proof-replayed' };
      }
      throw error;
    }

    return {
      kind: 'registration-committed',
      snapshot: { revision: current.revision + 1, session: next },
    };
  }

  #document(session: RegistrationSession, creationKeyHash: string): RegistrationSessionDocument {
    return {
      _id: session.binding.registrationId,
      revision: 0,
      session: encodeRegistrationSessionDocument(session),
      creationKeyHash,
      purgeAt: this.#purgeAt(session.binding.expiresAt),
    };
  }

  #purgeAt(expiresAt: number): Date {
    const purgeAt = expiresAt + this.#retentionMilliseconds;
    if (!Number.isSafeInteger(purgeAt)) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'retention exceeds the supported timestamp range',
      });
    }
    return new Date(purgeAt);
  }

  async #verifyStorage(): Promise<void> {
    const inspection = await this.#inspectStorage();
    if (inspection.kind === 'collection-absent') {
      throw storageDrift({ kind: 'collection-missing' });
    }
    if (inspection.validator === 'missing') {
      throw storageDrift({ kind: 'collection-validator-missing' });
    }
    const missingIndex = inspection.missingIndexes[0];
    if (missingIndex !== undefined) {
      throw storageDrift({ kind: 'index-missing', indexName: missingIndex });
    }
  }

  async #inspectStorage(): Promise<RegistrationStorageInspection> {
    const collection = await this.#database
      .listCollections({ name: registrationSessionCollectionName })
      .next();
    if (collection === null) {
      return { kind: 'collection-absent' };
    }
    if (collection.type !== 'collection') {
      throw storageDrift({ kind: 'collection-validator-conflict' });
    }

    const validator = collectionValidatorDisposition(objectField(collection, 'options'));
    const indexes = await this.#sessions.indexes();
    const missingIndexes = inspectRegistrationIndexes(indexes);
    return { kind: 'collection-present', validator, missingIndexes };
  }

  async #createIndexes(indexNames: readonly RegistrationIndexName[]): Promise<void> {
    for (const indexName of indexNames) {
      switch (indexName) {
        case '_id_':
          throw storageDrift({ kind: 'index-missing', indexName });
        case 'registration-expiry':
          await this.#sessions.createIndex(
            { purgeAt: 1 },
            { name: indexName, expireAfterSeconds: 0 },
          );
          break;
        case 'registration-creation-key':
          await this.#sessions.createIndex(
            { creationKeyHash: 1 },
            { name: indexName, unique: true },
          );
          break;
        case 'registration-proof-response':
          await this.#sessions.createIndex(
            { proofResponseSaid: 1 },
            {
              name: indexName,
              unique: true,
              partialFilterExpression: { proofResponseSaid: { $type: 'string' } },
            },
          );
          break;
      }
    }
  }
}

interface RegistrationSessionUpdate {
  revision: number;
  session: string;
  proofResponseSaid?: string;
  purgeAt: Date;
}

function decodeSnapshot(document: WithId<RegistrationSessionDocument>): RegistrationSnapshot {
  if (
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    typeof document.session !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(document.creationKeyHash) ||
    !(document.purgeAt instanceof Date) ||
    Number.isNaN(document.purgeAt.valueOf()) ||
    (document.proofResponseSaid !== undefined && typeof document.proofResponseSaid !== 'string')
  ) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB metadata does not match the current schema',
    });
  }

  let session: RegistrationSession;
  try {
    session = decodeRegistrationSessionDocument(document.session);
  } catch (error) {
    if (error instanceof RegistrationSessionDocumentFailure) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: error.message,
      });
    }
    throw error;
  }

  if (session.binding.registrationId !== document._id) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB identity does not match the Registration Session identity',
    });
  }

  const activeProof = proofResponseSaid(session);
  if (activeProof !== undefined && document.proofResponseSaid !== activeProof) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB proof replay metadata does not match the Registration Session proof',
    });
  }

  return { revision: document.revision, session };
}

function proofResponseSaid(session: RegistrationSession): string | undefined {
  switch (session.kind) {
    case 'pending-proof':
    case 'rejected':
    case 'expired':
      return undefined;
    case 'pending-approval':
    case 'approved':
    case 'issuing':
    case 'issued':
      return session.proof.responseSaid;
  }
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function registrationSessionValidator() {
  return {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'revision', 'session', 'creationKeyHash', 'purgeAt'],
      additionalProperties: false,
      properties: {
        _id: { bsonType: 'string' },
        revision: { bsonType: 'int', minimum: 0 },
        session: { bsonType: 'string' },
        creationKeyHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        proofResponseSaid: { bsonType: 'string' },
        purgeAt: { bsonType: 'date' },
      },
    },
  };
}

function collectionValidatorDisposition(options: unknown): 'missing' | 'current' {
  const keys = objectKeys(options);
  if (keys.length === 0) {
    return 'missing';
  }
  if (
    isDeepStrictEqual(keys.toSorted(), ['validationAction', 'validationLevel', 'validator']) &&
    isDeepStrictEqual(objectField(options, 'validator'), registrationSessionValidator()) &&
    objectField(options, 'validationLevel') === 'strict' &&
    objectField(options, 'validationAction') === 'error'
  ) {
    return 'current';
  }
  throw storageDrift({ kind: 'collection-validator-conflict' });
}

function inspectRegistrationIndexes(indexes: readonly unknown[]): readonly RegistrationIndexName[] {
  const observed = new Set<RegistrationIndexName>();
  for (const index of indexes) {
    const name = objectField(index, 'name');
    if (typeof name !== 'string') {
      throw storageDrift({ kind: 'index-metadata-invalid' });
    }
    if (!isRegistrationIndexName(name)) {
      throw storageDrift({ kind: 'index-unexpected', indexName: name });
    }
    if (observed.has(name) || !registrationIndexMatches(index, name)) {
      throw storageDrift({ kind: 'index-definition-conflict', indexName: name });
    }
    observed.add(name);
  }
  return registrationIndexNames.filter((name) => !observed.has(name));
}

function registrationIndexMatches(index: unknown, name: RegistrationIndexName): boolean {
  const userFields = objectKeys(index)
    .filter((field) => field !== 'v' && field !== 'ns')
    .toSorted();
  switch (name) {
    case '_id_':
      return (
        isDeepStrictEqual(userFields, ['key', 'name']) &&
        isDeepStrictEqual(objectField(index, 'key'), { _id: 1 })
      );
    case 'registration-expiry':
      return (
        isDeepStrictEqual(userFields, ['expireAfterSeconds', 'key', 'name']) &&
        isDeepStrictEqual(objectField(index, 'key'), { purgeAt: 1 }) &&
        objectField(index, 'expireAfterSeconds') === 0
      );
    case 'registration-creation-key':
      return (
        isDeepStrictEqual(userFields, ['key', 'name', 'unique']) &&
        isDeepStrictEqual(objectField(index, 'key'), { creationKeyHash: 1 }) &&
        objectField(index, 'unique') === true
      );
    case 'registration-proof-response':
      return (
        isDeepStrictEqual(userFields, ['key', 'name', 'partialFilterExpression', 'unique']) &&
        isDeepStrictEqual(objectField(index, 'key'), { proofResponseSaid: 1 }) &&
        objectField(index, 'unique') === true &&
        isDeepStrictEqual(objectField(index, 'partialFilterExpression'), {
          proofResponseSaid: { $type: 'string' },
        })
      );
  }
}

function isRegistrationIndexName(name: string): name is RegistrationIndexName {
  return registrationIndexNames.some((expected) => expected === name);
}

function objectKeys(value: unknown): readonly string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

function objectField(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined;
}

function storageDrift(conflict: RegistrationStorageConflict): RegistrationRepositoryFailure {
  return new RegistrationRepositoryFailure({ kind: 'registration-storage-drift', conflict });
}

function storageFailure(
  error: unknown,
  operation: RegistrationStorageOperation,
): RegistrationRepositoryFailure {
  return error instanceof RegistrationRepositoryFailure
    ? error
    : new RegistrationRepositoryFailure({
        kind: 'registration-storage-unavailable',
        operation,
      });
}

function registrationRepositoryErrorMessage(error: RegistrationRepositoryError): string {
  switch (error.kind) {
    case 'registration-already-exists':
      return `Registration Session ${error.registrationId} already exists`;
    case 'registration-document-invalid':
      return error.reason;
    case 'registration-storage-drift':
      return registrationStorageConflictMessage(error.conflict);
    case 'registration-storage-unavailable':
      return `Registration Session storage is unavailable during ${error.operation}`;
  }
}

function registrationStorageConflictMessage(conflict: RegistrationStorageConflict): string {
  switch (conflict.kind) {
    case 'collection-missing':
      return 'Registration Session collection is missing';
    case 'collection-validator-missing':
      return 'Registration Session collection validator is missing';
    case 'collection-validator-conflict':
      return 'Registration Session collection validator conflicts with the required schema';
    case 'index-metadata-invalid':
      return 'Registration Session index metadata is invalid';
    case 'index-missing':
      return `Registration Session index ${conflict.indexName} is missing`;
    case 'index-definition-conflict':
      return `Registration Session index ${conflict.indexName} conflicts with the required definition`;
    case 'index-unexpected':
      return `Registration Session index ${conflict.indexName} is not part of the required schema`;
  }
}
