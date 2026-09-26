import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { MongoServerError, type Collection, type Db, type MongoClient } from 'mongodb';

import {
  evaluationLeasePolicy,
  renewEvaluationLease,
  type EvaluationAllowance,
} from '@devrandom/domain';
import {
  decodeEvaluationExecutionProfile,
  decodeEvaluationSourceInventory,
  evidenceArtifactReferences,
  evaluationAdmissionCommandSchema,
  evaluationAdmissionReceiptSchema,
  evaluationPreparationCommandSchema,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  decodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import type { EvidenceCheckpointDocument } from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import type { EvidenceStreamDocument } from '../../evidence/infrastructure/evidence-stream-document.js';
import { decodeEvidenceStreamDocument } from '../../evidence/infrastructure/evidence-stream-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import type {
  EvaluationAdmissionCommand,
  EvaluationAdmissionReceipt,
  EvaluationReservations,
} from '../application/admit-evaluation.js';
import type { EvaluationPreparationStorage } from '../application/prepare-evaluation.js';
import type {
  EvaluationLeaseRenewalCommand,
  EvaluationLeaseRenewalReceipt,
  EvaluationLeases,
} from '../application/renew-evaluation-lease.js';

export const evaluationCollectionNames = Object.freeze({
  preparations: 'evaluationPreparations',
  evaluations: 'evaluations',
  renewals: 'evaluationLeaseRenewals',
  batches: 'evaluationEvidenceBatches',
  events: 'evaluationEvidenceEvents',
  artifacts: 'evaluationEvidenceArtifacts',
});

export interface EvaluationPreparationDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly command: Type.Static<typeof evaluationPreparationCommandSchema>;
  readonly sourceInventory: EvaluationSourceInventory;
  readonly executionProfile: EvaluationExecutionProfile;
  readonly acceptedAt: Date;
}

export interface EvaluationDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly command: EvaluationAdmissionCommand;
  readonly reserved: EvaluationAllowance;
  readonly reservationSaid: string;
  readonly evidenceStreamId: string;
  readonly version: number;
  readonly lease: {
    readonly evaluationId: string;
    readonly leaseId: string;
    readonly version: number;
    readonly serverTime: string;
    readonly expiresAt: string;
  };
  readonly acceptedThroughSequence: number;
  readonly chainHeadSaid: string | null;
  readonly acceptedBytes: number;
  readonly activeOwnerSlot?: string;
  readonly closure?: unknown;
  readonly acceptedAt: Date;
}

interface EvaluationRenewalDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly command: EvaluationLeaseRenewalCommand;
  readonly receipt: Extract<EvaluationLeaseRenewalReceipt, { kind: 'Renewed' | 'AlreadyRenewed' }>;
  readonly acceptedAt: Date;
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

export function evaluationReservationIndexes() {
  return [
    {
      collection: evaluationCollectionNames.evaluations,
      name: 'evaluation-owner-command-unique',
      key: { ownerAid: 1, 'command.commandId': 1 },
      unique: true,
    },
    {
      collection: evaluationCollectionNames.evaluations,
      name: 'evaluation-active-owner-unique',
      key: { activeOwnerSlot: 1 },
      unique: true,
      partialFilterExpression: { activeOwnerSlot: { $exists: true } },
    },
  ] as const;
}

/** Preparation persists signed source/profile bytes without asserting they prove containment. */
export class MongoEvaluationPreparations implements EvaluationPreparationStorage {
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;

  constructor(database: Db) {
    this.#preparations = database.collection<EvaluationPreparationDocument>(
      evaluationCollectionNames.preparations,
    );
    this.#events = database.collection(evidenceCollectionNames.events);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
  }

  async store(input: {
    readonly ownerAid: string;
    readonly command: Type.Static<typeof evaluationPreparationCommandSchema>;
  }): Promise<'Prepared' | 'AlreadyPrepared' | 'Rejected' | 'Conflict' | 'Unavailable'> {
    const { command, ownerAid } = input;
    if (
      !Value.Check(evaluationPreparationCommandSchema, command) ||
      decodeEvaluationSourceInventory(command.sourceInventory).kind !== 'Accepted' ||
      decodeEvaluationExecutionProfile(command.executionProfile).kind !== 'Accepted' ||
      command.sourceInventory.ownerAid !== ownerAid ||
      command.sourceInventory.taskId !== command.taskId ||
      command.sourceInventory.taskRevisionSaid !== command.taskRevisionSaid
    )
      return 'Rejected';
    const document: EvaluationPreparationDocument = {
      _id: command.commandId,
      ownerAid,
      command,
      sourceInventory: command.sourceInventory,
      executionProfile: command.executionProfile,
      acceptedAt: new Date(),
    };
    try {
      const previous = await this.#preparations.findOne({ _id: command.commandId, ownerAid });
      if (previous !== null)
        return isDeepStrictEqual(previous.command, command) ? 'AlreadyPrepared' : 'Conflict';
      for (const source of command.sourceInventory.sources) {
        const eventDocument = await this.#events.findOne({ _id: source.episodeSaid, ownerAid });
        if (eventDocument === null) return 'Rejected';
        const event = decodeEvidenceEventDocument(eventDocument).event;
        if (!evidenceArtifactReferences(event.event).includes(source.rawEvidenceSaid))
          return 'Rejected';
        const artifactDocument = await this.#artifacts.findOne({
          _id: evidenceArtifactDocumentId(event.runId, source.rawEvidenceSaid),
          ownerAid,
          runId: event.runId,
          evidenceStreamId: eventDocument.evidenceStreamId,
        });
        if (artifactDocument === null) return 'Rejected';
        decodeEvidenceArtifactDocument(artifactDocument);
      }
      await this.#preparations.insertOne(document);
      return 'Prepared';
    } catch (error) {
      if (duplicateKey(error)) return 'Conflict';
      return 'Unavailable';
    }
  }
}

/** Native Evaluation reservation; the retained Run and its sealed stream are read only. */
export class MongoEvaluationReservations implements EvaluationReservations, EvaluationLeases {
  readonly #client: MongoClient;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #renewals: Collection<EvaluationRenewalDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #events: Collection<EvidenceEventDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
    this.#renewals = database.collection(evaluationCollectionNames.renewals);
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#events = database.collection(evidenceCollectionNames.events);
  }

  async reconcile(input: {
    readonly ownerAid: string;
    readonly command: EvaluationAdmissionCommand;
  }): ReturnType<EvaluationReservations['reconcile']> {
    try {
      const previous = await this.#evaluations.findOne({
        ownerAid: input.ownerAid,
        'command.commandId': input.command.commandId,
      });
      if (previous === null) return { kind: 'NotFound' };
      if (!Value.Check(evaluationAdmissionCommandSchema, previous.command))
        return { kind: 'Unavailable' };
      if (!isDeepStrictEqual(previous.command, input.command)) return { kind: 'Conflict' };
      const receipt = {
        kind: 'Admitted' as const,
        evaluationId: previous._id,
        version: previous.version,
        lease: previous.lease,
        evidenceStreamId: previous.evidenceStreamId,
        reservationSaid: previous.reservationSaid,
      };
      return receipt.lease.evaluationId === receipt.evaluationId &&
        Value.Check(evaluationAdmissionReceiptSchema, receipt)
        ? receipt
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async reserve(input: {
    readonly ownerAid: string;
    readonly command: EvaluationAdmissionCommand;
    readonly reserved: EvaluationAllowance;
  }): Promise<EvaluationAdmissionReceipt> {
    const { command, ownerAid } = input;
    try {
      return await this.#client.withSession(async (session) => {
        return session.withTransaction(async () => {
          const previous = await this.#evaluations.findOne(
            { ownerAid, 'command.commandId': command.commandId },
            { session },
          );
          if (previous !== null) {
            return isDeepStrictEqual(previous.command, command)
              ? {
                  kind: 'Admitted' as const,
                  evaluationId: previous._id,
                  version: previous.version,
                  lease: previous.lease,
                  evidenceStreamId: previous.evidenceStreamId,
                  reservationSaid: previous.reservationSaid,
                }
              : { kind: 'Conflict' as const };
          }
          const preparation = await this.#preparations.findOne(
            {
              ownerAid,
              'command.taskId': command.taskId,
              'sourceInventory.d': command.sourceInventorySaid,
              'executionProfile.d': command.executionProfileSaid,
            },
            { session },
          );
          const runDocument = await this.#runs.findOne(
            { _id: command.originRunId, ownerAid },
            { session },
          );
          if (preparation === null || runDocument === null)
            return {
              kind: 'Blocked' as const,
              gate: preparation === null ? ('Profile' as const) : ('Qualification' as const),
            };
          const run = decodeRunDocument(runDocument).run;
          if (
            run.binding.purpose.kind !== 'Retained' ||
            run.binding.taskId !== command.taskId ||
            run.binding.taskRevisionSaid !== command.taskRevisionSaid ||
            run.binding.personalAgentAid !== command.personalAgentAid ||
            run.binding.taskMandateSaid !== command.taskMandateSaid ||
            run.binding.initialHarnessRevisionSaid !== command.expectedActiveRevisionSaid ||
            run.lifecycle.kind !== 'Active' ||
            run.lifecycle.phase.kind !== 'Blocked' ||
            run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure' ||
            preparation.executionProfile.sourceGitCommit !== run.binding.repository.commit ||
            preparation.executionProfile.sourceGitTree !== run.binding.repository.tree
          )
            return { kind: 'Blocked' as const, gate: 'Qualification' as const };
          const streamDocument = await this.#streams.findOne(
            { _id: run.binding.evidenceStreamId, 'binding.runId': command.originRunId },
            { session },
          );
          if (streamDocument === null)
            return { kind: 'Blocked' as const, gate: 'Evidence' as const };
          const stream = decodeEvidenceStreamDocument(streamDocument);
          if (
            stream.seal.kind !== 'Sealed' ||
            stream.seal.exchangeSaid !== command.retainedSealSaid ||
            stream.cursor.kind !== 'Continued'
          )
            return { kind: 'Blocked' as const, gate: 'Evidence' as const };
          const checkpoint = await this.#checkpoints.findOne(
            { _id: command.retainedCheckpointSaid, ownerAid, runId: command.originRunId },
            { session },
          );
          if (
            checkpoint === null ||
            checkpoint.evidenceStreamId !== run.binding.evidenceStreamId ||
            checkpoint.checkpoint.taskRevisionSaid !== command.taskRevisionSaid ||
            checkpoint.checkpoint.runId !== command.originRunId ||
            checkpoint.checkpoint.personalAgentAid !== command.personalAgentAid ||
            checkpoint.checkpoint.harnessRevisionSaid !== command.expectedActiveRevisionSaid ||
            checkpoint.checkpoint.evidence.finalSequence > stream.cursor.acceptedThrough ||
            checkpoint.checkpoint.evidence.eventCount > stream.cursor.acceptedThrough + 1
          )
            return { kind: 'Blocked' as const, gate: 'Evidence' as const };
          const checkpointHead = await this.#events.findOne(
            {
              ownerAid,
              runId: command.originRunId,
              sequence: checkpoint.checkpoint.evidence.finalSequence,
              'event.d': checkpoint.checkpoint.evidence.chainHeadSaid,
            },
            { session },
          );
          if (checkpointHead === null)
            return { kind: 'Blocked' as const, gate: 'Evidence' as const };
          const now = new Date();
          const evaluationId = randomUUID();
          const lease = {
            evaluationId,
            leaseId: randomUUID(),
            version: 1,
            serverTime: now.toISOString(),
            expiresAt: new Date(
              now.valueOf() + evaluationLeasePolicy.leaseSeconds * 1000,
            ).toISOString(),
          };
          const evidenceStreamId = randomUUID();
          const reservationBytes = new TextEncoder().encode(
            JSON.stringify({
              evaluationId,
              ownerAid,
              commandId: command.commandId,
              originRunId: command.originRunId,
              reserved: input.reserved,
            }),
          );
          const preparedReservation = prepareEvidenceArtifact(reservationBytes, 'application/json');
          if (preparedReservation.kind !== 'Prepared')
            return { kind: 'Blocked' as const, gate: 'Budget' as const };
          const reservationSaid = preparedReservation.artifact.d;
          const document: EvaluationDocument = {
            _id: evaluationId,
            ownerAid,
            command,
            reserved: input.reserved,
            reservationSaid,
            evidenceStreamId,
            version: 1,
            lease,
            acceptedThroughSequence: -1,
            chainHeadSaid: null,
            acceptedBytes: 0,
            activeOwnerSlot: ownerAid,
            acceptedAt: now,
          };
          await this.#evaluations.insertOne(document, { session });
          return {
            kind: 'Admitted' as const,
            evaluationId,
            version: 1,
            lease,
            evidenceStreamId,
            reservationSaid,
          };
        });
      });
    } catch (error) {
      return duplicateKey(error) ? { kind: 'Conflict' } : { kind: 'Unavailable' };
    }
  }

  async renew(input: {
    readonly ownerAid: string;
    readonly command: EvaluationLeaseRenewalCommand;
  }): Promise<EvaluationLeaseRenewalReceipt> {
    const { ownerAid, command } = input;
    const renewalId = `${command.evaluationId}:${command.commandId}`;
    const reconcile = async (): Promise<EvaluationLeaseRenewalReceipt | undefined> => {
      const previous = await this.#renewals.findOne({ _id: renewalId });
      if (previous === null) return undefined;
      return previous.ownerAid === ownerAid && isDeepStrictEqual(previous.command, command)
        ? { ...previous.receipt, kind: 'AlreadyRenewed' }
        : { kind: 'Conflict' };
    };
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const previous = await this.#renewals.findOne({ _id: renewalId }, { session });
          if (previous !== null)
            return previous.ownerAid === ownerAid && isDeepStrictEqual(previous.command, command)
              ? { ...previous.receipt, kind: 'AlreadyRenewed' as const }
              : { kind: 'Conflict' as const };
          const evaluation = await this.#evaluations.findOne(
            { _id: command.evaluationId, ownerAid },
            { session },
          );
          if (evaluation === null || evaluation.lease.leaseId !== command.leaseId)
            return { kind: 'Lost' as const, evaluationId: command.evaluationId };
          if (evaluation.closure !== undefined)
            return { kind: 'Blocked' as const, gate: 'Closed' as const };
          if (evaluation.version !== command.expectedEvaluationVersion)
            return { kind: 'Conflict' as const };
          const next = renewEvaluationLease(evaluation.lease, new Date().toISOString());
          if (next.kind === 'Lost')
            return { kind: 'Lost' as const, evaluationId: command.evaluationId };
          if (next.kind !== 'Renewed') return { kind: 'Conflict' as const };
          const updated = await this.#evaluations.updateOne(
            {
              _id: evaluation._id,
              ownerAid,
              version: evaluation.version,
              closure: { $exists: false },
            },
            { $set: { lease: next.lease }, $inc: { version: 1 } },
            { session },
          );
          if (updated.matchedCount !== 1) return { kind: 'Conflict' as const };
          const receipt = {
            kind: 'Renewed' as const,
            evaluationId: evaluation._id,
            version: evaluation.version + 1,
            lease: next.lease,
          };
          await this.#renewals.insertOne(
            {
              _id: renewalId,
              ownerAid,
              command,
              receipt,
              acceptedAt: new Date(),
            },
            { session },
          );
          return receipt;
        }),
      );
    } catch {
      return (await reconcile()) ?? { kind: 'Unavailable' };
    }
  }
}
