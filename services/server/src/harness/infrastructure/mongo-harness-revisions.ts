import { isDeepStrictEqual } from 'node:util';

import { MongoServerError, type Collection, type Db } from 'mongodb';

import type {
  HarnessRevisionCreation,
  HarnessRevisionInspection,
  HarnessRevisionReconciliation,
  HarnessRevisions,
} from '../application/harness-revisions.js';
import {
  decodeHarnessDocument,
  encodeHarnessDocument,
  type HarnessDocument,
} from './harness-document.js';

export const harnessRevisionsCollectionName = 'harnessRevisions' as const;

export const harnessRevisionIndexNames = Object.freeze({
  ownerCommand: 'harness-owner-command-unique',
  initialLineage: 'harness-initial-lineage-unique',
  ownerTaskRevision: 'harness-owner-task-revision',
});

export const harnessRevisionIndexDefinitions = Object.freeze([
  {
    name: harnessRevisionIndexNames.ownerCommand,
    key: { ownerAid: 1, commandId: 1 },
    unique: true,
  },
  {
    name: harnessRevisionIndexNames.initialLineage,
    key: { ownerAid: 1, harnessLineageId: 1 },
    unique: true,
    partialFilterExpression: { kind: 'InitialSpecialization' },
  },
  {
    name: harnessRevisionIndexNames.ownerTaskRevision,
    key: { ownerAid: 1, taskId: 1, taskRevisionSaid: 1 },
  },
] as const);

function duplicateKey(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}

export class MongoHarnessRevisions implements HarnessRevisions {
  readonly #revisions: Collection<HarnessDocument>;

  constructor(database: Db) {
    this.#revisions = database.collection<HarnessDocument>(harnessRevisionsCollectionName);
  }

  async reconcile(
    ownerAid: string,
    commandId: string,
    commandFingerprint: string,
  ): Promise<HarnessRevisionReconciliation> {
    try {
      const existing = await this.#byCommand(ownerAid, commandId);
      if (existing === undefined) {
        return { kind: 'NoHarnessRevision' };
      }
      return existing.commandFingerprint === commandFingerprint
        ? { kind: 'ExistingHarnessRevision', projection: existing.projection }
        : { kind: 'HarnessCommandConflict' };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async create(input: Parameters<HarnessRevisions['create']>[0]): Promise<HarnessRevisionCreation> {
    try {
      await this.#revisions.insertOne(
        encodeHarnessDocument(input.projection, input.commandFingerprint),
      );
      return { kind: 'HarnessRevisionCreated' };
    } catch (error) {
      if (!duplicateKey(error)) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
      try {
        const command = await this.#byCommand(
          input.projection.ownerAid,
          input.projection.commandId,
        );
        if (command !== undefined) {
          return command.commandFingerprint === input.commandFingerprint
            ? { kind: 'ExistingHarnessRevision', projection: command.projection }
            : { kind: 'HarnessCommandConflict' };
        }
        const saidDocument = await this.#revisions.findOne({
          _id: input.projection.revision.d,
        });
        if (saidDocument !== null) {
          const existing = decodeHarnessDocument(saidDocument);
          return existing.projection.ownerAid === input.projection.ownerAid &&
            isDeepStrictEqual(existing.projection.revision, input.projection.revision)
            ? { kind: 'ExistingHarnessRevision', projection: existing.projection }
            : { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
        }
        const lineage = await this.#revisions.findOne({
          ownerAid: input.projection.ownerAid,
          harnessLineageId: input.projection.revision.task.harnessLineageId,
          kind: 'InitialSpecialization',
        });
        return lineage === null
          ? { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }
          : { kind: 'HarnessLineageConflict' };
      } catch {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
    }
  }

  async findAccepted(
    ownerAid: string,
    harnessRevisionSaid: string,
  ): Promise<HarnessRevisionInspection> {
    try {
      const document = await this.#revisions.findOne({ _id: harnessRevisionSaid, ownerAid });
      if (document === null) {
        return { kind: 'HarnessNotFound' };
      }
      const decoded = decodeHarnessDocument(document);
      return {
        kind: 'AcceptedHarnessFound',
        projection: decoded.projection,
        activation: decoded.activation,
      };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #byCommand(ownerAid: string, commandId: string) {
    const document = await this.#revisions.findOne({ ownerAid, commandId });
    return document === null ? undefined : decodeHarnessDocument(document);
  }
}
