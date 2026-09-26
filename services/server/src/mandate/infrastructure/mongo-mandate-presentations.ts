import { isDeepStrictEqual } from 'node:util';

import { MongoServerError, type Collection, type Db } from 'mongodb';

import type {
  MandatePresentationCommit,
  MandatePresentationCreation,
  MandatePresentationReconciliation,
  MandatePresentationInspection,
  MandatePresentations,
  StoredMandatePresentation,
  AdmittedTaskMandatePresentations,
} from '../application/presentations.js';
import type { MandatePresentation } from '../domain/presentation.js';
import {
  decodeMandatePresentationDocument,
  encodeMandatePresentationDocument,
  type MandatePresentationDocument,
} from './presentation-document.js';

export const mandatePresentationsCollectionName = 'mandatePresentations' as const;

export const mandatePresentationIndexNames = Object.freeze({
  ownerCredential: 'mandate-presentation-owner-credential-unique',
  grant: 'mandate-presentation-grant-unique',
  pendingExpiry: 'mandate-presentation-pending-expiry',
  admittedTask: 'mandate-presentation-admitted-task',
});

export const mandatePresentationIndexDefinitions = Object.freeze([
  {
    name: mandatePresentationIndexNames.ownerCredential,
    key: { ownerAid: 1, credentialSaid: 1 },
    unique: true,
  },
  {
    name: mandatePresentationIndexNames.grant,
    key: { grantSaid: 1 },
    unique: true,
  },
  {
    name: mandatePresentationIndexNames.pendingExpiry,
    key: { cleanupAt: 1 },
    expireAfterSeconds: 0,
  },
  {
    name: mandatePresentationIndexNames.admittedTask,
    key: {
      ownerAid: 1,
      mandateKind: 1,
      'state.kind': 1,
      'acceptedReference.taskId': 1,
      'acceptedReference.taskRevisionSaid': 1,
      'state.admittedAt': -1,
    },
  },
] as const);

function duplicateKey(cause: unknown): cause is MongoServerError {
  return cause instanceof MongoServerError && cause.code === 11_000;
}

export class MongoMandatePresentations implements MandatePresentations {
  readonly #presentations: Collection<MandatePresentationDocument>;

  constructor(database: Db) {
    this.#presentations = database.collection<MandatePresentationDocument>(
      mandatePresentationsCollectionName,
    );
  }

  async reconcile(
    ownerAid: string,
    credentialSaid: string,
    grantSaid: string,
  ): Promise<MandatePresentationReconciliation> {
    try {
      const existing = await this.#presentations.findOne({ ownerAid, credentialSaid });
      if (existing === null) {
        return { kind: 'NoPresentation' };
      }
      const stored = decodeMandatePresentationDocument(existing);
      return stored.presentation.binding.grantSaid === grantSaid
        ? { kind: 'ExistingPresentation', stored }
        : { kind: 'PresentationConflict' };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async create(presentation: MandatePresentation): Promise<MandatePresentationCreation> {
    const stored: StoredMandatePresentation = { revision: 0, presentation };
    try {
      await this.#presentations.insertOne(encodeMandatePresentationDocument(stored));
      return { kind: 'PresentationCreated', stored };
    } catch (cause) {
      if (!duplicateKey(cause)) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
      const reconciliation = await this.reconcile(
        presentation.binding.ownerAid,
        presentation.binding.credentialSaid,
        presentation.binding.grantSaid,
      );
      return reconciliation.kind === 'NoPresentation'
        ? { kind: 'PresentationConflict' }
        : reconciliation;
    }
  }

  async findAdmittedTaskMandates(
    ownerAid: string,
    taskId: string,
    taskRevisionSaid: string,
  ): Promise<AdmittedTaskMandatePresentations> {
    try {
      const documents = await this.#presentations
        .find({
          ownerAid,
          mandateKind: 'TaskMandate',
          'state.kind': 'Admitted',
          'acceptedReference.taskId': taskId,
          'acceptedReference.taskRevisionSaid': taskRevisionSaid,
        })
        .sort({ 'state.admittedAt': -1 })
        .limit(16)
        .toArray();
      if (documents.length === 0) {
        return { kind: 'NoAdmittedTaskMandate' };
      }
      return {
        kind: 'AdmittedTaskMandatesFound',
        presentations: documents.map((document) => decodeMandatePresentationDocument(document)),
      };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async findByCredential(
    ownerAid: string,
    credentialSaid: string,
  ): Promise<MandatePresentationInspection> {
    try {
      const document = await this.#presentations.findOne({ ownerAid, credentialSaid });
      return document === null
        ? { kind: 'PresentationNotFound' }
        : { kind: 'PresentationFound', stored: decodeMandatePresentationDocument(document) };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async commit(
    current: StoredMandatePresentation,
    presentation: MandatePresentation,
  ): Promise<MandatePresentationCommit> {
    if (!isDeepStrictEqual(current.presentation.binding, presentation.binding)) {
      return { kind: 'PresentationConcurrentlyModified' };
    }
    const next: StoredMandatePresentation = {
      revision: current.revision + 1,
      presentation,
    };
    try {
      const committed = await this.#presentations.replaceOne(
        {
          _id: current.presentation.binding.credentialSaid,
          revision: current.revision,
          ownerAid: current.presentation.binding.ownerAid,
        },
        encodeMandatePresentationDocument(next),
      );
      return committed.matchedCount === 1
        ? { kind: 'PresentationCommitted', stored: next }
        : { kind: 'PresentationConcurrentlyModified' };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }
}
