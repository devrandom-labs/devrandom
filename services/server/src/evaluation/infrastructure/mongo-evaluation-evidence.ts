import { isDeepStrictEqual } from 'node:util';

import {
  Binary,
  MongoServerError,
  type Collection,
  type Db,
  type MongoClient,
  type ClientSession,
} from 'mongodb';

import { taskBudgetCeilings } from '@devrandom/domain';
import {
  decodeEvaluationClosure,
  decodeEvaluationEvidenceBatch,
  decodeEvaluationEvidenceEvent,
  decodePublicEvaluationArtifact,
  decodeProtectedEvaluationArtifact,
  evidenceArtifactReferences,
  decodeEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationClosure,
  type EvaluationEvidenceEvent,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import type { EvidenceUsageDocument } from '../../evidence/infrastructure/evidence-usage-document.js';
import {
  decodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import type {
  EvaluationEvidenceAcceptance,
  EvaluationEvidenceBatches,
  EvaluationEvidenceUpload,
} from '../application/accept-evaluation-evidence.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
  type EvaluationPreparationDocument,
} from './mongo-evaluation-reservations.js';

interface EvaluationBatchDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly streamId: string;
  readonly startingSequence: number;
  readonly upload: EvaluationEvidenceUpload;
  readonly acknowledgement: {
    readonly kind: 'Accepted';
    readonly evaluationId: string;
    readonly streamId: string;
    readonly batchSaid: string;
    readonly acceptedThroughSequence: number;
    readonly chainHeadSaid: string;
  };
  readonly acceptedAt: Date;
}

interface EvaluationEventDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly batchSaid: string;
  readonly event: EvaluationEvidenceEvent;
}

interface EvaluationArtifactDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly custody: 'Public' | 'ProtectedCiphertext';
  readonly artifact: EvidenceArtifact | ProtectedEvaluationArtifact;
  readonly bytes?: Binary;
  readonly acceptedAt: Date;
}

export function evaluationEvidenceIndexes() {
  return [
    {
      collection: evaluationCollectionNames.batches,
      name: 'evaluation-batch-start-unique',
      key: { evaluationId: 1, startingSequence: 1 },
      unique: true,
    },
    {
      collection: evaluationCollectionNames.events,
      name: 'evaluation-event-sequence-unique',
      key: { evaluationId: 1, sequence: 1 },
      unique: true,
    },
    {
      collection: evaluationCollectionNames.artifacts,
      name: 'evaluation-artifact-unique',
      key: { evaluationId: 1, 'artifact.d': 1 },
      unique: true,
    },
  ] as const;
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

class EvidenceTransactionAborted extends Error {
  readonly outcome: EvaluationEvidenceAcceptance;

  constructor(outcome: EvaluationEvidenceAcceptance) {
    super(outcome.kind);
    this.outcome = outcome;
  }
}

function referencedArtifacts(event: EvaluationEvidenceEvent): readonly string[] {
  switch (event.detail.kind) {
    case 'ModelExchange':
      return [event.detail.rawArtifactSaid];
    case 'ToolProposed':
      return [event.detail.inputArtifactSaid];
    case 'ToolAuthorization':
    case 'EffectObserved':
      return [event.detail.receiptArtifactSaid];
    case 'ArtifactCaptured':
      return [event.detail.artifactSaid];
    case 'SourceRead':
      return [event.detail.rawArtifactSaid];
    case 'UsageDebited':
    case 'EvaluationBudgetCovered':
    case 'TrialStopped':
    case 'DataWithheld':
      return [];
    case 'EvaluationBudgetDebited':
      return [event.detail.receiptArtifactSaid];
  }
}

/** Atomic native Evaluation stream; a Run's sealed stream is never touched. */
export class MongoEvaluationEvidence implements EvaluationEvidenceBatches {
  readonly #client: MongoClient;
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #batches: Collection<EvaluationBatchDocument>;
  readonly #events: Collection<EvaluationEventDocument>;
  readonly #artifacts: Collection<EvaluationArtifactDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #runEvents: Collection<EvidenceEventDocument>;
  readonly #runArtifacts: Collection<EvidenceArtifactDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
    this.#batches = database.collection(evaluationCollectionNames.batches);
    this.#events = database.collection(evaluationCollectionNames.events);
    this.#artifacts = database.collection(evaluationCollectionNames.artifacts);
    this.#usage = database.collection(evidenceCollectionNames.usage);
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#runEvents = database.collection(evidenceCollectionNames.events);
    this.#runArtifacts = database.collection(evidenceCollectionNames.artifacts);
  }

  async #sourceReadExists(
    evaluation: EvaluationDocument,
    event: EvaluationEvidenceEvent,
    session: ClientSession,
  ): Promise<boolean> {
    const detail = event.detail;
    if (detail.kind !== 'SourceRead') return false;
    const preparation = await this.#preparations.findOne(
      {
        ownerAid: evaluation.ownerAid,
        'sourceInventory.d': evaluation.command.sourceInventorySaid,
      },
      { session },
    );
    const source = preparation?.sourceInventory.sources.find(
      (candidate) =>
        candidate.episodeSaid === detail.sourceSaid &&
        candidate.rawEvidenceSaid === detail.rawArtifactSaid,
    );
    if (source === undefined) return false;
    const episodeDocument = await this.#runEvents.findOne(
      { _id: source.episodeSaid, ownerAid: evaluation.ownerAid },
      { session },
    );
    if (episodeDocument === null) return false;
    const episode = decodeEvidenceEventDocument(episodeDocument).event;
    if (!evidenceArtifactReferences(episode.event).includes(source.rawEvidenceSaid)) return false;
    const artifactDocument = await this.#runArtifacts.findOne(
      {
        _id: evidenceArtifactDocumentId(episode.runId, source.rawEvidenceSaid),
        ownerAid: evaluation.ownerAid,
        runId: episode.runId,
        evidenceStreamId: episodeDocument.evidenceStreamId,
      },
      { session },
    );
    if (artifactDocument === null) return false;
    decodeEvidenceArtifactDocument(artifactDocument);
    return true;
  }

  async accept(input: {
    readonly ownerAid: string;
    readonly upload: EvaluationEvidenceUpload;
  }): Promise<EvaluationEvidenceAcceptance> {
    const { ownerAid, upload } = input;
    const { batch, events, publicArtifacts, protectedArtifacts } = upload;
    if (
      decodeEvaluationEvidenceBatch(batch, events).kind !== 'Accepted' ||
      publicArtifacts.some(
        (artifact) => decodePublicEvaluationArtifact(artifact).kind !== 'Accepted',
      ) ||
      protectedArtifacts.some(
        (artifact) =>
          decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
          artifact.evaluationId !== batch.evaluationId,
      )
    )
      return { kind: 'Rejected', reason: 'InvalidBatch' };
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const prior = await this.#batches.findOne({ _id: batch.d }, { session });
          if (prior !== null)
            return prior.ownerAid === ownerAid && isDeepStrictEqual(prior.upload, upload)
              ? { ...prior.acknowledgement, kind: 'AlreadyAccepted' as const }
              : { kind: 'Conflict' as const };
          const evaluation = await this.#evaluations.findOne(
            { _id: batch.evaluationId, ownerAid },
            { session },
          );
          if (evaluation === null || evaluation.closure !== undefined)
            return { kind: 'Conflict' as const };
          if (
            batch.streamId !== evaluation.evidenceStreamId ||
            batch.originRunId !== evaluation.command.originRunId ||
            batch.taskId !== evaluation.command.taskId ||
            events.some(
              (event) =>
                event.evaluationId !== evaluation._id ||
                event.streamId !== evaluation.evidenceStreamId ||
                event.originRunId !== evaluation.command.originRunId ||
                event.taskId !== evaluation.command.taskId ||
                event.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
                event.personalAgentAid !== evaluation.command.personalAgentAid ||
                event.taskMandateSaid !== evaluation.command.taskMandateSaid,
            )
          )
            return { kind: 'Rejected' as const, reason: 'Binding' as const };
          if (batch.startingSequence !== evaluation.acceptedThroughSequence + 1)
            return batch.startingSequence > evaluation.acceptedThroughSequence + 1
              ? { kind: 'Gap' as const }
              : { kind: 'Conflict' as const };
          if (
            (evaluation.chainHeadSaid === null && batch.predecessor.kind !== 'Genesis') ||
            (evaluation.chainHeadSaid !== null &&
              (batch.predecessor.kind !== 'Previous' ||
                batch.predecessor.eventSaid !== evaluation.chainHeadSaid))
          )
            return { kind: 'Conflict' as const };
          const newArtifacts = new Map<string, 'Public' | 'ProtectedCiphertext'>([
            ...publicArtifacts.map(({ artifact }) => [artifact.d, 'Public'] as const),
            ...protectedArtifacts.map((artifact) => [artifact.d, 'ProtectedCiphertext'] as const),
          ]);
          if (newArtifacts.size !== publicArtifacts.length + protectedArtifacts.length)
            return { kind: 'Conflict' as const };
          for (const event of events) {
            for (const said of referencedArtifacts(event)) {
              if (event.detail.kind === 'SourceRead' && said === event.detail.rawArtifactSaid) {
                if (event.phase.kind === 'Research') {
                  if (await this.#sourceReadExists(evaluation, event, session)) continue;
                  return { kind: 'Rejected' as const, reason: 'MissingBytes' as const };
                }
                // A Trial stages a local frozen source manifest. Its exact raw bytes
                // must be in this Evaluation's public custody under the source SAID.
                if (event.detail.sourceSaid !== said)
                  return { kind: 'Rejected' as const, reason: 'Binding' as const };
              }
              const freshCustody = newArtifacts.get(said);
              if (freshCustody !== undefined) {
                if (
                  (event.detail.kind === 'ArtifactCaptured' &&
                    event.detail.custody !== freshCustody) ||
                  (event.detail.kind === 'SourceRead' && freshCustody !== 'Public')
                )
                  return { kind: 'Rejected' as const, reason: 'Binding' as const };
                continue;
              }
              const stored = await this.#artifacts.findOne(
                { evaluationId: evaluation._id, ownerAid, 'artifact.d': said },
                { session },
              );
              if (stored === null)
                return { kind: 'Rejected' as const, reason: 'MissingBytes' as const };
              if (
                (event.detail.kind === 'ArtifactCaptured' &&
                  event.detail.custody !== stored.custody) ||
                (event.detail.kind === 'SourceRead' && stored.custody !== 'Public')
              )
                return { kind: 'Rejected' as const, reason: 'Binding' as const };
            }
          }
          const publicDecoded = publicArtifacts.map((envelope) =>
            decodePublicEvaluationArtifact(envelope),
          );
          if (publicDecoded.some((decoded) => decoded.kind !== 'Accepted'))
            return { kind: 'Rejected' as const, reason: 'MissingBytes' as const };
          const publicBytes = publicDecoded.reduce(
            (sum, decoded) => sum + (decoded.kind === 'Accepted' ? decoded.bytes.byteLength : 0),
            0,
          );
          const protectedBytes = protectedArtifacts.reduce(
            (sum, artifact) => sum + Buffer.from(artifact.ciphertext, 'base64url').byteLength,
            0,
          );
          const acceptedBytes = batch.encodedByteCount + publicBytes + protectedBytes;
          const ceiling = Math.min(
            evaluation.reserved.evidencePlusArtifactsPerRunBytes,
            taskBudgetCeilings.evidencePlusArtifactsPerRunBytes,
          );
          if (evaluation.acceptedBytes + acceptedBytes > ceiling)
            return { kind: 'QuotaExceeded' as const };
          const usage = await this.#usage.findOneAndUpdate(
            {
              _id: evidenceUsageDocumentId,
              acceptedBytes: {
                $lte: taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes - acceptedBytes,
              },
            },
            { $inc: { acceptedBytes, version: 1 } },
            { session, returnDocument: 'after' },
          );
          if (usage === null) return { kind: 'QuotaExceeded' as const };
          const last = events.at(-1);
          if (last === undefined)
            return { kind: 'Rejected' as const, reason: 'InvalidBatch' as const };
          const acknowledgement = {
            kind: 'Accepted' as const,
            evaluationId: evaluation._id,
            streamId: evaluation.evidenceStreamId,
            batchSaid: batch.d,
            acceptedThroughSequence: last.sequence,
            chainHeadSaid: last.d,
          };
          await this.#batches.insertOne(
            {
              _id: batch.d,
              ownerAid,
              evaluationId: evaluation._id,
              streamId: evaluation.evidenceStreamId,
              startingSequence: batch.startingSequence,
              upload,
              acknowledgement,
              acceptedAt: new Date(),
            },
            { session },
          );
          await this.#events.insertMany(
            events.map((event) => ({
              _id: event.d,
              ownerAid,
              evaluationId: evaluation._id,
              streamId: evaluation.evidenceStreamId,
              sequence: event.sequence,
              batchSaid: batch.d,
              event,
            })),
            { session },
          );
          if (publicArtifacts.length + protectedArtifacts.length > 0)
            await this.#artifacts.insertMany(
              [
                ...publicArtifacts.map((envelope, index) => {
                  const decoded = publicDecoded[index];
                  if (decoded?.kind !== 'Accepted') throw new Error('public artifact decode lost');
                  if (decodeEvidenceArtifact(envelope.artifact, decoded.bytes).kind !== 'Accepted')
                    throw new Error('public artifact changed during transaction');
                  return {
                    _id: envelope.artifact.d,
                    ownerAid,
                    evaluationId: evaluation._id,
                    custody: 'Public' as const,
                    artifact: envelope.artifact,
                    bytes: new Binary(Uint8Array.from(decoded.bytes)),
                    acceptedAt: new Date(),
                  };
                }),
                ...protectedArtifacts.map((artifact) => ({
                  _id: artifact.d,
                  ownerAid,
                  evaluationId: evaluation._id,
                  custody: 'ProtectedCiphertext' as const,
                  artifact,
                  acceptedAt: new Date(),
                })),
              ],
              { session },
            );
          const advanced = await this.#evaluations.updateOne(
            {
              _id: evaluation._id,
              ownerAid,
              version: evaluation.version,
              acceptedThroughSequence: evaluation.acceptedThroughSequence,
            },
            {
              $set: {
                acceptedThroughSequence: last.sequence,
                chainHeadSaid: last.d,
                acceptedBytes: evaluation.acceptedBytes + acceptedBytes,
              },
              $inc: { version: 1 },
            },
            { session },
          );
          if (advanced.matchedCount !== 1)
            throw new EvidenceTransactionAborted({ kind: 'Conflict' });
          return acknowledgement;
        }),
      );
    } catch (error) {
      if (error instanceof EvidenceTransactionAborted) return error.outcome;
      return duplicateKey(error) ? { kind: 'Conflict' } : { kind: 'Unavailable' };
    }
  }

  async close(input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
  }): Promise<
    | { readonly kind: 'Closed' | 'AlreadyClosed'; readonly closureSaid: string }
    | { readonly kind: 'Conflict' | 'Incomplete' | 'Unavailable' }
  > {
    const { ownerAid, closure } = input;
    if (decodeEvaluationClosure(closure).kind !== 'Accepted') return { kind: 'Incomplete' };
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const evaluation = await this.#evaluations.findOne(
            { _id: closure.evaluationId, ownerAid },
            { session },
          );
          if (evaluation === null) return { kind: 'Conflict' as const };
          if (evaluation.closure !== undefined)
            return isDeepStrictEqual(evaluation.closure, closure)
              ? { kind: 'AlreadyClosed' as const, closureSaid: closure.d }
              : { kind: 'Conflict' as const };
          if (
            evaluation.version !== input.expectedEvaluationVersion ||
            evaluation.command.originRunId !== closure.originRunId ||
            evaluation.evidenceStreamId !== closure.evidenceStreamId ||
            evaluation.acceptedThroughSequence + 1 !== closure.acceptedEventCount ||
            evaluation.chainHeadSaid !== closure.acceptedHeadSaid
          )
            return { kind: 'Conflict' as const };
          // The server acknowledges stored bytes; it does not grade or select an arm.
          const requiredSaids = [
            ...closure.observationSaids,
            ...closure.measurementSaids,
            closure.sharedAuditSaid,
            ...Object.values(closure.armAuditSaids),
            closure.protectedCustodySaid,
          ];
          const stored = await this.#artifacts.countDocuments(
            { evaluationId: evaluation._id, ownerAid, 'artifact.d': { $in: requiredSaids } },
            { session },
          );
          if (stored !== new Set(requiredSaids).size) return { kind: 'Incomplete' as const };
          const coverageDocument = await this.#events.findOne(
            {
              ownerAid,
              evaluationId: evaluation._id,
              streamId: evaluation.evidenceStreamId,
              sequence: evaluation.acceptedThroughSequence,
            },
            { session },
          );
          if (
            coverageDocument === null ||
            coverageDocument._id !== evaluation.chainHeadSaid ||
            coverageDocument.event.d !== coverageDocument._id ||
            decodeEvaluationEvidenceEvent(coverageDocument.event).kind !== 'Accepted' ||
            coverageDocument.event.detail.kind !== 'EvaluationBudgetCovered' ||
            coverageDocument.event.sequence !== evaluation.acceptedThroughSequence ||
            coverageDocument.event.detail.throughSequence !==
              evaluation.acceptedThroughSequence - 1 ||
            coverageDocument.event.previous.kind !== 'Previous' ||
            coverageDocument.event.previous.eventSaid !==
              coverageDocument.event.detail.throughHeadSaid
          )
            return { kind: 'Incomplete' as const };
          const predecessor = await this.#events.findOne(
            {
              ownerAid,
              evaluationId: evaluation._id,
              streamId: evaluation.evidenceStreamId,
              sequence: coverageDocument.event.detail.throughSequence,
            },
            { session },
          );
          if (
            predecessor === null ||
            predecessor._id !== coverageDocument.event.detail.throughHeadSaid ||
            predecessor.event.d !== predecessor._id ||
            decodeEvaluationEvidenceEvent(predecessor.event).kind !== 'Accepted'
          )
            return { kind: 'Incomplete' as const };
          // A SAID-valid coverage claim and retained bytes do not prove measured consumption.
          // Until trusted measured-source receipts are verified, the reservation stays held.
          return { kind: 'Incomplete' as const };
        }),
      );
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
