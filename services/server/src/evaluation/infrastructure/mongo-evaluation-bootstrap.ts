import { isDeepStrictEqual } from 'node:util';

import type { Db } from 'mongodb';
import Type from 'typebox';

import {
  evaluationAdmissionCommandSchema,
  evaluationClosureSchema,
  evidenceArtifactSchema,
  evaluationEvidenceEventSchema,
  evaluationEvidenceUploadSchema,
  evaluationLeaseRenewalCommandSchema,
  evaluationExecutionProfileSchema,
  evaluationPreparationCommandSchema,
  evaluationSourceInventorySchema,
  protectedEvaluationArtifactSchema,
} from '@devrandom/protocol';

import {
  typeboxMongoSchema,
  type MongoSchemaObject,
} from '../../infrastructure/typebox-mongo-schema.js';
import { evaluationEvidenceIndexes } from './mongo-evaluation-evidence.js';
import {
  evaluationCollectionNames,
  evaluationReservationIndexes,
} from './mongo-evaluation-reservations.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const safe = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const date = { bsonType: 'date' } as const;

function object(schema: unknown): MongoSchemaObject {
  const converted = typeboxMongoSchema(schema);
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted))
    throw new Error('evaluation Mongo schema must be an object');
  const root = Object.assign({}, converted) as MongoSchemaObject;
  if (root['type'] === 'object') {
    delete root['type'];
    root['bsonType'] = 'object';
  }
  return root;
}

const allowance = Type.Object(
  {
    providerRequests: safe,
    providerInputTokens: safe,
    providerOutputTokens: safe,
    providerSpendMicroUsd: safe,
    runWallTimeSeconds: safe,
    toolProposals: safe,
    aggregateChildCommandTimeSeconds: safe,
    changedFiles: safe,
    changedWorktreeBytes: safe,
    evidencePlusArtifactsPerRunBytes: safe,
  },
  { additionalProperties: false },
);
const lease = Type.Object(
  {
    evaluationId: uuid,
    leaseId: uuid,
    version: safe,
    serverTime: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);

const validators: Record<string, { $jsonSchema: MongoSchemaObject }> = {
  [evaluationCollectionNames.renewals]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'ownerAid', 'command', 'receipt', 'acceptedAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^[0-9a-f-]{36}:[0-9a-f-]{36}$' },
        ownerAid: object(said),
        command: object(evaluationLeaseRenewalCommandSchema),
        receipt: object(
          Type.Object(
            {
              kind: Type.Literal('Renewed'),
              evaluationId: uuid,
              version: safe,
              lease,
            },
            { additionalProperties: false },
          ),
        ),
        acceptedAt: date,
      },
    },
  },
  [evaluationCollectionNames.preparations]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'ownerAid', 'command', 'sourceInventory', 'executionProfile', 'acceptedAt'],
      properties: {
        _id: object(uuid),
        ownerAid: object(said),
        command: object(evaluationPreparationCommandSchema),
        sourceInventory: object(evaluationSourceInventorySchema),
        executionProfile: object(evaluationExecutionProfileSchema),
        acceptedAt: date,
      },
    },
  },
  [evaluationCollectionNames.evaluations]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'ownerAid',
        'command',
        'reserved',
        'reservationSaid',
        'evidenceStreamId',
        'version',
        'lease',
        'acceptedThroughSequence',
        'chainHeadSaid',
        'acceptedBytes',
        'acceptedAt',
      ],
      properties: {
        _id: object(uuid),
        ownerAid: object(said),
        command: object(evaluationAdmissionCommandSchema),
        reserved: object(allowance),
        reservationSaid: object(said),
        evidenceStreamId: object(uuid),
        version: object(safe),
        lease: object(lease),
        acceptedThroughSequence: {
          bsonType: 'number',
          minimum: -1,
          maximum: Number.MAX_SAFE_INTEGER,
          multipleOf: 1,
        },
        chainHeadSaid: { anyOf: [object(said), { bsonType: 'null' }] },
        acceptedBytes: object(safe),
        activeOwnerSlot: object(said),
        closure: object(evaluationClosureSchema),
        acceptedAt: date,
      },
    },
  },
  [evaluationCollectionNames.batches]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        '_id',
        'ownerAid',
        'evaluationId',
        'streamId',
        'startingSequence',
        'upload',
        'acknowledgement',
        'acceptedAt',
      ],
      properties: {
        _id: object(said),
        ownerAid: object(said),
        evaluationId: object(uuid),
        streamId: object(uuid),
        startingSequence: object(safe),
        upload: object(evaluationEvidenceUploadSchema),
        acknowledgement: object(
          Type.Object(
            {
              kind: Type.Literal('Accepted'),
              evaluationId: uuid,
              streamId: uuid,
              batchSaid: said,
              acceptedThroughSequence: safe,
              chainHeadSaid: said,
            },
            { additionalProperties: false },
          ),
        ),
        acceptedAt: date,
      },
    },
  },
  [evaluationCollectionNames.events]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'ownerAid', 'evaluationId', 'streamId', 'sequence', 'batchSaid', 'event'],
      properties: {
        _id: object(said),
        ownerAid: object(said),
        evaluationId: object(uuid),
        streamId: object(uuid),
        sequence: object(safe),
        batchSaid: object(said),
        event: object(evaluationEvidenceEventSchema),
      },
    },
  },
  [evaluationCollectionNames.artifacts]: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'ownerAid', 'evaluationId', 'custody', 'artifact', 'acceptedAt'],
      properties: {
        _id: object(said),
        ownerAid: object(said),
        evaluationId: object(uuid),
        custody: object(Type.Union([Type.Literal('Public'), Type.Literal('ProtectedCiphertext')])),
        artifact: {
          oneOf: [object(evidenceArtifactSchema), object(protectedEvaluationArtifactSchema)],
        },
        bytes: { bsonType: 'binData' },
        acceptedAt: date,
      },
    },
  },
};

export class MongoEvaluationBootstrap {
  readonly #database: Db;

  constructor(database: Db) {
    this.#database = database;
  }

  async bootstrap(): Promise<void> {
    for (const [name, validator] of Object.entries(validators)) {
      const [existing] = await this.#database.listCollections({ name }).toArray();
      if (existing === undefined) {
        await this.#database.createCollection(name, { validator });
      } else if (
        !isDeepStrictEqual(
          typeof Reflect.get(existing, 'options') === 'object' &&
            Reflect.get(existing, 'options') !== null
            ? Reflect.get(Reflect.get(existing, 'options') as object, 'validator')
            : undefined,
          validator,
        )
      ) {
        throw new Error(`Evaluation collection ${name} validator drift`);
      }
    }
    for (const definition of [...evaluationReservationIndexes(), ...evaluationEvidenceIndexes()]) {
      const collection = this.#database.collection(definition.collection);
      const existing: unknown[] = await collection.listIndexes().toArray();
      if (
        existing.some(
          (index) =>
            typeof index === 'object' &&
            index !== null &&
            'name' in index &&
            index.name === definition.name,
        )
      )
        continue;
      await collection.createIndex(definition.key, {
        name: definition.name,
        unique: definition.unique,
        ...('partialFilterExpression' in definition
          ? { partialFilterExpression: definition.partialFilterExpression }
          : {}),
      });
    }
  }
}
