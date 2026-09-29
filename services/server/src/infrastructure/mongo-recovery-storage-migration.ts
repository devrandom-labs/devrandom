import Type from 'typebox';
import Value from 'typebox/value';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';
import { taskCollectionValidator } from '../task/infrastructure/mongo-task-bootstrap.js';
import { taskIndexDefinitions } from '../task/infrastructure/mongo-tasks.js';
import { decodeTaskDocument } from '../task/infrastructure/task-document.js';
import { runCollectionValidator } from '../run/infrastructure/mongo-run-bootstrap.js';
import { runIndexDefinitions } from '../run/infrastructure/mongo-runs.js';
import { decodeRunDocument } from '../run/infrastructure/run-document.js';
import { harnessCollectionValidator } from '../harness/infrastructure/mongo-harness-bootstrap.js';
import { harnessRevisionIndexDefinitions } from '../harness/infrastructure/mongo-harness-revisions.js';
import { decodeHarnessDocument } from '../harness/infrastructure/harness-document.js';
import { evidenceCheckpointCollectionValidator } from '../evidence/infrastructure/mongo-evidence-bootstrap.js';
import { evidenceIndexDefinitions } from '../evidence/infrastructure/evidence-storage-contract.js';
import { decodeEvidenceCheckpointDocument } from '../evidence/infrastructure/evidence-checkpoint-document.js';

interface MongoStorageObject {
  readonly [field: string]: unknown;
}
function record(value: unknown): value is MongoStorageObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function previous(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(previous);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'runsPerAdmittedUser' && record(child) && child['maximum'] === 16
        ? { ...child, maximum: 10 }
        : key === 'tasksPerAdmittedUser' && record(child) && child['maximum'] === 6
          ? { ...child, maximum: 5 }
          : key === 'ownerSlot' && record(child) && child['maximum'] === 5
            ? { ...child, maximum: 4 }
            : previous(child),
    ]),
  );
}
function validatorPair(target: Document) {
  const old = previous(target);
  if (!record(old) || isDeepStrictEqual(old, target))
    throw new Error('RecoveryValidatorHasNoDelta');
  return { previousValidator: old, targetValidator: target };
}
/** Closed deployment catalog. Historical maxima and every unrelated validator property are fixed. */
export const recoveryStorageMigrationCatalog = [
  { name: 'tasks', ...validatorPair(taskCollectionValidator), indexes: taskIndexDefinitions },
  { name: 'runs', ...validatorPair(runCollectionValidator), indexes: runIndexDefinitions },
  {
    name: 'harnessRevisions',
    ...validatorPair(harnessCollectionValidator),
    indexes: harnessRevisionIndexDefinitions,
  },
  {
    name: 'checkpoints',
    ...validatorPair(evidenceCheckpointCollectionValidator),
    indexes: evidenceIndexDefinitions.filter((index) => index.collection === 'checkpoints'),
  },
] as const;

export interface RecoveryStorageMigrationEntry {
  readonly name: string;
  readonly disposition: 'RequiresMigration' | 'Current';
  readonly documentCount: number;
  readonly documentHash: string;
  readonly previousValidator: Document;
  readonly targetValidator: Document;
  readonly previousValidatorHash: string;
  readonly targetValidatorHash: string;
  readonly indexes: readonly Document[];
}
export type RecoveryStorageMigrationInspection =
  | { readonly kind: 'Prepared'; readonly collections: readonly RecoveryStorageMigrationEntry[] }
  | {
      readonly kind: 'Rejected';
      readonly collection: string;
      readonly reason:
        'MissingCollection' | 'OptionsDrift' | 'ValidatorDrift' | 'IndexDrift' | 'DocumentInvalid';
    }
  | { readonly kind: 'Unavailable' };
const observedIndexesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String(),
      key: Type.Unknown(),
      unique: Type.Optional(Type.Boolean()),
      partialFilterExpression: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
  ),
);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only deployment inspection. No collMod, creation, data rewrite, or authorization side effect. */
export class MongoRecoveryStorageMigration {
  readonly #database: Db;
  constructor(database: Db) {
    this.#database = database;
  }
  async inspect(): Promise<RecoveryStorageMigrationInspection> {
    try {
      const collections: RecoveryStorageMigrationEntry[] = [];
      for (const entry of recoveryStorageMigrationCatalog) {
        const reject = (
          reason: Extract<RecoveryStorageMigrationInspection, { kind: 'Rejected' }>['reason'],
        ): RecoveryStorageMigrationInspection => ({
          kind: 'Rejected',
          collection: entry.name,
          reason,
        });
        const observed = await this.#database
          .listCollections({ name: entry.name }, { nameOnly: false })
          .next();
        if (observed === null) return reject('MissingCollection');
        const options = observed.options;
        if (
          options?.validationLevel !== 'strict' ||
          options.validationAction !== 'error' ||
          Object.keys(options).some(
            (key) => !['validator', 'validationLevel', 'validationAction'].includes(key),
          )
        )
          return reject('OptionsDrift');
        const observedValidator: unknown = options.validator;
        if (!record(observedValidator)) return reject('ValidatorDrift');
        const current = isDeepStrictEqual(observedValidator, entry.targetValidator);
        if (!current && !isDeepStrictEqual(observedValidator, entry.previousValidator))
          return reject('ValidatorDrift');
        const indexes: unknown = await this.#database
          .collection(entry.name)
          .listIndexes()
          .toArray();
        if (!Value.Check(observedIndexesSchema, indexes)) return reject('IndexDrift');
        const named = indexes.filter((index) => index.name !== '_id_');
        if (
          named.length !== entry.indexes.length ||
          entry.indexes.some((expected) => {
            const actual = named.find((index) => index.name === expected.name);
            return (
              actual === undefined ||
              !isDeepStrictEqual(actual.key, expected.key) ||
              actual.unique !== ('unique' in expected ? expected.unique : undefined) ||
              !isDeepStrictEqual(
                actual.partialFilterExpression,
                'partialFilterExpression' in expected
                  ? expected.partialFilterExpression
                  : undefined,
              )
            );
          })
        )
          return reject('IndexDrift');
        if (
          (await this.#database
            .collection(entry.name)
            .findOne({ $nor: [entry.targetValidator] })) !== null
        )
          return reject('DocumentInvalid');
        const digest = createHash('sha256');
        let count = 0;
        for await (const document of this.#database
          .collection(entry.name)
          .find({})
          .sort({ _id: 1 })) {
          try {
            if (entry.name === 'tasks') decodeTaskDocument(document);
            else if (entry.name === 'runs') decodeRunDocument(document);
            else if (entry.name === 'harnessRevisions') decodeHarnessDocument(document);
            else {
              const checkpoint: unknown = document['checkpoint'];
              if (!record(checkpoint)) return reject('DocumentInvalid');
              const taskId = checkpoint['taskId'];
              const ownerAid: unknown = document['ownerAid'];
              if (typeof taskId !== 'string' || typeof ownerAid !== 'string')
                return reject('DocumentInvalid');
              const actualTask = await this.#database
                .collection<{ _id: string; ownerAid: string }>('tasks')
                .findOne({ _id: taskId, ownerAid });
              if (actualTask === null) return reject('DocumentInvalid');
              const decoded = decodeTaskDocument(actualTask).task;
              decodeEvidenceCheckpointDocument(
                document,
                decoded.revision.completionConditions.map((condition) => condition.id),
              );
            }
          } catch {
            return reject('DocumentInvalid');
          }
          digest.update(JSON.stringify(document)).update('\n');
          count += 1;
        }
        collections.push({
          name: entry.name,
          disposition: current ? 'Current' : 'RequiresMigration',
          documentCount: count,
          documentHash: digest.digest('hex'),
          previousValidator: observedValidator,
          targetValidator: entry.targetValidator,
          previousValidatorHash: hash(observedValidator),
          targetValidatorHash: hash(entry.targetValidator),
          indexes,
        });
      }
      return { kind: 'Prepared', collections };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
