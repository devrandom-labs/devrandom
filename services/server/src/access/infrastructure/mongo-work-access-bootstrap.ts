import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  encodeWorkAccessPolicy,
  workAccessPolicy,
  workAccessPolicyFingerprintFor,
  type WorkAccessPolicy,
} from '../domain/work-access-policy.js';
import type { WorkAccessAttemptDocument } from './work-access-document.js';
import {
  workAccessAttemptsCollectionName,
  workAccessIndexNames,
} from './work-access-storage-contract.js';

export const workAccessPolicyCollectionName = 'hostedWorkPolicies' as const;

export const workAccessIndexDefinitions = Object.freeze([
  {
    name: workAccessIndexNames.command,
    key: { userAid: 1, clientInstanceId: 1, commandId: 1 },
    unique: true,
  },
  {
    name: workAccessIndexNames.activeGrantSecret,
    key: { grantSecretHash: 1 },
    unique: true,
    partialFilterExpression: {
      'state.kind': 'Granted',
      'state.disposition.kind': 'Active',
    },
  },
  {
    name: workAccessIndexNames.expiry,
    key: { expiresAt: 1 },
    expireAfterSeconds: 0,
  },
  {
    name: workAccessIndexNames.proofResponse,
    key: { proofResponseSaid: 1 },
    unique: true,
    partialFilterExpression: { proofResponseSaid: { $type: 'string' } },
  },
  {
    name: workAccessIndexNames.userAttemptSlot,
    key: { userAid: 1, clientInstanceId: 1, attemptSlot: 1 },
    unique: true,
    partialFilterExpression: { attemptSlot: { $type: 'number' } },
  },
  {
    name: workAccessIndexNames.globalAttemptSlot,
    key: { globalAttemptSlot: 1 },
    unique: true,
    partialFilterExpression: { globalAttemptSlot: { $type: 'number' } },
  },
  {
    name: workAccessIndexNames.userGrantSlot,
    key: { userAid: 1, clientInstanceId: 1, grantSlot: 1 },
    unique: true,
    partialFilterExpression: { grantSlot: { $type: 'number' } },
  },
] as const);

const identifier = { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' } as const;
const uuidV4 = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
} as const;
const fingerprint = { bsonType: 'string', pattern: '^sha256:[a-f0-9]{64}$' } as const;
const date = { bsonType: 'date' } as const;
const challengeWords = {
  bsonType: 'array',
  minItems: 24,
  maxItems: 24,
  items: { bsonType: 'string', minLength: 1, maxLength: 64 },
} as const;
const scopes = {
  bsonType: 'array',
  minItems: 1,
  maxItems: 14,
  uniqueItems: true,
  items: {
    enum: [
      'evaluation:admit',
      'evaluation:append',
      'evaluation:close',
      'evaluation:prepare',
      'evidence:append',
      'evidence:read',
      'evidence:seal',
      'experience:retrieve',
      'run:create',
      'run:execute',
      'run:prepare',
      'run:read',
      'task:create',
      'task:read',
    ],
  },
} as const;
const rejectionReason = {
  enum: [
    'ChallengeRecipientMismatch',
    'ChallengeProofInvalid',
    'ChallengeOperationFailed',
    'ChallengeAcknowledgementRejected',
    'CredentialNotCurrent',
  ],
} as const;

export const workAccessAttemptCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'revision',
      'commandFingerprint',
      'commandId',
      'clientInstanceId',
      'userAid',
      'credentialSaid',
      'issuerRecipientAid',
      'grantSecretHash',
      'createdAt',
      'attemptExpiresAt',
      'expiresAt',
      'state',
    ],
    properties: {
      _id: uuidV4,
      revision: { bsonType: 'number', minimum: 0, multipleOf: 1 },
      commandFingerprint: fingerprint,
      commandId: uuidV4,
      clientInstanceId: uuidV4,
      userAid: identifier,
      credentialSaid: identifier,
      issuerRecipientAid: identifier,
      grantSecretHash: fingerprint,
      createdAt: date,
      attemptExpiresAt: date,
      expiresAt: date,
      proofResponseSaid: identifier,
      attemptSlot: { bsonType: 'number', minimum: 0, maximum: 1, multipleOf: 1 },
      globalAttemptSlot: { bsonType: 'number', minimum: 0, maximum: 31, multipleOf: 1 },
      grantSlot: { bsonType: 'number', minimum: 0, maximum: 1, multipleOf: 1 },
      state: {
        oneOf: [
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'challengeWords'],
            properties: { kind: { enum: ['AwaitingProof'] }, challengeWords },
          },
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'challengeWords', 'responseSaid', 'operationName'],
            properties: {
              kind: { enum: ['VerifyingProof'] },
              challengeWords,
              responseSaid: identifier,
              operationName: { bsonType: 'string', minLength: 1 },
            },
          },
          {
            bsonType: 'object',
            additionalProperties: false,
            required: [
              'kind',
              'verifiedResponseSaid',
              'scopes',
              'policyFingerprint',
              'grantedAt',
              'expiresAt',
              'disposition',
            ],
            properties: {
              kind: { enum: ['Granted'] },
              verifiedResponseSaid: identifier,
              scopes,
              policyFingerprint: fingerprint,
              grantedAt: date,
              expiresAt: date,
              disposition: {
                oneOf: [
                  {
                    bsonType: 'object',
                    additionalProperties: false,
                    required: ['kind', 'remainingRequests'],
                    properties: {
                      kind: { enum: ['Active'] },
                      remainingRequests: {
                        bsonType: 'number',
                        minimum: 0,
                        maximum: 2_000,
                        multipleOf: 1,
                      },
                    },
                  },
                  {
                    bsonType: 'object',
                    additionalProperties: false,
                    required: ['kind'],
                    properties: { kind: { enum: ['Expired', 'Exhausted'] } },
                  },
                  {
                    bsonType: 'object',
                    additionalProperties: false,
                    required: ['kind', 'releasedAt'],
                    properties: { kind: { enum: ['Released'] }, releasedAt: date },
                  },
                  {
                    bsonType: 'object',
                    additionalProperties: false,
                    required: ['kind', 'reason'],
                    properties: {
                      kind: { enum: ['Revoked'] },
                      reason: { enum: ['SecurityIncident'] },
                    },
                  },
                ],
              },
            },
          },
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'reason', 'rejectedAt'],
            properties: {
              kind: { enum: ['Rejected'] },
              responseSaid: identifier,
              reason: rejectionReason,
              rejectedAt: date,
            },
          },
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'expiredAt'],
            properties: { kind: { enum: ['Expired'] }, expiredAt: date },
          },
        ],
      },
    },
  },
});

const previousState = workAccessAttemptCollectionValidator.$jsonSchema.properties.state;
const previousGrantState = previousState.oneOf[2];
if (previousGrantState?.properties.disposition === undefined) {
  throw new Error('Work Access Grant collection validator is malformed');
}
const previousWorkAccessAttemptCollectionValidator = {
  $jsonSchema: {
    ...workAccessAttemptCollectionValidator.$jsonSchema,
    properties: {
      ...workAccessAttemptCollectionValidator.$jsonSchema.properties,
      state: {
        ...previousState,
        oneOf: [
          previousState.oneOf[0],
          previousState.oneOf[1],
          {
            ...previousGrantState,
            properties: {
              ...previousGrantState.properties,
              disposition: {
                ...previousGrantState.properties.disposition,
                oneOf: previousGrantState.properties.disposition.oneOf.filter(
                  (alternative) => alternative.properties.kind.enum[0] !== 'Released',
                ),
              },
            },
          },
          previousState.oneOf[3],
          previousState.oneOf[4],
        ],
      },
    },
  },
};

const workAccessPolicyDocumentSchema = Type.Object(
  {
    _id: Type.Literal('work-access-policy/1'),
    fingerprint: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    canonicalPolicy: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface WorkAccessPolicyDocument {
  readonly _id: 'work-access-policy/1';
  readonly fingerprint: string;
  readonly canonicalPolicy: string;
}

export function workAccessPolicyDocumentFor(policy: WorkAccessPolicy): WorkAccessPolicyDocument {
  return Object.freeze({
    _id: 'work-access-policy/1',
    fingerprint: workAccessPolicyFingerprintFor(policy),
    canonicalPolicy: encodeWorkAccessPolicy(policy),
  });
}

export const workAccessPolicyDocument = workAccessPolicyDocumentFor(workAccessPolicy);

export function decodeWorkAccessPolicyDocument(
  input: unknown,
  expected: WorkAccessPolicyDocument = workAccessPolicyDocument,
): WorkAccessPolicyDocument {
  if (!Value.Check(workAccessPolicyDocumentSchema, input)) {
    throw new AccessStorageDrift('WorkAccessPolicy');
  }
  const document: WorkAccessPolicyDocument = input;
  if (!isDeepStrictEqual(document, expected)) {
    throw new AccessStorageDrift('WorkAccessPolicy');
  }
  return document;
}

export const workAccessPolicyCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: ['_id', 'fingerprint', 'canonicalPolicy'],
    properties: {
      _id: { enum: ['work-access-policy/1'] },
      fingerprint,
      canonicalPolicy: { bsonType: 'string', minLength: 1 },
    },
  },
});

export type AccessStorageDriftResource =
  | 'TransactionTopology'
  | 'WorkAccessAttemptsCollection'
  | 'WorkAccessIndexes'
  | 'WorkAccessPolicyCollection'
  | 'WorkAccessPolicyIndexes'
  | 'WorkAccessPolicy';

export class AccessStorageDrift extends Error {
  readonly resource: AccessStorageDriftResource;

  constructor(resource: AccessStorageDriftResource) {
    super(`${resource} has drifted from the compiled Work Access contract`);
    this.name = 'AccessStorageDrift';
    this.resource = resource;
  }
}

export interface WorkAccessStorageReadiness {
  verify(): Promise<void>;
}

const transactionTopologySchema = Type.Intersect([
  Type.Object({ isWritablePrimary: Type.Literal(true) }, { additionalProperties: true }),
  Type.Union([
    Type.Object({ setName: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
    Type.Object({ msg: Type.Literal('isdbgrid') }, { additionalProperties: true }),
  ]),
]);

const observedIndexesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      key: Type.Object({}, { additionalProperties: true }),
      unique: Type.Optional(Type.Boolean()),
      expireAfterSeconds: Type.Optional(Type.Number()),
      partialFilterExpression: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
  ),
);

type ObservedIndex = Type.Static<(typeof observedIndexesSchema)['items']>;

function decodeIndexes(input: unknown): readonly ObservedIndex[] {
  if (!Value.Check(observedIndexesSchema, input)) {
    throw new AccessStorageDrift('WorkAccessIndexes');
  }
  return input;
}

function sameIndex(actual: ObservedIndex, expected: (typeof workAccessIndexDefinitions)[number]) {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === ('unique' in expected ? expected.unique : undefined) &&
    actual.expireAfterSeconds ===
      ('expireAfterSeconds' in expected ? expected.expireAfterSeconds : undefined) &&
    isDeepStrictEqual(
      actual.partialFilterExpression,
      'partialFilterExpression' in expected ? expected.partialFilterExpression : undefined,
    )
  );
}

export class MongoWorkAccessBootstrap implements WorkAccessStorageReadiness {
  readonly #database: Db;
  readonly #policyDocument: WorkAccessPolicyDocument;

  constructor(database: Db, policy: WorkAccessPolicy = workAccessPolicy) {
    this.#database = database;
    this.#policyDocument = workAccessPolicyDocumentFor(policy);
  }

  async bootstrap(): Promise<void> {
    await this.#verifyTransactionTopology();
    await this.#prepareAttempts();
    await this.#preparePolicy();
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#verifyTransactionTopology();
    await this.#verifyAttemptsCollection();
    await this.#verifyIndexes();
    await this.#verifyPolicyCollection();
    await this.#verifyPolicyIndexes();
    const policy = await this.#database
      .collection<WorkAccessPolicyDocument>(workAccessPolicyCollectionName)
      .findOne({ _id: this.#policyDocument._id });
    decodeWorkAccessPolicyDocument(policy, this.#policyDocument);
  }

  async #verifyTransactionTopology(): Promise<void> {
    const topology: unknown = await this.#database.command({ hello: 1 });
    if (!Value.Check(transactionTopologySchema, topology)) {
      throw new AccessStorageDrift('TransactionTopology');
    }
  }

  async #prepareAttempts(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: workAccessAttemptsCollectionName }, { nameOnly: false })
      .next();
    if (current === null) {
      await this.#database.createCollection(workAccessAttemptsCollectionName, {
        validator: workAccessAttemptCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      const options = current.options;
      if (
        options?.validationLevel === 'strict' &&
        options.validationAction === 'error' &&
        isDeepStrictEqual(options.validator, previousWorkAccessAttemptCollectionValidator)
      ) {
        await this.#database.command({
          collMod: workAccessAttemptsCollectionName,
          validator: workAccessAttemptCollectionValidator,
          validationLevel: 'strict',
          validationAction: 'error',
        });
      }
      await this.#verifyAttemptsCollection();
    }
    const attempts = this.#database.collection<WorkAccessAttemptDocument>(
      workAccessAttemptsCollectionName,
    );
    const untrustedIndexes: unknown = await attempts.listIndexes().toArray();
    const actual = decodeIndexes(untrustedIndexes);
    for (const definition of workAccessIndexDefinitions) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await attempts.createIndex(definition.key, {
          name: definition.name,
          ...('unique' in definition ? { unique: definition.unique } : {}),
          ...('expireAfterSeconds' in definition
            ? { expireAfterSeconds: definition.expireAfterSeconds }
            : {}),
          ...('partialFilterExpression' in definition
            ? { partialFilterExpression: definition.partialFilterExpression }
            : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new AccessStorageDrift('WorkAccessIndexes');
      }
    }
  }

  async #preparePolicy(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: workAccessPolicyCollectionName }, { nameOnly: false })
      .next();
    if (current === null) {
      await this.#database.createCollection(workAccessPolicyCollectionName, {
        validator: workAccessPolicyCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await this.#verifyPolicyCollection();
    }
    const policies = this.#database.collection<WorkAccessPolicyDocument>(
      workAccessPolicyCollectionName,
    );
    const existing = await policies.findOne({ _id: this.#policyDocument._id });
    if (existing === null) {
      await policies.insertOne(this.#policyDocument);
    } else {
      decodeWorkAccessPolicyDocument(existing, this.#policyDocument);
    }
  }

  async #verifyAttemptsCollection(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: workAccessAttemptsCollectionName }, { nameOnly: false })
      .next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, workAccessAttemptCollectionValidator)
    ) {
      throw new AccessStorageDrift('WorkAccessAttemptsCollection');
    }
  }

  async #verifyIndexes(): Promise<void> {
    const untrustedIndexes: unknown = await this.#database
      .collection<WorkAccessAttemptDocument>(workAccessAttemptsCollectionName)
      .listIndexes()
      .toArray();
    const actual = decodeIndexes(untrustedIndexes);
    const expectedNames = new Set([
      '_id_',
      ...workAccessIndexDefinitions.map((definition) => definition.name),
    ]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      workAccessIndexDefinitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new AccessStorageDrift('WorkAccessIndexes');
    }
  }

  async #verifyPolicyCollection(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: workAccessPolicyCollectionName }, { nameOnly: false })
      .next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, workAccessPolicyCollectionValidator)
    ) {
      throw new AccessStorageDrift('WorkAccessPolicyCollection');
    }
  }

  async #verifyPolicyIndexes(): Promise<void> {
    const untrustedIndexes: unknown = await this.#database
      .collection<WorkAccessPolicyDocument>(workAccessPolicyCollectionName)
      .listIndexes()
      .toArray();
    const actual = decodeIndexes(untrustedIndexes);
    if (actual.length !== 1 || actual[0]?.name !== '_id_') {
      throw new AccessStorageDrift('WorkAccessPolicyIndexes');
    }
  }
}
