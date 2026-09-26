import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import { taskBudgetCeilings, taskLifecycleSchema, taskRevisionSchema } from '@devrandom/protocol';

import { typeboxMongoSchema } from '../../infrastructure/typebox-mongo-schema.js';
import { taskIndexDefinitions, tasksCollectionName } from './mongo-tasks.js';
import type { TaskDocument } from './task-document.js';

const uuidV4 = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
} as const;
const keriIdentifier = {
  bsonType: 'string',
  pattern: '^[A-Z][A-Za-z0-9_-]{43}$',
} as const;

const taskRevisionMongoSchema = typeboxMongoSchema(taskRevisionSchema);
const taskLifecycleMongoSchema = typeboxMongoSchema(taskLifecycleSchema);

export const taskCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'ownerAid',
      'label',
      'harnessLineageId',
      'revision',
      'lifecycle',
      'commandId',
      'commandFingerprint',
      'createdAt',
      'expectedVersion',
      'ownerSlot',
      'globalSlot',
    ],
    properties: {
      _id: uuidV4,
      ownerAid: keriIdentifier,
      label: {
        bsonType: 'string',
        minLength: 1,
        maxLength: 63,
        pattern: '^[a-z][a-z0-9-]{0,62}$',
      },
      harnessLineageId: uuidV4,
      revision: taskRevisionMongoSchema,
      lifecycle: taskLifecycleMongoSchema,
      commandId: uuidV4,
      commandFingerprint: { bsonType: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      createdAt: { bsonType: 'date' },
      expectedVersion: {
        bsonType: 'number',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        multipleOf: 1,
      },
      ownerSlot: {
        bsonType: 'number',
        minimum: 0,
        maximum: taskBudgetCeilings.tasksPerAdmittedUser - 1,
        multipleOf: 1,
      },
      globalSlot: {
        bsonType: 'number',
        minimum: 0,
        maximum: taskBudgetCeilings.hostedWorkTasksGlobally - 1,
        multipleOf: 1,
      },
    },
  },
});

const observedIndexesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      key: Type.Object({}, { additionalProperties: true }),
      unique: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  ),
);

type ObservedIndex = Type.Static<(typeof observedIndexesSchema)['items']>;

function decodeIndexes(input: unknown): readonly ObservedIndex[] {
  if (!Value.Check(observedIndexesSchema, input)) {
    throw new TaskStorageDrift('TaskIndexes');
  }
  return input;
}

function sameIndex(actual: ObservedIndex, expected: (typeof taskIndexDefinitions)[number]) {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === ('unique' in expected ? expected.unique : undefined)
  );
}

export type TaskStorageDriftResource = 'TaskCollection' | 'TaskIndexes';

export class TaskStorageDrift extends Error {
  readonly resource: TaskStorageDriftResource;

  constructor(resource: TaskStorageDriftResource) {
    super(`${resource} has drifted from the compiled Task storage contract`);
    this.name = 'TaskStorageDrift';
    this.resource = resource;
  }
}

export class MongoTaskBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: tasksCollectionName }, { nameOnly: false })
      .next();
    if (current === null) {
      await this.#database.createCollection(tasksCollectionName, {
        validator: taskCollectionValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else {
      await this.#verifyCollection();
    }
    const tasks = this.#database.collection<TaskDocument>(tasksCollectionName);
    const actual = decodeIndexes(await tasks.listIndexes().toArray());
    for (const definition of taskIndexDefinitions) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await tasks.createIndex(definition.key, {
          name: definition.name,
          ...('unique' in definition ? { unique: definition.unique } : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new TaskStorageDrift('TaskIndexes');
      }
    }
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
    await this.#verifyCollection();
    const actual = decodeIndexes(
      await this.#database.collection<TaskDocument>(tasksCollectionName).listIndexes().toArray(),
    );
    const expectedNames = new Set([
      '_id_',
      ...taskIndexDefinitions.map((definition) => definition.name),
    ]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      taskIndexDefinitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new TaskStorageDrift('TaskIndexes');
    }
  }

  async #verifyCollection(): Promise<void> {
    const current = await this.#database
      .listCollections({ name: tasksCollectionName }, { nameOnly: false })
      .next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, taskCollectionValidator)
    ) {
      throw new TaskStorageDrift('TaskCollection');
    }
  }
}
