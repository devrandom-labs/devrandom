import { isDeepStrictEqual } from 'node:util';

import {
  Binary,
  MongoServerError,
  type Collection,
  type Db,
  type MongoClient,
  type ClientSession,
} from 'mongodb';

import {
  evaluationConsumables,
  taskBudgetCeilings,
  type EvaluationAllowance,
  type EvaluationConsumable,
} from '@devrandom/domain';
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
import type { EvaluationManifestLockDocument } from './mongo-evaluation-manifest-locks.js';

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

type DebitedBudget = Exclude<EvaluationConsumable, 'evidencePlusArtifactsPerRunBytes'>;
const debitedBudgets: readonly DebitedBudget[] = evaluationConsumables.filter(
  (budget) => budget !== 'evidencePlusArtifactsPerRunBytes',
);

export type EvaluationBudgetCoverageReplay =
  | {
      readonly kind: 'StructurallyConsistent';
      readonly totals: Readonly<Record<DebitedBudget, number>>;
      readonly receiptArtifactSaids: readonly string[];
    }
  | {
      readonly kind: 'Incomplete';
      readonly reason:
        | 'EventChainInvalid'
        | 'MissingCoverage'
        | 'SourceMissing'
        | 'DebitSequenceInvalid'
        | 'BudgetExceeded'
        | 'TotalsMismatch'
        | 'ProviderUsageUnlinked'
        | 'MissingDimension';
    };

/** Structural replay only: it does not attest provider, clock, child, or worktree measurements. */
export function replayEvaluationBudgetCoverage(input: {
  readonly events: readonly EvaluationEvidenceEvent[];
  readonly reserved: EvaluationAllowance;
}): EvaluationBudgetCoverageReplay {
  if (input.events.length < 2 || input.events.length > 10_000)
    return { kind: 'Incomplete', reason: 'EventChainInvalid' };
  if (
    debitedBudgets.some(
      (budget) =>
        !Number.isSafeInteger(input.reserved[budget]) ||
        input.reserved[budget] < 0 ||
        input.reserved[budget] > taskBudgetCeilings[budget],
    )
  )
    return { kind: 'Incomplete', reason: 'BudgetExceeded' };
  const first = input.events[0];
  const last = input.events.at(-1);
  if (first === undefined || last?.detail.kind !== 'EvaluationBudgetCovered')
    return { kind: 'Incomplete', reason: 'MissingCoverage' };
  const totals = Object.fromEntries(debitedBudgets.map((budget) => [budget, 0])) as Record<
    DebitedBudget,
    number
  >;
  const seen = new Set<DebitedBudget>();
  const prior = new Map<string, EvaluationEvidenceEvent>();
  const receiptArtifactSaids = new Set<string>();
  for (const [index, event] of input.events.entries()) {
    const predecessor = input.events[index - 1];
    if (
      decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== index ||
      event.evaluationId !== first.evaluationId ||
      event.streamId !== first.streamId ||
      event.originRunId !== first.originRunId ||
      event.taskId !== first.taskId ||
      event.taskRevisionSaid !== first.taskRevisionSaid ||
      event.personalAgentAid !== first.personalAgentAid ||
      event.taskMandateSaid !== first.taskMandateSaid ||
      (index === 0
        ? event.previous.kind !== 'Genesis'
        : event.previous.kind !== 'Previous' || event.previous.eventSaid !== predecessor?.d)
    )
      return { kind: 'Incomplete', reason: 'EventChainInvalid' };
    if (event.detail.kind === 'EvaluationBudgetCovered' && index !== input.events.length - 1)
      return { kind: 'Incomplete', reason: 'MissingCoverage' };
    if (event.detail.kind === 'EvaluationBudgetDebited') {
      const debit = event.detail;
      // TypeBox's mapped literal union erases this property to `never` in Static.
      const budget = debit.budget as DebitedBudget;
      const source =
        debit.sourceEventSaid === undefined ? undefined : prior.get(debit.sourceEventSaid);
      if (
        source === undefined ||
        (budget.startsWith('provider') && source.detail.kind !== 'ModelExchange') ||
        (budget === 'toolProposals' && source.detail.kind !== 'ToolProposed')
      )
        return { kind: 'Incomplete', reason: 'SourceMissing' };
      const next = totals[budget] + debit.amount;
      if (
        !Number.isSafeInteger(next) ||
        next > input.reserved[budget] ||
        next > taskBudgetCeilings[budget]
      )
        return { kind: 'Incomplete', reason: 'BudgetExceeded' };
      if (debit.consumed !== next) return { kind: 'Incomplete', reason: 'DebitSequenceInvalid' };
      totals[budget] = next;
      seen.add(budget);
      receiptArtifactSaids.add(debit.receiptArtifactSaid);
    }
    prior.set(event.d, event);
  }
  const coverage = last.detail;
  if (
    coverage.throughSequence !== last.sequence - 1 ||
    coverage.throughHeadSaid !== input.events.at(-2)?.d ||
    debitedBudgets.some((budget) => coverage.totals[budget] !== totals[budget])
  )
    return { kind: 'Incomplete', reason: 'TotalsMismatch' };
  if (coverage.providerUsageEventSaids.length !== totals.providerRequests)
    return { kind: 'Incomplete', reason: 'ProviderUsageUnlinked' };
  if (debitedBudgets.some((budget) => !seen.has(budget)))
    return { kind: 'Incomplete', reason: 'MissingDimension' };
  return {
    kind: 'StructurallyConsistent',
    totals,
    receiptArtifactSaids: [...receiptArtifactSaids],
  };
}

/** Atomic native Evaluation stream; a Run's sealed stream is never touched. */
export class MongoEvaluationEvidence implements EvaluationEvidenceBatches {
  readonly #client: MongoClient;
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #batches: Collection<EvaluationBatchDocument>;
  readonly #events: Collection<EvaluationEventDocument>;
  readonly #artifacts: Collection<EvaluationArtifactDocument>;
  readonly #manifestLocks: Collection<EvaluationManifestLockDocument>;
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
    this.#manifestLocks = database.collection(evaluationCollectionNames.manifests);
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
          const trialEvents = events.filter((event) => event.phase.kind === 'Trial');
          if (trialEvents.length > 0) {
            const locked = await this.#manifestLocks.findOne(
              { _id: evaluation._id, ownerAid },
              { session },
            );
            if (
              locked === null ||
              trialEvents.some((event) => {
                const phase = event.phase;
                if (phase.kind !== 'Trial') return true;
                const arm = phase.arm as 'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch';
                const slot = locked.manifest.slots.find(
                  (candidate) =>
                    candidate.arm === arm &&
                    candidate.repetition === phase.repetition &&
                    candidate.attempt === phase.attempt,
                );
                const revision =
                  arm === 'H1TaskSearch'
                    ? locked.manifest.revisions.H1
                    : locked.manifest.revisions[arm];
                return (
                  phase.manifestSaid !== locked.manifest.d ||
                  slot === undefined ||
                  event.harnessRevisionSaid !== revision
                );
              })
            )
              return { kind: 'Rejected' as const, reason: 'Binding' as const };
          }
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
          if (
            new Set(requiredSaids).size !== requiredSaids.length ||
            evaluation.acceptedThroughSequence < 1 ||
            evaluation.acceptedThroughSequence >= 10_000
          )
            return { kind: 'Incomplete' as const };
          const eventDocuments = await this.#events
            .find(
              {
                ownerAid,
                evaluationId: evaluation._id,
                streamId: evaluation.evidenceStreamId,
                sequence: { $lte: evaluation.acceptedThroughSequence },
              },
              { session },
            )
            .sort({ sequence: 1 })
            .limit(10_001)
            .toArray();
          if (
            eventDocuments.length !== evaluation.acceptedThroughSequence + 1 ||
            eventDocuments.some(
              ({ _id, event }) =>
                _id !== event.d ||
                event.evaluationId !== evaluation._id ||
                event.streamId !== evaluation.evidenceStreamId ||
                event.originRunId !== evaluation.command.originRunId ||
                event.taskId !== evaluation.command.taskId ||
                event.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
                event.personalAgentAid !== evaluation.command.personalAgentAid ||
                event.taskMandateSaid !== evaluation.command.taskMandateSaid,
            ) ||
            eventDocuments.at(-1)?.event.d !== evaluation.chainHeadSaid
          )
            return { kind: 'Incomplete' as const };
          const replay = replayEvaluationBudgetCoverage({
            events: eventDocuments.map(({ event }) => event),
            reserved: evaluation.reserved,
          });
          if (replay.kind !== 'StructurallyConsistent') return { kind: 'Incomplete' as const };
          const captured = new Map<string, 'Public' | 'ProtectedCiphertext'>();
          for (const { event } of eventDocuments)
            if (event.detail.kind === 'ArtifactCaptured')
              captured.set(event.detail.artifactSaid, event.detail.custody);
          if (
            requiredSaids.some(
              (said) =>
                captured.get(said) !==
                (said === closure.protectedCustodySaid ? 'ProtectedCiphertext' : 'Public'),
            )
          )
            return { kind: 'Incomplete' as const };
          const artifactSaids = [...new Set([...requiredSaids, ...replay.receiptArtifactSaids])];
          if (replay.receiptArtifactSaids.some((said) => captured.get(said) !== 'Public'))
            return { kind: 'Incomplete' as const };
          const artifactDocuments = await this.#artifacts
            .find(
              { evaluationId: evaluation._id, ownerAid, 'artifact.d': { $in: artifactSaids } },
              { session },
            )
            .limit(artifactSaids.length + 1)
            .toArray();
          if (artifactDocuments.length !== artifactSaids.length)
            return { kind: 'Incomplete' as const };
          for (const stored of artifactDocuments) {
            if (stored._id !== stored.artifact.d || !artifactSaids.includes(stored._id))
              return { kind: 'Incomplete' as const };
            if (stored._id === closure.protectedCustodySaid) {
              const protectedArtifact = decodeProtectedEvaluationArtifact(stored.artifact);
              if (
                stored.custody !== 'ProtectedCiphertext' ||
                protectedArtifact.kind !== 'Accepted' ||
                protectedArtifact.artifact.evaluationId !== evaluation._id
              )
                return { kind: 'Incomplete' as const };
            } else if (
              stored.custody !== 'Public' ||
              !(stored.bytes instanceof Binary) ||
              decodeEvidenceArtifact(stored.artifact, Uint8Array.from(stored.bytes.buffer)).kind !==
                'Accepted'
            )
              return { kind: 'Incomplete' as const };
          }
          // A SAID-valid coverage claim and retained bytes do not prove measured consumption.
          // The current producer omits four dimensions and no independent source proves
          // provider, clock, child-command, or worktree measurements. Hold the reservation.
          return { kind: 'Incomplete' as const };
        }),
      );
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
