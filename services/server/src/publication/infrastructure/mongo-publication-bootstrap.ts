import Type from 'typebox';
import Value from 'typebox/value';
import { isDeepStrictEqual } from 'node:util';
import { publishedHarnessSchema } from '@devrandom/protocol';
import type { Db } from 'mongodb';
import { typeboxMongoSchema } from '../../infrastructure/typebox-mongo-schema.js';
const said = { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' };
export const publicationStorageSchemas = Object.freeze({
  harnessPublications: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'ownerAid', 'published'],
      additionalProperties: false,
      properties: {
        _id: said,
        ownerAid: said,
        published: typeboxMongoSchema(publishedHarnessSchema),
      },
    },
  },
  harnessPublicationCommands: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'fingerprint', 'packageSaid'],
      additionalProperties: false,
      properties: {
        _id: {
          bsonType: 'string',
          pattern:
            '^[A-Z][A-Za-z0-9_-]{43}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        },
        fingerprint: { bsonType: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        packageSaid: said,
      },
    },
  },
  harnessPublicationBudgets: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'count', 'bytes'],
      additionalProperties: false,
      properties: {
        _id: said,
        count: { bsonType: 'number', minimum: 0, maximum: 128, multipleOf: 1 },
        bytes: { bsonType: 'number', minimum: 0, maximum: 8 * 1024 * 1024, multipleOf: 1 },
      },
    },
  },
});
export class HarnessPublicationStorageDrift extends Error {
  constructor() {
    super('HarnessPublicationStorageDrift');
    this.name = 'HarnessPublicationStorageDrift';
  }
}
/** Add only missing collections; never silently repair, loosen, or replace existing storage law. */
export class MongoPublicationBootstrap {
  readonly #database: Db;
  constructor(database: Db) {
    this.#database = database;
  }
  async bootstrap(): Promise<void> {
    for (const [name, validator] of Object.entries(publicationStorageSchemas)) {
      const observed = await this.#database.listCollections({ name }, { nameOnly: false }).next();
      if (observed === null)
        await this.#database.createCollection(name, {
          validator,
          validationLevel: 'strict',
          validationAction: 'error',
        });
    }
    await this.verify();
  }
  async verify(): Promise<void> {
    for (const [name, validator] of Object.entries(publicationStorageSchemas)) {
      const observed = await this.#database.listCollections({ name }, { nameOnly: false }).next();
      if (
        observed === null ||
        observed.options?.validationLevel !== 'strict' ||
        observed.options.validationAction !== 'error' ||
        !isDeepStrictEqual(observed.options.validator, validator)
      )
        throw new HarnessPublicationStorageDrift();
      const indexes: unknown = await this.#database.collection(name).listIndexes().toArray();
      if (
        !Value.Check(
          Type.Array(
            Type.Object(
              {
                name: Type.Literal('_id_'),
                key: Type.Object({ _id: Type.Literal(1) }, { additionalProperties: false }),
              },
              { additionalProperties: true },
            ),
            { minItems: 1, maxItems: 1 },
          ),
          indexes,
        )
      )
        throw new HarnessPublicationStorageDrift();
    }
  }
}
