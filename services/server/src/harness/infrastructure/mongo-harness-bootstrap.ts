import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import { baselineHarnessRevisionSchema } from '@devrandom/protocol';

import { typeboxMongoSchema } from '../../infrastructure/typebox-mongo-schema.js';
import {
  harnessRevisionIndexDefinitions,
  harnessRevisionsCollectionName,
} from './mongo-harness-revisions.js';
import type { HarnessDocument } from './harness-document.js';

const harnessRevisionMongoSchema = typeboxMongoSchema(baselineHarnessRevisionSchema);
const uuidV4 = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
} as const;
const said = { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' } as const;

export const harnessCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'kind',
      'ownerAid',
      'taskId',
      'taskRevisionSaid',
      'harnessLineageId',
      'commandId',
      'commandFingerprint',
      'acceptedAt',
      'activation',
      'revision',
    ],
    properties: {
      _id: said,
      kind: { enum: ['InitialSpecialization'] },
      ownerAid: said,
      taskId: uuidV4,
      taskRevisionSaid: said,
      harnessLineageId: uuidV4,
      commandId: uuidV4,
      commandFingerprint: {
        bsonType: 'string',
        pattern: '^sha256:[a-f0-9]{64}$',
      },
      acceptedAt: { bsonType: 'date' },
      activation: {
        oneOf: [
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'harnessLineageId', 'harnessRevisionSaid'],
            properties: {
              kind: { enum: ['AwaitingRunAdmission'] },
              harnessLineageId: uuidV4,
              harnessRevisionSaid: said,
            },
          },
          {
            bsonType: 'object',
            additionalProperties: false,
            required: ['kind', 'harnessLineageId', 'harnessRevisionSaid', 'runId', 'acceptedAt'],
            properties: {
              kind: { enum: ['InitialSpecializationAccepted'] },
              harnessLineageId: uuidV4,
              harnessRevisionSaid: said,
              runId: uuidV4,
              acceptedAt: { bsonType: 'date' },
            },
          },
        ],
      },
      revision: harnessRevisionMongoSchema,
    },
  },
});

const observedIndexesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      key: Type.Object({}, { additionalProperties: true }),
      unique: Type.Optional(Type.Boolean()),
      partialFilterExpression: Type.Optional(Type.Object({}, { additionalProperties: true })),
    },
    { additionalProperties: true },
  ),
);

type ObservedIndex = Type.Static<(typeof observedIndexesSchema)['items']>;

function decodeIndexes(input: unknown): readonly ObservedIndex[] {
  if (!Value.Check(observedIndexesSchema, input)) {
    throw new HarnessStorageDrift('HarnessIndexes');
  }
  return input;
}

function sameIndex(
  actual: ObservedIndex,
  expected: (typeof harnessRevisionIndexDefinitions)[number],
) {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === ('unique' in expected ? expected.unique : undefined) &&
    isDeepStrictEqual(
      actual.partialFilterExpression,
      'partialFilterExpression' in expected ? expected.partialFilterExpression : undefined,
    )
  );
}

export type HarnessStorageDriftResource = 'HarnessCollection' | 'HarnessIndexes';

export class HarnessStorageDrift extends Error {
  readonly resource: HarnessStorageDriftResource;

  constructor(resource: HarnessStorageDriftResource) {
    super(`${resource} has drifted from the compiled Harness storage contract`);
    this.name = 'HarnessStorageDrift';
    this.resource = resource;
  }
}

export class MongoHarnessBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: harnessRevisionsCollectionName }, { nameOnly: false })
      .next();
    if (current === null) {
      await this.#database.createCollection(harnessRevisionsCollectionName, {
        validator: harnessCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await this.#verifyCollection();
    }
    const collection = this.#database.collection<HarnessDocument>(harnessRevisionsCollectionName);
    const actual = decodeIndexes(await collection.listIndexes().toArray());
    for (const definition of harnessRevisionIndexDefinitions) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await collection.createIndex(definition.key, {
          name: definition.name,
          ...('unique' in definition ? { unique: definition.unique } : {}),
          ...('partialFilterExpression' in definition
            ? { partialFilterExpression: definition.partialFilterExpression }
            : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new HarnessStorageDrift('HarnessIndexes');
      }
    }
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
    await this.#verifyCollection();
    const actual = decodeIndexes(
      await this.#database
        .collection<HarnessDocument>(harnessRevisionsCollectionName)
        .listIndexes()
        .toArray(),
    );
    const expectedNames = new Set([
      '_id_',
      ...harnessRevisionIndexDefinitions.map((definition) => definition.name),
    ]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      harnessRevisionIndexDefinitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new HarnessStorageDrift('HarnessIndexes');
    }
  }

  async #verifyCollection(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: harnessRevisionsCollectionName }, { nameOnly: false })
      .next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, harnessCollectionValidator)
    ) {
      throw new HarnessStorageDrift('HarnessCollection');
    }
  }
}
