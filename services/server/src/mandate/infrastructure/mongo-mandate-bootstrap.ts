import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import { mandatePresentationRejectionValues } from '../domain/presentation.js';
import {
  mandatePresentationIndexDefinitions,
  mandatePresentationsCollectionName,
} from './mongo-mandate-presentations.js';

const keriIdentifier = {
  bsonType: 'string',
  pattern: '^[A-Z][A-Za-z0-9_-]{43}$',
} as const;

export const mandatePresentationCollectionValidator = Object.freeze({
  $and: [
    {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'revision',
          'ownerAid',
          'userCredentialSaid',
          'mandateKind',
          'credentialSaid',
          'grantSaid',
          'requestedAt',
          'expiresAt',
          'acceptedReference',
          'state',
        ],
        properties: {
          _id: keriIdentifier,
          revision: { bsonType: 'number', minimum: 0, multipleOf: 1 },
          ownerAid: keriIdentifier,
          userCredentialSaid: keriIdentifier,
          mandateKind: { enum: ['TaskMandate', 'PromotionMandate'] },
          credentialSaid: keriIdentifier,
          grantSaid: keriIdentifier,
          requestedAt: { bsonType: 'date' },
          expiresAt: { bsonType: 'date' },
          cleanupAt: { bsonType: 'date' },
          acceptedReference: {
            oneOf: [
              { bsonType: 'null' },
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['issueeAid', 'registryId', 'taskId', 'taskRevisionSaid'],
                properties: {
                  issueeAid: keriIdentifier,
                  registryId: keriIdentifier,
                  taskId: {
                    bsonType: 'string',
                    pattern:
                      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  },
                  taskRevisionSaid: keriIdentifier,
                },
              },
            ],
          },
          state: {
            oneOf: [
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { enum: ['AwaitingGrant'] } },
              },
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['kind', 'operationName'],
                properties: {
                  kind: { enum: ['Admitting'] },
                  operationName: { bsonType: 'string', minLength: 1, maxLength: 512 },
                },
              },
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['kind', 'credentialSaid', 'admittedAt'],
                properties: {
                  kind: { enum: ['Admitted'] },
                  credentialSaid: keriIdentifier,
                  admittedAt: { bsonType: 'date' },
                },
              },
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['kind', 'reason'],
                properties: {
                  kind: { enum: ['Rejected'] },
                  reason: { enum: [...mandatePresentationRejectionValues] },
                },
              },
              {
                bsonType: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { enum: ['Expired'] } },
              },
            ],
          },
        },
      },
    },
    {
      $or: [
        {
          'state.kind': 'Admitted',
          cleanupAt: { $exists: false },
          acceptedReference: { $type: 'object' },
        },
        {
          'state.kind': { $ne: 'Admitted' },
          cleanupAt: { $type: 'date' },
          acceptedReference: { $type: 'null' },
        },
      ],
    },
  ],
});

const observedIndexesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      key: Type.Object({}, { additionalProperties: true }),
      unique: Type.Optional(Type.Boolean()),
      expireAfterSeconds: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
  ),
);

type ObservedIndex = Type.Static<(typeof observedIndexesSchema)['items']>;

function decodeIndexes(input: unknown): readonly ObservedIndex[] {
  if (!Value.Check(observedIndexesSchema, input)) {
    throw new MandateStorageDrift('MandateIndexes');
  }
  return input;
}

function sameIndex(
  actual: ObservedIndex,
  expected: (typeof mandatePresentationIndexDefinitions)[number],
): boolean {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === ('unique' in expected ? expected.unique : undefined) &&
    actual.expireAfterSeconds ===
      ('expireAfterSeconds' in expected ? expected.expireAfterSeconds : undefined)
  );
}

export type MandateStorageDriftResource = 'MandateCollection' | 'MandateIndexes';

export class MandateStorageDrift extends Error {
  readonly resource: MandateStorageDriftResource;

  constructor(resource: MandateStorageDriftResource) {
    super(`${resource} has drifted from the compiled Mandate storage contract`);
    this.name = 'MandateStorageDrift';
    this.resource = resource;
  }
}

export class MongoMandateBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: mandatePresentationsCollectionName }, { nameOnly: false })
      .next();
    if (current === null) {
      await this.#database.createCollection(mandatePresentationsCollectionName, {
        validator: mandatePresentationCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await this.#verifyCollection();
    }
    const presentations = this.#database.collection(mandatePresentationsCollectionName);
    const actual = decodeIndexes(await presentations.listIndexes().toArray());
    for (const definition of mandatePresentationIndexDefinitions) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await presentations.createIndex(definition.key, {
          name: definition.name,
          ...('unique' in definition ? { unique: definition.unique } : {}),
          ...('expireAfterSeconds' in definition
            ? { expireAfterSeconds: definition.expireAfterSeconds }
            : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new MandateStorageDrift('MandateIndexes');
      }
    }
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
    await this.#verifyCollection();
    const actual = decodeIndexes(
      await this.#database.collection(mandatePresentationsCollectionName).listIndexes().toArray(),
    );
    const expectedNames = new Set([
      '_id_',
      ...mandatePresentationIndexDefinitions.map((definition) => definition.name),
    ]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      mandatePresentationIndexDefinitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new MandateStorageDrift('MandateIndexes');
    }
  }

  async #verifyCollection(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: mandatePresentationsCollectionName }, { nameOnly: false })
      .next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, mandatePresentationCollectionValidator)
    ) {
      throw new MandateStorageDrift('MandateCollection');
    }
  }
}
