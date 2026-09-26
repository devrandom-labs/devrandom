import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import { typeboxMongoSchema } from '../../infrastructure/typebox-mongo-schema.js';
import { runAdmissionDocumentSchema, type RunAdmissionDocument } from './run-admission-document.js';
import { runDocumentSchema, type RunDocument } from './run-document.js';
import {
  runAdmissionIndexDefinitions,
  runAdmissionsCollectionName,
  runIndexDefinitions,
  runsCollectionName,
} from './mongo-runs.js';

export const runAdmissionCollectionValidator = Object.freeze({
  $jsonSchema: typeboxMongoSchema(runAdmissionDocumentSchema),
});

export const runCollectionValidator = Object.freeze({
  $jsonSchema: typeboxMongoSchema(runDocumentSchema),
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
type IndexDefinition =
  (typeof runAdmissionIndexDefinitions)[number] | (typeof runIndexDefinitions)[number];

function decodeIndexes(input: unknown): readonly ObservedIndex[] {
  if (!Value.Check(observedIndexesSchema, input)) {
    throw new RunStorageDrift('RunIndexes');
  }
  return input;
}

function sameIndex(actual: ObservedIndex, expected: IndexDefinition): boolean {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === expected.unique &&
    isDeepStrictEqual(
      actual.partialFilterExpression,
      'partialFilterExpression' in expected ? expected.partialFilterExpression : undefined,
    )
  );
}

export type RunStorageDriftResource =
  'RunAdmissionCollection' | 'RunAdmissionIndexes' | 'RunCollection' | 'RunIndexes';

export class RunStorageDrift extends Error {
  readonly resource: RunStorageDriftResource;

  constructor(resource: RunStorageDriftResource) {
    super(`${resource} has drifted from the compiled Run storage contract`);
    this.name = 'RunStorageDrift';
    this.resource = resource;
  }
}

export class MongoRunBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    await this.#bootstrapCollection(
      runAdmissionsCollectionName,
      runAdmissionCollectionValidator,
      runAdmissionIndexDefinitions,
      'RunAdmissionCollection',
      'RunAdmissionIndexes',
    );
    await this.#bootstrapCollection(
      runsCollectionName,
      runCollectionValidator,
      runIndexDefinitions,
      'RunCollection',
      'RunIndexes',
    );
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
    await this.#verifyCollection(
      runAdmissionsCollectionName,
      runAdmissionCollectionValidator,
      'RunAdmissionCollection',
    );
    await this.#verifyIndexes(
      runAdmissionsCollectionName,
      runAdmissionIndexDefinitions,
      'RunAdmissionIndexes',
    );
    await this.#verifyCollection(runsCollectionName, runCollectionValidator, 'RunCollection');
    await this.#verifyIndexes(runsCollectionName, runIndexDefinitions, 'RunIndexes');
  }

  async #bootstrapCollection(
    name: string,
    validator: typeof runAdmissionCollectionValidator | typeof runCollectionValidator,
    definitions: readonly IndexDefinition[],
    collectionResource: RunStorageDriftResource,
    indexResource: RunStorageDriftResource,
  ): Promise<void> {
    const current = await this.#database.listCollections({ name }, { nameOnly: false }).next();
    if (current === null) {
      await this.#database.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await this.#verifyCollection(name, validator, collectionResource);
    }
    const collection = this.#database.collection<RunAdmissionDocument | RunDocument>(name);
    const actual = decodeIndexes(await collection.listIndexes().toArray());
    for (const definition of definitions) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await collection.createIndex(definition.key, {
          name: definition.name,
          unique: definition.unique,
          ...('partialFilterExpression' in definition
            ? { partialFilterExpression: definition.partialFilterExpression }
            : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new RunStorageDrift(indexResource);
      }
    }
  }

  async #verifyCollection(
    name: string,
    validator: typeof runAdmissionCollectionValidator | typeof runCollectionValidator,
    resource: RunStorageDriftResource,
  ): Promise<void> {
    const current = await this.#database.listCollections({ name }, { nameOnly: false }).next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, validator)
    ) {
      throw new RunStorageDrift(resource);
    }
  }

  async #verifyIndexes(
    name: string,
    definitions: readonly IndexDefinition[],
    resource: RunStorageDriftResource,
  ): Promise<void> {
    const actual = decodeIndexes(await this.#database.collection(name).listIndexes().toArray());
    const expectedNames = new Set(['_id_', ...definitions.map((definition) => definition.name)]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      definitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new RunStorageDrift(resource);
    }
  }
}
