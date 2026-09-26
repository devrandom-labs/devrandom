import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';

import {
  evidenceArtifactSchema,
  evidenceBatchAcknowledgementSchema,
  evidenceBatchSchema,
  evidenceEventSchema,
  verifiedCheckpointSchema,
  verifiedCheckpointV1Schema,
} from '@devrandom/protocol';

import {
  type MongoSchemaObject,
  type MongoSchemaValue,
  typeboxMongoSchema,
} from '../../infrastructure/typebox-mongo-schema.js';
import { evidenceStreamDocumentSchema } from './evidence-stream-document.js';
import { evidenceArtifactDocumentIdPattern } from './evidence-artifact-document.js';
import {
  evidenceCollectionContracts,
  evidenceCollectionNames,
  evidenceIndexDefinitions,
  evidenceUsageDocumentId,
  previousEvidenceStreamRunIndex,
  previousSingleIncarnationIndexes,
  type EvidenceCollectionName,
} from './evidence-storage-contract.js';
import {
  decodeEvidenceUsageDocument,
  evidenceUsageDocumentSchema,
  evidenceUsageInitialDocument,
  type EvidenceUsageDocument,
} from './evidence-usage-document.js';

const said = { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' } as const;
const uuidV4 = {
  bsonType: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
} as const;
const safeInteger = {
  bsonType: 'number',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
} as const;
const commandFingerprint = {
  bsonType: 'string',
  pattern: '^sha256:[a-f0-9]{64}$',
} as const;
const date = { bsonType: 'date' } as const;

function isMongoSchemaObject(schema: MongoSchemaValue): schema is MongoSchemaObject {
  return schema !== null && typeof schema === 'object' && !Array.isArray(schema);
}

function convertedSchema(schema: MongoSchemaValue): MongoSchemaObject {
  if (!isMongoSchemaObject(schema)) {
    throw new Error('Mongo Evidence schema conversion did not produce an object');
  }
  const converted: MongoSchemaObject = { ...schema };
  if (converted['type'] === 'object') {
    delete converted['type'];
    converted['bsonType'] = 'object';
  }
  return converted;
}

export const evidenceStreamCollectionValidator = Object.freeze({
  $jsonSchema: convertedSchema(typeboxMongoSchema(evidenceStreamDocumentSchema)),
});

export const evidenceArtifactCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: ['_id', 'ownerAid', 'runId', 'evidenceStreamId', 'artifact', 'bytes', 'acceptedAt'],
    properties: {
      _id: { bsonType: 'string', pattern: evidenceArtifactDocumentIdPattern },
      ownerAid: said,
      runId: uuidV4,
      evidenceStreamId: uuidV4,
      artifact: convertedSchema(typeboxMongoSchema(evidenceArtifactSchema)),
      bytes: { bsonType: 'binData' },
      acceptedAt: date,
    },
  },
});

/** Exact artifact validator before artifacts acquired a Run-scoped storage identity. */
export const previousEvidenceArtifactCollectionValidator = Object.freeze({
  $jsonSchema: {
    ...evidenceArtifactCollectionValidator.$jsonSchema,
    properties: { ...evidenceArtifactCollectionValidator.$jsonSchema.properties, _id: said },
  },
});

export const evidenceBatchCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'ownerAid',
      'commandFingerprint',
      'runId',
      'evidenceStreamId',
      'startingSequence',
      'batch',
      'acknowledgement',
      'receivedAt',
    ],
    properties: {
      _id: said,
      ownerAid: said,
      commandFingerprint,
      runId: uuidV4,
      evidenceStreamId: uuidV4,
      startingSequence: safeInteger,
      batch: convertedSchema(typeboxMongoSchema(evidenceBatchSchema)),
      acknowledgement: convertedSchema(typeboxMongoSchema(evidenceBatchAcknowledgementSchema)),
      receivedAt: date,
    },
  },
});

export const evidenceEventCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'ownerAid',
      'evidenceStreamId',
      'batchSaid',
      'runId',
      'sequence',
      'event',
      'receivedAt',
    ],
    properties: {
      _id: said,
      ownerAid: said,
      evidenceStreamId: uuidV4,
      batchSaid: said,
      runId: uuidV4,
      sequence: safeInteger,
      event: convertedSchema(typeboxMongoSchema(evidenceEventSchema)),
      receivedAt: date,
    },
  },
});

/** Exact event validator before the ArtifactUnavailable failure alternative was added. */
export const previousEvidenceEventCollectionValidator = (() => {
  const previous = structuredClone(evidenceEventCollectionValidator);
  const property = (object: unknown, key: string): unknown => {
    if (object === null || typeof object !== 'object') {
      throw new Error('Evidence event migration schema has drifted');
    }
    return Reflect.get(object, key) as unknown;
  };
  let alternatives: unknown = previous;
  for (const key of ['$jsonSchema', 'properties', 'event', 'properties', 'event', 'anyOf']) {
    alternatives = property(alternatives, key);
  }
  if (!Array.isArray(alternatives)) throw new Error('Evidence event migration schema has drifted');
  const effectFailed: unknown = alternatives.find((candidate: unknown) => {
    try {
      return isDeepStrictEqual(
        property(property(property(candidate, 'properties'), 'kind'), 'enum'),
        ['EffectFailed'],
      );
    } catch {
      return false;
    }
  });
  alternatives = effectFailed;
  for (const key of ['properties', 'failure', 'anyOf']) {
    alternatives = property(alternatives, key);
  }
  if (!Array.isArray(alternatives)) throw new Error('Evidence event migration schema has drifted');
  const removed = alternatives.splice(4, 1);
  if (!isDeepStrictEqual(removed, [{ enum: ['ArtifactUnavailable'], type: 'string' }])) {
    throw new Error('Evidence event migration schema has drifted');
  }
  return previous;
})();

export const evidenceCheckpointCollectionValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'ownerAid',
      'evidenceStreamId',
      'batchSaid',
      'runId',
      'checkpoint',
      'receivedAt',
    ],
    properties: {
      _id: said,
      ownerAid: said,
      evidenceStreamId: uuidV4,
      batchSaid: said,
      runId: uuidV4,
      checkpoint: convertedSchema(typeboxMongoSchema(verifiedCheckpointSchema)),
      receivedAt: date,
    },
  },
});

/** Exact validator deployed before the PRD 02 secret-withheld v2 amendment. */
export const previousEvidenceCheckpointCollectionValidator = Object.freeze({
  $jsonSchema: {
    ...evidenceCheckpointCollectionValidator.$jsonSchema,
    properties: {
      ...evidenceCheckpointCollectionValidator.$jsonSchema.properties,
      checkpoint: convertedSchema(typeboxMongoSchema(verifiedCheckpointV1Schema)),
    },
  },
});

export const evidenceUsageCollectionValidator = Object.freeze({
  $jsonSchema: convertedSchema(typeboxMongoSchema(evidenceUsageDocumentSchema)),
});

type EvidenceCollectionValidator =
  | typeof evidenceStreamCollectionValidator
  | typeof evidenceArtifactCollectionValidator
  | typeof evidenceBatchCollectionValidator
  | typeof evidenceEventCollectionValidator
  | typeof evidenceCheckpointCollectionValidator
  | typeof evidenceUsageCollectionValidator;

type EvidenceIndexDefinition = (typeof evidenceIndexDefinitions)[number];

interface ObservedIndex {
  readonly name: string;
  readonly key: unknown;
  readonly unique: boolean | undefined;
}

function decodeObservedIndex(input: unknown): ObservedIndex | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined;
  }
  const name: unknown = Reflect.get(input, 'name');
  const key: unknown = Reflect.get(input, 'key');
  const unique: unknown = Reflect.get(input, 'unique');
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    key === null ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    (unique !== undefined && typeof unique !== 'boolean')
  ) {
    return undefined;
  }
  return { name, key, unique };
}

function decodeObservedIndexes(input: unknown): readonly ObservedIndex[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const decoded: ObservedIndex[] = [];
  for (const candidate of input) {
    const index = decodeObservedIndex(candidate);
    if (index === undefined) {
      return undefined;
    }
    decoded.push(index);
  }
  return decoded;
}

function validatorFor(name: EvidenceCollectionName): EvidenceCollectionValidator {
  switch (name) {
    case 'evidenceStreams':
      return evidenceStreamCollectionValidator;
    case 'artifacts':
      return evidenceArtifactCollectionValidator;
    case 'evidenceBatches':
      return evidenceBatchCollectionValidator;
    case 'evidenceEvents':
      return evidenceEventCollectionValidator;
    case 'checkpoints':
      return evidenceCheckpointCollectionValidator;
    case 'evidenceResourceUsage':
      return evidenceUsageCollectionValidator;
  }
}

function definitionsFor(name: EvidenceCollectionName): readonly EvidenceIndexDefinition[] {
  return evidenceIndexDefinitions.filter((definition) => definition.collection === name);
}

function sameIndex(
  actual: ObservedIndex,
  expected: { readonly name: string; readonly key: unknown; readonly unique?: boolean },
): boolean {
  return (
    actual.name === expected.name &&
    isDeepStrictEqual(actual.key, expected.key) &&
    actual.unique === expected.unique
  );
}

export type EvidenceStorageDriftResource =
  | 'EvidenceStreamCollection'
  | 'EvidenceStreamIndexes'
  | 'EvidenceArtifactCollection'
  | 'EvidenceArtifactIndexes'
  | 'EvidenceBatchCollection'
  | 'EvidenceBatchIndexes'
  | 'EvidenceEventCollection'
  | 'EvidenceEventIndexes'
  | 'EvidenceCheckpointCollection'
  | 'EvidenceCheckpointIndexes'
  | 'EvidenceUsageCollection'
  | 'EvidenceUsageIndexes'
  | 'EvidenceUsageDocument';

export class EvidenceStorageDrift extends Error {
  readonly resource: EvidenceStorageDriftResource;

  constructor(resource: EvidenceStorageDriftResource) {
    super(`${resource} has drifted from the compiled Evidence storage contract`);
    this.name = 'EvidenceStorageDrift';
    this.resource = resource;
  }
}

function collectionResource(name: EvidenceCollectionName): EvidenceStorageDriftResource {
  switch (name) {
    case 'evidenceStreams':
      return 'EvidenceStreamCollection';
    case 'artifacts':
      return 'EvidenceArtifactCollection';
    case 'evidenceBatches':
      return 'EvidenceBatchCollection';
    case 'evidenceEvents':
      return 'EvidenceEventCollection';
    case 'checkpoints':
      return 'EvidenceCheckpointCollection';
    case 'evidenceResourceUsage':
      return 'EvidenceUsageCollection';
  }
}

function indexResource(name: EvidenceCollectionName): EvidenceStorageDriftResource {
  switch (name) {
    case 'evidenceStreams':
      return 'EvidenceStreamIndexes';
    case 'artifacts':
      return 'EvidenceArtifactIndexes';
    case 'evidenceBatches':
      return 'EvidenceBatchIndexes';
    case 'evidenceEvents':
      return 'EvidenceEventIndexes';
    case 'checkpoints':
      return 'EvidenceCheckpointIndexes';
    case 'evidenceResourceUsage':
      return 'EvidenceUsageIndexes';
  }
}

export class MongoEvidenceBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    for (const contract of evidenceCollectionContracts) {
      await this.#bootstrapCollection(contract.name);
    }
    await this.#bootstrapUsageDocument();
    await this.verify();
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
    for (const contract of evidenceCollectionContracts) {
      await this.#verifyCollection(contract.name);
      await this.#verifyIndexes(contract.name);
    }
    const usage: unknown = await this.#database
      .collection<EvidenceUsageDocument>(evidenceCollectionNames.usage)
      .findOne({ _id: evidenceUsageDocumentId });
    try {
      decodeEvidenceUsageDocument(usage);
    } catch {
      throw new EvidenceStorageDrift('EvidenceUsageDocument');
    }
  }

  async #bootstrapCollection(name: EvidenceCollectionName): Promise<void> {
    const current = await this.#database.listCollections({ name }, { nameOnly: false }).next();
    const validator = validatorFor(name);
    if (current === null) {
      await this.#database.createCollection(name, {
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else if (
      name === 'checkpoints' &&
      current.options?.validationLevel === 'strict' &&
      current.options.validationAction === 'error' &&
      isDeepStrictEqual(current.options.validator, previousEvidenceCheckpointCollectionValidator)
    ) {
      await this.#database.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await this.#verifyCollection(name);
    } else if (
      name === evidenceCollectionNames.artifacts &&
      current.options?.validationLevel === 'strict' &&
      current.options.validationAction === 'error' &&
      isDeepStrictEqual(current.options.validator, previousEvidenceArtifactCollectionValidator)
    ) {
      await this.#database.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await this.#verifyCollection(name);
    } else if (
      name === evidenceCollectionNames.events &&
      current.options?.validationLevel === 'strict' &&
      current.options.validationAction === 'error' &&
      isDeepStrictEqual(current.options.validator, previousEvidenceEventCollectionValidator)
    ) {
      await this.#database.command({
        collMod: name,
        validator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await this.#verifyCollection(name);
    } else {
      await this.#verifyCollection(name);
    }
    const collection = this.#database.collection(name);
    let actual = decodeObservedIndexes(await collection.listIndexes().toArray());
    if (actual === undefined) {
      throw new EvidenceStorageDrift(indexResource(name));
    }
    const legacyDefinitions = [
      ...previousSingleIncarnationIndexes.filter((definition) => definition.collection === name),
      ...(name === evidenceCollectionNames.streams ? [previousEvidenceStreamRunIndex] : []),
    ];
    const legacy = actual.filter((index) =>
      legacyDefinitions.some((definition) => definition.name === index.name),
    );
    if (legacy.length > 0) {
      const [currentDefinition] = definitionsFor(name);
      if (currentDefinition === undefined) throw new EvidenceStorageDrift(indexResource(name));
      const currentIndex = actual.find((index) => index.name === currentDefinition.name);
      if (
        legacy.some((index) => {
          const expected = legacyDefinitions.find((definition) => definition.name === index.name);
          return expected === undefined || !sameIndex(index, expected);
        }) ||
        (currentIndex !== undefined && !sameIndex(currentIndex, currentDefinition)) ||
        actual.some(
          (index) =>
            index.name !== '_id_' &&
            index.name !== currentDefinition.name &&
            !legacyDefinitions.some((definition) => definition.name === index.name),
        )
      )
        throw new EvidenceStorageDrift(indexResource(name));
      if (currentIndex === undefined)
        await collection.createIndex(currentDefinition.key, {
          name: currentDefinition.name,
          ...('unique' in currentDefinition ? { unique: currentDefinition.unique } : {}),
        });
      for (const index of legacy) await collection.dropIndex(index.name);
      actual = decodeObservedIndexes(await collection.listIndexes().toArray());
      if (actual === undefined) throw new EvidenceStorageDrift(indexResource(name));
    }
    for (const definition of definitionsFor(name)) {
      const existing = actual.find((index) => index.name === definition.name);
      if (existing === undefined) {
        await collection.createIndex(definition.key, {
          name: definition.name,
          ...('unique' in definition ? { unique: definition.unique } : {}),
        });
      } else if (!sameIndex(existing, definition)) {
        throw new EvidenceStorageDrift(indexResource(name));
      }
    }
  }

  async #bootstrapUsageDocument(): Promise<void> {
    const usage = this.#database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage);
    const current: unknown = await usage.findOne({ _id: evidenceUsageDocumentId });
    if (current === null) {
      await usage.insertOne(evidenceUsageInitialDocument);
      return;
    }
    try {
      decodeEvidenceUsageDocument(current);
    } catch {
      throw new EvidenceStorageDrift('EvidenceUsageDocument');
    }
  }

  async #verifyCollection(name: EvidenceCollectionName): Promise<void> {
    const current = await this.#database.listCollections({ name }, { nameOnly: false }).next();
    const options = current?.options;
    if (
      options === undefined ||
      options.validationLevel !== 'strict' ||
      options.validationAction !== 'error' ||
      !isDeepStrictEqual(options.validator, validatorFor(name))
    ) {
      throw new EvidenceStorageDrift(collectionResource(name));
    }
  }

  async #verifyIndexes(name: EvidenceCollectionName): Promise<void> {
    const actual = decodeObservedIndexes(
      await this.#database.collection(name).listIndexes().toArray(),
    );
    if (actual === undefined) {
      throw new EvidenceStorageDrift(indexResource(name));
    }
    const definitions = definitionsFor(name);
    const expectedNames = new Set(['_id_', ...definitions.map((definition) => definition.name)]);
    if (
      actual.some((index) => !expectedNames.has(index.name)) ||
      definitions.some(
        (definition) =>
          !actual.some((index) => index.name === definition.name && sameIndex(index, definition)),
      )
    ) {
      throw new EvidenceStorageDrift(indexResource(name));
    }
  }
}
