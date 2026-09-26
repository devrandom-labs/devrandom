import { isDeepStrictEqual } from 'node:util';
import Type from 'typebox';

import {
  decodeRunSuccessorSegment,
  retainedRunSuccessorSegmentSchema,
  runSuccessorSegmentSchema,
} from '@devrandom/protocol';
import type { Db } from 'mongodb';

import { typeboxMongoSchema } from '../../infrastructure/typebox-mongo-schema.js';
import { runSuccessorSegmentsCollectionName } from './mongo-run-continuations.js';

export const runSuccessorSegmentValidator = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'ownerAid', 'runId', 'segment', 'acceptedAt'],
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' },
      ownerAid: { bsonType: 'string', pattern: '^[A-Z][A-Za-z0-9_-]{43}$' },
      runId: {
        bsonType: 'string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      },
      segment: typeboxMongoSchema(runSuccessorSegmentSchema),
      acceptedAt: { bsonType: 'date' },
    },
  },
});

// Historical schemas are immutable: the additive field never changes their validators.
const historicalPredecessor = Type.Omit(
  retainedRunSuccessorSegmentSchema.properties.predecessor,
  ['segmentSaid'],
  { additionalProperties: false },
);
const historicalRetained = Type.Object(
  { ...retainedRunSuccessorSegmentSchema.properties, predecessor: historicalPredecessor },
  { additionalProperties: false },
);
const historicalCalibration = Type.Object(
  { ...runSuccessorSegmentSchema.anyOf[1].properties, predecessor: historicalPredecessor },
  { additionalProperties: false },
);
export const unlinkedRunSuccessorSegmentValidator = Object.freeze({
  $jsonSchema: {
    ...runSuccessorSegmentValidator.$jsonSchema,
    properties: {
      ...runSuccessorSegmentValidator.$jsonSchema.properties,
      segment: typeboxMongoSchema(Type.Union([historicalRetained, historicalCalibration])),
    },
  },
});
export const retainedRunSuccessorSegmentValidator = Object.freeze({
  $jsonSchema: {
    ...runSuccessorSegmentValidator.$jsonSchema,
    properties: {
      ...runSuccessorSegmentValidator.$jsonSchema.properties,
      segment: typeboxMongoSchema(historicalRetained),
    },
  },
});

export const runSuccessorSegmentIndex = Object.freeze({
  name: 'run-successor-predecessor-unique',
  key: { runId: 1, 'segment.predecessor.evidenceStreamId': 1 },
  unique: true,
});

export class RunSuccessorSegmentStorageDrift extends Error {
  constructor() {
    super('RunSuccessorSegmentStorageDrift');
    this.name = 'RunSuccessorSegmentStorageDrift';
  }
}

interface ObservedIndex {
  readonly name: string;
  readonly key: object;
  readonly unique: boolean | undefined;
}

function decodeIndexes(input: readonly unknown[]): readonly ObservedIndex[] {
  const decoded: ObservedIndex[] = [];
  for (const value of input) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.keys(value).some((key) => !['v', 'key', 'name', 'unique'].includes(key))
    )
      throw new RunSuccessorSegmentStorageDrift();
    const name: unknown = Reflect.get(value, 'name');
    const key: unknown = Reflect.get(value, 'key');
    const unique: unknown = Reflect.get(value, 'unique');
    if (
      typeof name !== 'string' ||
      key === null ||
      typeof key !== 'object' ||
      Array.isArray(key) ||
      (unique !== undefined && typeof unique !== 'boolean')
    )
      throw new RunSuccessorSegmentStorageDrift();
    decoded.push({ name, key, unique });
  }
  return decoded;
}

/** Explicit storage bootstrap; the successor writer is unavailable until this passes. */
export class MongoRunContinuationBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    const collection = await this.#database
      .listCollections({ name: runSuccessorSegmentsCollectionName }, { nameOnly: false })
      .next();
    if (collection === null) {
      await this.#database.createCollection(runSuccessorSegmentsCollectionName, {
        validator: runSuccessorSegmentValidator,
        validationLevel: 'strict',
        validationAction: 'error',
      });
    } else if (
      collection.options?.validationLevel !== 'strict' ||
      collection.options.validationAction !== 'error' ||
      !isDeepStrictEqual(collection.options.validator, runSuccessorSegmentValidator)
    )
      throw new RunSuccessorSegmentStorageDrift();
    const segments = this.#database.collection(runSuccessorSegmentsCollectionName);
    const indexes = decodeIndexes(await segments.listIndexes().toArray());
    if (
      indexes.some((index) => index.name !== '_id_' && index.name !== runSuccessorSegmentIndex.name)
    )
      throw new RunSuccessorSegmentStorageDrift();
    const existing = indexes.find((index) => index.name === runSuccessorSegmentIndex.name);
    if (existing === undefined)
      await segments.createIndex(runSuccessorSegmentIndex.key, {
        name: runSuccessorSegmentIndex.name,
        unique: true,
      });
    else if (
      !isDeepStrictEqual(existing.key, runSuccessorSegmentIndex.key) ||
      existing.unique !== true
    )
      throw new RunSuccessorSegmentStorageDrift();
    await this.verify();
  }

  /** Explicit additive migration; preserves every existing segment and rejects unrelated drift. */
  async allowCalibrationContinuation(): Promise<void> {
    const collection = await this.#database
      .listCollections({ name: runSuccessorSegmentsCollectionName }, { nameOnly: false })
      .next();
    if (collection === null) {
      await this.bootstrap();
      return;
    }
    const current = isDeepStrictEqual(collection.options?.validator, runSuccessorSegmentValidator);
    const retainedOnly = isDeepStrictEqual(
      collection.options?.validator,
      retainedRunSuccessorSegmentValidator,
    );
    if (
      collection.options?.validationLevel !== 'strict' ||
      collection.options.validationAction !== 'error' ||
      (!current &&
        !retainedOnly &&
        !isDeepStrictEqual(collection.options.validator, unlinkedRunSuccessorSegmentValidator))
    )
      throw new RunSuccessorSegmentStorageDrift();
    const indexes = decodeIndexes(
      await this.#database.collection(runSuccessorSegmentsCollectionName).listIndexes().toArray(),
    );
    if (
      indexes.length !== 2 ||
      !indexes.some((index) => index.name === '_id_') ||
      !indexes.some(
        (index) =>
          index.name === runSuccessorSegmentIndex.name &&
          index.unique === true &&
          isDeepStrictEqual(index.key, runSuccessorSegmentIndex.key),
      )
    )
      throw new RunSuccessorSegmentStorageDrift();
    for await (const document of this.#database
      .collection<{
        _id: string;
        runId: string;
        ownerAid: string;
        segment: unknown;
        acceptedAt: unknown;
      }>(runSuccessorSegmentsCollectionName)
      .find({})) {
      const decoded = decodeRunSuccessorSegment(document['segment']);
      if (
        decoded.kind !== 'Accepted' ||
        (retainedOnly && decoded.segment.version !== 1) ||
        (!current && decoded.segment.predecessor.segmentSaid !== undefined) ||
        Object.keys(document).sort().join(',') !== '_id,acceptedAt,ownerAid,runId,segment' ||
        !(document.acceptedAt instanceof Date) ||
        !Number.isFinite(document.acceptedAt.getTime()) ||
        document.acceptedAt.toISOString() !== decoded.segment.admittedAt ||
        document['_id'] !== decoded.segment.d ||
        document['runId'] !== decoded.segment.runId ||
        document['ownerAid'] !== decoded.segment.ownerAid
      )
        throw new RunSuccessorSegmentStorageDrift();
    }
    if (current) {
      await this.verify();
      return;
    }
    await this.#database.command({
      collMod: runSuccessorSegmentsCollectionName,
      validator: runSuccessorSegmentValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await this.verify();
  }

  async verify(): Promise<void> {
    const collection = await this.#database
      .listCollections({ name: runSuccessorSegmentsCollectionName }, { nameOnly: false })
      .next();
    if (
      collection === null ||
      collection.options?.validationLevel !== 'strict' ||
      collection.options.validationAction !== 'error' ||
      !isDeepStrictEqual(collection.options.validator, runSuccessorSegmentValidator)
    )
      throw new RunSuccessorSegmentStorageDrift();
    const indexes = decodeIndexes(
      await this.#database.collection(runSuccessorSegmentsCollectionName).listIndexes().toArray(),
    );
    if (
      indexes.length !== 2 ||
      !indexes.some((index) => index.name === '_id_') ||
      !indexes.some(
        (index) =>
          index.name === runSuccessorSegmentIndex.name &&
          index.unique === true &&
          isDeepStrictEqual(index.key, runSuccessorSegmentIndex.key),
      )
    )
      throw new RunSuccessorSegmentStorageDrift();
  }
}
