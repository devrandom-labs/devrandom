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
  assessTamperAuditScope,
  closeComparison,
  evaluationConsumables,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  type EvaluationAllowance,
  type EvaluationConsumable,
} from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationClosure,
  decodeEvaluationClosureEvidenceIndex,
  decodeEvaluationEvidenceBatch,
  decodeEvaluationEvidenceEvent,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  decodeTrialObservationEvidence,
  decodeComparisonMeasurementEvidence,
  prepareEvaluationAuditAssessmentArtifact,
  decodePublicEvaluationArtifact,
  decodeProtectedEvaluationArtifact,
  evidenceArtifactReferences,
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationClosure,
  type EvaluationEvidenceEvent,
  type ProtectedEvaluationArtifact,
  type TrialObservationEvidence,
  type ComparisonMeasurementEvidence,
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
import {
  decodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import type {
  EvaluationEvidenceAcceptance,
  EvaluationEvidenceBatches,
  EvaluationEvidenceUpload,
} from '../application/accept-evaluation-evidence.js';
import type { AcceptedEvaluationEvidenceReading } from '../application/read-accepted-evaluation-evidence.js';
import type { EvaluationClosureIndexCustody } from '../application/close-evaluation.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
  type EvaluationPreparationDocument,
} from './mongo-evaluation-reservations.js';
import type { EvaluationManifestLockDocument } from './mongo-evaluation-manifest-locks.js';
import type { SettledEvaluationDebit } from './mongo-task-residual-allowance.js';

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

interface TaskReservationFenceDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly taskRevisionSaid: string;
  readonly version: number;
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
    case 'ProviderUsageVerified':
      return [event.detail.receiptArtifactSaid, event.detail.providerReportArtifactSaid];
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

/** Structural replay of an already admitted reservation; it does not authorize that reservation.
 * Admission intersects the signed Task and mandate with residual spend. The reservation remains
 * the effective limit for v1 and v2 Tasks; the supported v2 ceiling is only an outer sanity bound.
 * This replay does not attest provider, clock, child, or worktree measurements.
 */
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
        input.reserved[budget] > taskEvaluationBudgetCeilings[budget],
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
  const providerEvents: EvaluationEvidenceEvent[] = [];
  const providerDebits = new Map<string, { receiptSaid: string; budgets: Set<DebitedBudget> }>();
  const captured = new Map<string, EvaluationEvidenceEvent>();
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
    if (event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public')
      captured.set(event.detail.artifactSaid, event);
    if (event.detail.kind === 'ProviderUsageVerified') {
      const detail = event.detail;
      const source = prior.get(detail.modelExchangeEventSaid);
      const receipt = captured.get(detail.receiptArtifactSaid);
      const report = captured.get(detail.providerReportArtifactSaid);
      if (
        source?.detail.kind !== 'ModelExchange' ||
        source.sequence >= event.sequence ||
        source.harnessRevisionSaid !== event.harnessRevisionSaid ||
        JSON.stringify(source.phase) !== JSON.stringify(event.phase) ||
        receipt === undefined ||
        report === undefined ||
        receipt.sequence <= source.sequence ||
        report.sequence <= source.sequence ||
        receipt.sequence >= event.sequence ||
        report.sequence >= event.sequence ||
        receipt.harnessRevisionSaid !== source.harnessRevisionSaid ||
        report.harnessRevisionSaid !== source.harnessRevisionSaid ||
        !isDeepStrictEqual(receipt.phase, source.phase) ||
        !isDeepStrictEqual(report.phase, source.phase) ||
        providerEvents.some(
          (known) =>
            known.detail.kind === 'ProviderUsageVerified' &&
            known.detail.modelExchangeEventSaid === detail.modelExchangeEventSaid,
        )
      )
        return { kind: 'Incomplete', reason: 'ProviderUsageUnlinked' };
      providerEvents.push(event);
    }
    if (event.detail.kind === 'EvaluationBudgetDebited') {
      const debit = event.detail;
      const budget = debit.budget;
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
        next > taskEvaluationBudgetCeilings[budget]
      )
        return { kind: 'Incomplete', reason: 'BudgetExceeded' };
      if (debit.consumed !== next) return { kind: 'Incomplete', reason: 'DebitSequenceInvalid' };
      totals[budget] = next;
      seen.add(budget);
      receiptArtifactSaids.add(debit.receiptArtifactSaid);
      if (budget.startsWith('provider')) {
        const previousGroup = providerDebits.get(source.d);
        if (previousGroup !== undefined && previousGroup.receiptSaid !== debit.receiptArtifactSaid)
          return { kind: 'Incomplete', reason: 'ProviderUsageUnlinked' };
        const group = previousGroup ?? {
          receiptSaid: debit.receiptArtifactSaid,
          budgets: new Set<DebitedBudget>(),
        };
        if (group.budgets.has(budget))
          return { kind: 'Incomplete', reason: 'ProviderUsageUnlinked' };
        group.budgets.add(budget);
        providerDebits.set(source.d, group);
      }
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
  if (
    providerEvents.length !== providerDebits.size ||
    !isDeepStrictEqual(
      coverage.providerUsageEventSaids,
      providerEvents.map((event) => event.d),
    ) ||
    providerEvents.some((event) => {
      if (event.detail.kind !== 'ProviderUsageVerified') return true;
      const group = providerDebits.get(event.detail.modelExchangeEventSaid);
      return (
        group?.receiptSaid !== event.detail.receiptArtifactSaid ||
        group.budgets.size !== 4 ||
        ![
          'providerRequests',
          'providerInputTokens',
          'providerOutputTokens',
          'providerSpendMicroUsd',
        ].every((budget) => group.budgets.has(budget as DebitedBudget))
      );
    })
  )
    return { kind: 'Incomplete', reason: 'ProviderUsageUnlinked' };
  return {
    kind: 'StructurallyConsistent',
    totals,
    receiptArtifactSaids: [...receiptArtifactSaids],
  };
}

/** Atomic native Evaluation stream; a Run's sealed stream is never touched. */
export class MongoEvaluationEvidence
  implements EvaluationEvidenceBatches, AcceptedEvaluationEvidenceReading
{
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
  readonly #harnesses: Collection<HarnessDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #taskReservationFences: Collection<TaskReservationFenceDocument>;

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
    this.#harnesses = database.collection(harnessRevisionsCollectionName);
    this.#runs = database.collection(runsCollectionName);
    this.#taskReservationFences = database.collection(
      evaluationCollectionNames.taskReservationFences,
    );
  }

  async readPosition(
    input: Parameters<AcceptedEvaluationEvidenceReading['readPosition']>[0],
  ): ReturnType<AcceptedEvaluationEvidenceReading['readPosition']> {
    const { ownerAid, evaluationId } = input;
    try {
      const evaluation = await this.#evaluations.findOne({ _id: evaluationId, ownerAid });
      if (evaluation === null) return { kind: 'Denied' };
      const { lease, acceptedThroughSequence, chainHeadSaid } = evaluation;
      if (
        !Number.isSafeInteger(evaluation.version) ||
        evaluation.version < 1 ||
        evaluation.closure !== undefined ||
        lease.evaluationId !== evaluationId ||
        !Number.isSafeInteger(lease.version) ||
        lease.version < 1 ||
        !Number.isFinite(Date.parse(lease.serverTime)) ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= Date.now() ||
        !Number.isSafeInteger(acceptedThroughSequence) ||
        acceptedThroughSequence < -1 ||
        acceptedThroughSequence > 9_999 ||
        (acceptedThroughSequence === -1) !== (chainHeadSaid === null)
      )
        return { kind: 'Conflict' };
      if (acceptedThroughSequence >= 0) {
        const head = await this.#events.findOne({
          evaluationId,
          ownerAid,
          streamId: evaluation.evidenceStreamId,
          sequence: acceptedThroughSequence,
        });
        if (
          head === null ||
          head._id !== chainHeadSaid ||
          head.event.d !== chainHeadSaid ||
          decodeEvaluationEvidenceEvent(head.event).kind !== 'Accepted'
        )
          return { kind: 'Conflict' };
      }
      return {
        kind: 'Read',
        position: {
          version: 1,
          currentEvaluationVersion: evaluation.version,
          evaluationId,
          ownerAid,
          commandId: evaluation.command.commandId,
          originRunId: evaluation.command.originRunId,
          streamId: evaluation.evidenceStreamId,
          reservationSaid: evaluation.reservationSaid,
          lease,
          acceptedThroughSequence,
          chainHeadSaid,
        },
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async readPage(
    input: Parameters<AcceptedEvaluationEvidenceReading['readPage']>[0],
  ): ReturnType<AcceptedEvaluationEvidenceReading['readPage']> {
    const { ownerAid, evaluationId, afterSequence, throughSequence, throughHeadSaid } = input;
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < -1 ||
      !Number.isSafeInteger(throughSequence) ||
      throughSequence > 9_999 ||
      throughSequence <= afterSequence ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(throughHeadSaid)
    )
      return { kind: 'Conflict' };
    try {
      const evaluation = await this.#evaluations.findOne({ _id: evaluationId, ownerAid });
      if (evaluation === null) return { kind: 'Denied' };
      if (evaluation.acceptedThroughSequence < throughSequence) return { kind: 'Conflict' };
      const head = await this.#events.findOne({
        evaluationId,
        ownerAid,
        streamId: evaluation.evidenceStreamId,
        sequence: throughSequence,
      });
      if (
        head === null ||
        head._id !== throughHeadSaid ||
        head.event.d !== throughHeadSaid ||
        head.event.sequence !== throughSequence ||
        head.event.evaluationId !== evaluationId ||
        head.event.streamId !== evaluation.evidenceStreamId ||
        decodeEvaluationEvidenceEvent(head.event).kind !== 'Accepted'
      )
        return { kind: 'Conflict' };
      const end = Math.min(throughSequence, afterSequence + 32);
      const documents = await this.#events
        .find({
          evaluationId,
          ownerAid,
          streamId: evaluation.evidenceStreamId,
          sequence: { $gt: afterSequence, $lte: end },
        })
        .sort({ sequence: 1 })
        .limit(32)
        .toArray();
      if (
        documents.length !== end - afterSequence ||
        documents.some(
          (document, index) =>
            document.sequence !== afterSequence + index + 1 ||
            document._id !== document.event.d ||
            document.event.sequence !== document.sequence ||
            document.event.evaluationId !== evaluationId ||
            document.event.streamId !== evaluation.evidenceStreamId ||
            decodeEvaluationEvidenceEvent(document.event).kind !== 'Accepted',
        )
      )
        return { kind: 'Conflict' };
      return {
        kind: 'Read',
        page: {
          version: 1,
          evaluationId,
          streamId: evaluation.evidenceStreamId,
          afterSequence,
          throughSequence,
          throughHeadSaid,
          events: documents.map((document) => document.event),
        },
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async readPublicArtifact(
    input: Parameters<AcceptedEvaluationEvidenceReading['readPublicArtifact']>[0],
  ): ReturnType<AcceptedEvaluationEvidenceReading['readPublicArtifact']> {
    const { ownerAid, evaluationId, artifactSaid } = input;
    if (!/^[A-Z][A-Za-z0-9_-]{43}$/u.test(artifactSaid)) return { kind: 'Conflict' };
    try {
      const evaluation = await this.#evaluations.findOne({ _id: evaluationId, ownerAid });
      if (evaluation === null) return { kind: 'Denied' };
      const stored = await this.#artifacts.findOne({
        _id: artifactSaid,
        ownerAid,
        evaluationId,
        custody: 'Public',
      });
      if (stored === null) return { kind: 'Missing' };
      if (!(stored.bytes instanceof Binary) || stored.artifact.d !== artifactSaid)
        return { kind: 'Conflict' };
      const bytes = Uint8Array.from(stored.bytes.buffer);
      const decoded = decodeEvidenceArtifact(stored.artifact, bytes);
      if (decoded.kind !== 'Accepted' || bytes.byteLength > 384 * 1_024)
        return { kind: 'Conflict' };
      return { kind: 'Read', artifact: decoded.artifact, bytes };
    } catch {
      return { kind: 'Unavailable' };
    }
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

  async #activeInitialH1(evaluation: EvaluationDocument, session: ClientSession): Promise<boolean> {
    const command = evaluation.command;
    const harnessDocument = await this.#harnesses.findOne(
      { _id: command.expectedActiveRevisionSaid, ownerAid: evaluation.ownerAid },
      { session },
    );
    const runDocument = await this.#runs.findOne(
      { _id: command.originRunId, ownerAid: evaluation.ownerAid },
      { session },
    );
    if (harnessDocument === null || runDocument === null) return false;
    try {
      const harness = decodeHarnessDocument(harnessDocument);
      const run = decodeRunDocument(runDocument).run;
      return (
        harness.activation.kind === 'InitialSpecializationAccepted' &&
        harness.activation.harnessRevisionSaid === command.expectedActiveRevisionSaid &&
        harness.activation.runId === run.binding.initialSpecialization.runId &&
        harness.activation.harnessLineageId === run.binding.harnessLineageId &&
        harness.activation.acceptedAt === run.binding.initialSpecialization.acceptedAt &&
        harness.projection.ownerAid === evaluation.ownerAid &&
        harness.projection.revision.task.taskId === command.taskId &&
        harness.projection.revision.task.revisionSaid === command.taskRevisionSaid &&
        run.binding.purpose.kind === 'Retained' &&
        run.binding.ownerAid === evaluation.ownerAid &&
        run.binding.taskId === command.taskId &&
        run.binding.taskRevisionSaid === command.taskRevisionSaid &&
        run.binding.personalAgentAid === command.personalAgentAid &&
        run.binding.taskMandateSaid === command.taskMandateSaid &&
        run.binding.initialHarnessRevisionSaid === command.expectedActiveRevisionSaid &&
        run.binding.harnessLineageId === harness.projection.revision.task.harnessLineageId &&
        run.lifecycle.kind === 'Active' &&
        run.lifecycle.phase.kind === 'Blocked' &&
        run.lifecycle.phase.reason === 'HarnessCompatibilityFailure'
      );
    } catch {
      return false;
    }
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
                const arm = phase.arm;
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
            taskEvaluationBudgetCeilings.evidencePlusArtifactsPerRunBytes,
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

  async reconcile(input: {
    readonly ownerAid: string;
    readonly closure: EvaluationClosure;
    readonly evidenceIndex: EvaluationClosureIndexCustody;
  }): Promise<
    | { readonly kind: 'AlreadyClosed'; readonly closureSaid: string }
    | { readonly kind: 'NotFound' | 'Conflict' | 'Unavailable' }
  > {
    try {
      const evaluation = await this.#evaluations.findOne({
        _id: input.closure.evaluationId,
        ownerAid: input.ownerAid,
      });
      if (evaluation === null || evaluation.closure === undefined) return { kind: 'NotFound' };
      if (decodeEvaluationClosure(evaluation.closure).kind !== 'Accepted')
        return { kind: 'Unavailable' };
      if (!isDeepStrictEqual(evaluation.closure, input.closure)) return { kind: 'Conflict' };
      const decodedIndex = decodeEvaluationClosureEvidenceIndex(
        input.evidenceIndex.artifact,
        input.evidenceIndex.bytes,
      );
      if (
        decodedIndex.kind !== 'Accepted' ||
        decodedIndex.artifact.d !== input.closure.evidenceIndexSaid ||
        decodedIndex.index.evaluationId !== evaluation._id ||
        decodedIndex.index.manifestSaid !== input.closure.manifestSaid ||
        !isDeepStrictEqual(
          decodedIndex.index.observations.map((entry) => entry.artifactSaid),
          input.closure.observationSaids,
        ) ||
        !isDeepStrictEqual(
          decodedIndex.index.measurements.map((entry) => entry.artifactSaid),
          input.closure.measurementSaids,
        )
      )
        return { kind: 'Unavailable' };
      const settled = (evaluation as EvaluationDocument & { settledDebit?: SettledEvaluationDebit })
        .settledDebit;
      if (
        settled === undefined ||
        settled.closureSaid !== input.closure.d ||
        evaluation.activeOwnerSlot !== undefined ||
        Object.keys(settled.consumed).length !== evaluationConsumables.length ||
        evaluationConsumables.some(
          (name) =>
            !Number.isSafeInteger(settled.consumed[name]) ||
            settled.consumed[name] < 0 ||
            settled.consumed[name] > evaluation.reserved[name],
        )
      )
        return { kind: 'Unavailable' };
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          evaluationId: evaluation._id,
          closureSaid: input.closure.d,
          consumed: settled.consumed,
        }),
      );
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared' || prepared.artifact.d !== settled.artifactSaid)
        return { kind: 'Unavailable' };
      const stored = await this.#artifacts.findOne({
        _id: settled.artifactSaid,
        ownerAid: input.ownerAid,
        evaluationId: evaluation._id,
        custody: 'Public',
      });
      if (
        stored === null ||
        !(stored.bytes instanceof Binary) ||
        !isDeepStrictEqual(stored.artifact, prepared.artifact) ||
        !isDeepStrictEqual(Uint8Array.from(stored.bytes.buffer), bytes)
      )
        return { kind: 'Unavailable' };
      const index = await this.#artifacts.findOne({
        _id: input.closure.evidenceIndexSaid,
        ownerAid: input.ownerAid,
        evaluationId: evaluation._id,
        custody: 'Public',
      });
      if (
        index === null ||
        !(index.bytes instanceof Binary) ||
        !isDeepStrictEqual(index.artifact, input.evidenceIndex.artifact) ||
        !isDeepStrictEqual(Uint8Array.from(index.bytes.buffer), input.evidenceIndex.bytes)
      )
        return { kind: 'Unavailable' };
      return { kind: 'AlreadyClosed', closureSaid: input.closure.d };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async close(input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
    readonly evidenceIndex: EvaluationClosureIndexCustody;
  }): Promise<
    | { readonly kind: 'Closed' | 'AlreadyClosed'; readonly closureSaid: string }
    | { readonly kind: 'Conflict' | 'Incomplete' | 'Unavailable' }
  > {
    const { ownerAid, closure } = input;
    if (decodeEvaluationClosure(closure).kind !== 'Accepted') return { kind: 'Incomplete' };
    const decodedIndex = decodeEvaluationClosureEvidenceIndex(
      input.evidenceIndex.artifact,
      input.evidenceIndex.bytes,
    );
    if (decodedIndex.kind !== 'Accepted' || decodedIndex.artifact.d !== closure.evidenceIndexSaid)
      return { kind: 'Incomplete' };
    const index = decodedIndex.index;
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const evaluation = await this.#evaluations.findOne(
            { _id: closure.evaluationId, ownerAid },
            { session },
          );
          if (evaluation === null) return { kind: 'Conflict' as const };
          // A concurrent successful close is reconciled on the next exact retry,
          // after its raw index and settled debit have become durable.
          if (evaluation.closure !== undefined) return { kind: 'Conflict' as const };
          if (
            evaluation.version !== input.expectedEvaluationVersion ||
            evaluation.command.originRunId !== closure.originRunId ||
            evaluation.evidenceStreamId !== closure.evidenceStreamId ||
            evaluation.acceptedThroughSequence + 1 !== closure.acceptedEventCount ||
            evaluation.chainHeadSaid !== closure.acceptedHeadSaid
          )
            return { kind: 'Conflict' as const };
          const locked = await this.#manifestLocks.findOne(
            { _id: evaluation._id, ownerAid },
            { session },
          );
          if (
            locked === null ||
            decodeEvaluationManifest(locked.manifest).kind !== 'Accepted' ||
            locked.manifest.d !== closure.manifestSaid ||
            locked.manifest.evaluationId !== evaluation._id ||
            locked.manifest.ownerAid !== ownerAid ||
            locked.manifest.originRunId !== evaluation.command.originRunId ||
            locked.manifest.taskId !== evaluation.command.taskId ||
            locked.manifest.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
            locked.manifest.personalAgentAid !== evaluation.command.personalAgentAid ||
            locked.manifest.taskMandateSaid !== evaluation.command.taskMandateSaid ||
            locked.manifest.retainedCheckpointSaid !== evaluation.command.retainedCheckpointSaid ||
            locked.manifest.retainedSealSaid !== evaluation.command.retainedSealSaid ||
            locked.manifest.revisions.H1 !== evaluation.command.expectedActiveRevisionSaid ||
            locked.manifest.executionProfileSaid !== evaluation.command.executionProfileSaid ||
            locked.manifest.sourceInventorySaid !== evaluation.command.sourceInventorySaid ||
            locked.manifest.policySaid !== evaluation.command.policySaid ||
            !isDeepStrictEqual(locked.manifest.allocation, evaluation.command.allocation) ||
            locked.leaseId !== evaluation.lease.leaseId ||
            evaluation.lease.version < locked.lockedAtLeaseVersion ||
            evaluation.version < locked.lockedAtEvaluationVersion ||
            !Number.isFinite(Date.parse(evaluation.lease.expiresAt)) ||
            Date.parse(evaluation.lease.expiresAt) <= Date.now() ||
            index.evaluationId !== evaluation._id ||
            index.manifestSaid !== locked.manifest.d ||
            index.hypothesisSaid !== locked.manifest.hypothesisSaid ||
            index.sourceInventorySaid !== locked.manifest.sourceInventorySaid ||
            index.lease.leaseId !== evaluation.lease.leaseId ||
            index.lease.version !== evaluation.lease.version ||
            !(await this.#activeInitialH1(evaluation, session))
          )
            return { kind: 'Incomplete' as const };
          const decodedVerifier = decodeEvaluationVerifierBundleBytes(locked.verifierBytes.buffer);
          if (
            decodedVerifier.kind !== 'Accepted' ||
            !isDeepStrictEqual(decodedVerifier.bundle, locked.verifierBundle) ||
            bindEvaluationVerifierBundle(decodedVerifier.bundle, locked.manifest).kind !== 'Bound'
          )
            return { kind: 'Incomplete' as const };
          const protectedDescriptors = [
            decodedVerifier.bundle.protectedCase.stimulus,
            decodedVerifier.bundle.protectedCase.expected,
            decodedVerifier.bundle.terminalCase.stimulus,
            decodedVerifier.bundle.terminalCase.expected,
          ];
          if (
            !isDeepStrictEqual(
              locked.protectedArtifactSaids,
              protectedDescriptors.map((artifact) => artifact.d),
            ) ||
            locked.protectedArtifactSaids.includes(closure.protectedCustodySaid)
          )
            return { kind: 'Incomplete' as const };
          const heldProtected = await this.#artifacts
            .find(
              {
                ownerAid,
                evaluationId: evaluation._id,
                _id: { $in: locked.protectedArtifactSaids },
              },
              { session },
            )
            .limit(5)
            .toArray();
          if (
            heldProtected.length !== 4 ||
            protectedDescriptors.some(
              (artifact) =>
                decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
                !heldProtected.some(
                  (stored) =>
                    stored._id === artifact.d &&
                    stored.custody === 'ProtectedCiphertext' &&
                    isDeepStrictEqual(stored.artifact, artifact),
                ),
            )
          )
            return { kind: 'Incomplete' as const };
          // The server acknowledges stored bytes; it does not grade or select an arm.
          const auditArtifacts = [
            closure.sharedAuditSaid,
            closure.armAuditSaids.H1,
            closure.armAuditSaids.C1,
            closure.armAuditSaids.C2,
            closure.armAuditSaids.C3,
            closure.armAuditSaids.H1TaskSearch,
          ];
          if (
            !isDeepStrictEqual(
              index.observations.map((entry) => entry.artifactSaid),
              closure.observationSaids,
            ) ||
            !isDeepStrictEqual(
              index.measurements.map((entry) => entry.artifactSaid),
              closure.measurementSaids,
            ) ||
            !isDeepStrictEqual(
              index.audits.map((audit) => audit.assessmentArtifactSaid),
              auditArtifacts,
            )
          )
            return { kind: 'Incomplete' as const };
          const auditProofSaids = index.audits.flatMap((audit) => [
            ...audit.proofs.map((proof) => proof.proofSaid),
            audit.attemptCoverage.proofSaid,
            ...audit.attemptCoverage.attempts.map((attempt) => attempt.attemptSaid),
          ]);
          const requiredSaids = [
            ...closure.observationSaids,
            ...closure.measurementSaids,
            ...auditArtifacts,
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
          if (
            index.budget.coverageEventSaid !== eventDocuments.at(-1)?.event.d ||
            !isDeepStrictEqual(index.budget.totals, replay.totals)
          )
            return { kind: 'Incomplete' as const };
          const acceptedEvents = eventDocuments.map(({ event }) => event);
          const debitEvents = acceptedEvents.filter(
            (event) => event.detail.kind === 'EvaluationBudgetDebited',
          );
          if (
            index.budget.anchors.some((anchor) => {
              const final = debitEvents
                .filter(
                  (event) =>
                    event.detail.kind === 'EvaluationBudgetDebited' &&
                    event.detail.budget === anchor.dimension,
                )
                .at(-1);
              return (
                final === undefined ||
                final.d !== anchor.finalDebitEventSaid ||
                final.detail.kind !== 'EvaluationBudgetDebited' ||
                final.detail.receiptArtifactSaid !== anchor.receiptArtifactSaid ||
                final.detail.sourceEventSaid !== anchor.sourceEventSaid
              );
            })
          )
            return { kind: 'Incomplete' as const };
          const captured = new Map<string, 'Public' | 'ProtectedCiphertext'>();
          for (const { event } of eventDocuments)
            if (event.detail.kind === 'ArtifactCaptured')
              captured.set(event.detail.artifactSaid, event.detail.custody);
          const trialCapture = (entry: {
            readonly slot: {
              readonly arm: string;
              readonly repetition: number;
              readonly attempt: number;
            };
            readonly artifactSaid: string;
          }) =>
            acceptedEvents.filter((event) => {
              if (
                event.detail.kind !== 'ArtifactCaptured' ||
                event.detail.artifactSaid !== entry.artifactSaid ||
                event.detail.custody !== 'Public' ||
                event.phase.kind !== 'Trial'
              )
                return false;
              const revision =
                event.phase.arm === 'H1TaskSearch'
                  ? locked.manifest.revisions.H1
                  : locked.manifest.revisions[event.phase.arm];
              return (
                event.phase.manifestSaid === locked.manifest.d &&
                event.phase.arm === entry.slot.arm &&
                event.phase.repetition === entry.slot.repetition &&
                event.phase.attempt === entry.slot.attempt &&
                event.harnessRevisionSaid === revision
              );
            }).length === 1;
          if (
            index.observations.some((entry) => !trialCapture(entry)) ||
            index.measurements.some((entry) => !trialCapture(entry)) ||
            acceptedEvents.filter(
              (event) =>
                event.detail.kind === 'ArtifactCaptured' &&
                event.detail.artifactSaid === closure.protectedCustodySaid &&
                event.detail.custody === 'ProtectedCiphertext' &&
                event.phase.kind === 'Trial' &&
                event.phase.manifestSaid === locked.manifest.d,
            ).length !== 1
          )
            return { kind: 'Incomplete' as const };
          if (
            requiredSaids.some(
              (said) =>
                captured.get(said) !==
                (said === closure.protectedCustodySaid ? 'ProtectedCiphertext' : 'Public'),
            )
          )
            return { kind: 'Incomplete' as const };
          const publicProofSaids = [
            ...new Set([...auditProofSaids, ...replay.receiptArtifactSaids]),
          ];
          const artifactSaids = [...new Set([...requiredSaids, ...publicProofSaids])];
          if (publicProofSaids.some((said) => captured.get(said) !== 'Public'))
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
          const bySaid = new Map(artifactDocuments.map((stored) => [stored._id, stored]));
          for (const audit of index.audits) {
            const assessed = assessTamperAuditScope({
              scope: audit.scope,
              proofs: audit.proofs,
              attemptCoverage: [audit.attemptCoverage],
            });
            const prepared = prepareEvaluationAuditAssessmentArtifact(assessed);
            const stored = bySaid.get(audit.assessmentArtifactSaid);
            if (
              prepared.kind !== 'Prepared' ||
              prepared.artifact.d !== audit.assessmentArtifactSaid ||
              stored === undefined ||
              !(stored.bytes instanceof Binary) ||
              !isDeepStrictEqual(stored.artifact, prepared.artifact) ||
              !isDeepStrictEqual(Uint8Array.from(stored.bytes.buffer), prepared.bytes)
            )
              return { kind: 'Incomplete' as const };
          }
          if (locked.manifest.heldOutCaseCount !== 1) return { kind: 'Incomplete' as const };
          const protectedConditionId = decodedVerifier.bundle.protectedCase.objectSaid;
          const publicConditionIds = locked.manifest.publicConditionIds;
          if (
            !isDeepStrictEqual(
              decodedVerifier.bundle.publicConditions.map((condition) => condition.id),
              publicConditionIds,
            )
          )
            return { kind: 'Incomplete' as const };
          const observationEvidence: TrialObservationEvidence[] = [];
          const nestedCustody = new Map<string, 'Public' | 'ProtectedCiphertext'>();
          const capturedInSlot = (
            artifactSaid: string,
            custody: 'Public' | 'ProtectedCiphertext',
            slot: { readonly arm: string; readonly repetition: number; readonly attempt: number },
          ) =>
            acceptedEvents.some(
              (event) =>
                event.detail.kind === 'ArtifactCaptured' &&
                event.detail.artifactSaid === artifactSaid &&
                event.detail.custody === custody &&
                event.phase.kind === 'Trial' &&
                event.phase.manifestSaid === locked.manifest.d &&
                event.phase.arm === slot.arm &&
                event.phase.repetition === slot.repetition &&
                event.phase.attempt === slot.attempt,
            );
          const requireNested = (
            artifactSaid: string,
            custody: 'Public' | 'ProtectedCiphertext',
            slot: { readonly arm: string; readonly repetition: number; readonly attempt: number },
          ) => {
            if (!capturedInSlot(artifactSaid, custody, slot)) return false;
            const prior = nestedCustody.get(artifactSaid);
            if (prior !== undefined && prior !== custody) return false;
            nestedCustody.set(artifactSaid, custody);
            return true;
          };
          for (const entry of index.observations) {
            const stored = bySaid.get(entry.artifactSaid);
            if (stored === undefined || !(stored.bytes instanceof Binary))
              return { kind: 'Incomplete' as const };
            const decoded = decodeTrialObservationEvidence(
              stored.artifact,
              Uint8Array.from(stored.bytes.buffer),
            );
            if (decoded.kind !== 'Accepted') return { kind: 'Incomplete' as const };
            const record = decoded.evidence;
            const slot = entry.slot;
            const revision =
              slot.arm === 'H1TaskSearch'
                ? locked.manifest.revisions.H1
                : locked.manifest.revisions[slot.arm];
            const trialHead = acceptedEvents.find(
              (event) => event.d === record.trialEvidenceHeadSaid,
            );
            if (
              record.evaluationId !== evaluation._id ||
              record.manifestSaid !== locked.manifest.d ||
              record.harnessRevisionSaid !== revision ||
              !isDeepStrictEqual(record.observation.slot, slot) ||
              !isDeepStrictEqual(
                record.publicObservations.map((item) => item.conditionId),
                publicConditionIds,
              ) ||
              !record.observation.disposition.heldOutConditionIds.every(
                (conditionId) => conditionId === protectedConditionId,
              ) ||
              trialHead?.detail.kind !== 'TrialStopped' ||
              trialHead.detail.reason !== 'Completed' ||
              trialHead.phase.kind !== 'Trial' ||
              trialHead.phase.manifestSaid !== locked.manifest.d ||
              trialHead.phase.arm !== slot.arm ||
              trialHead.phase.repetition !== slot.repetition ||
              trialHead.phase.attempt !== slot.attempt ||
              trialHead.harnessRevisionSaid !== revision ||
              locked.protectedArtifactSaids.includes(record.protectedObservationSaid) ||
              !requireNested(record.observation.disposition.artifactSaid, 'Public', slot) ||
              !requireNested(record.capturedSourceSaid, 'Public', slot) ||
              !requireNested(record.trialCleanupReceiptSaid, 'Public', slot) ||
              !requireNested(record.protectedCleanupReceiptSaid, 'Public', slot) ||
              !requireNested(record.protectedObservationSaid, 'ProtectedCiphertext', slot) ||
              record.publicObservations.some(
                (item) => !requireNested(item.rawObservationSaid, 'Public', slot),
              )
            )
              return { kind: 'Incomplete' as const };
            observationEvidence.push(record);
          }
          const terminalCoverage = acceptedEvents.at(-1)?.detail;
          if (
            terminalCoverage?.kind !== 'EvaluationBudgetCovered' ||
            observationEvidence.at(-1)?.protectedObservationSaid !== closure.protectedCustodySaid ||
            new Set(observationEvidence.map((record) => record.protectedObservationSaid)).size !==
              18 ||
            !isDeepStrictEqual(
              observationEvidence.flatMap((record) => record.providerUsageEventSaids),
              terminalCoverage.providerUsageEventSaids,
            )
          )
            return { kind: 'Incomplete' as const };
          if (
            index.audits.some(
              (audit) =>
                audit.scope !== 'Shared' &&
                observationEvidence.some(
                  (record) =>
                    record.observation.slot.arm === audit.scope &&
                    record.observation.disposition.usage.unsafeEffects > 0,
                ) &&
                (audit.obligations.authorizationAndAccess !== 'Fail' || audit.verdict !== 'Fail'),
            )
          )
            return { kind: 'Incomplete' as const };
          const comparison = closeComparison(
            { public: publicConditionIds, heldOut: [protectedConditionId] },
            observationEvidence.map((record) => record.observation),
          );
          if (comparison.kind !== 'EvidenceOnly') return { kind: 'Incomplete' as const };
          const measurementEvidence: ComparisonMeasurementEvidence[] = [];
          for (const [position, entry] of index.measurements.entries()) {
            const stored = bySaid.get(entry.artifactSaid);
            if (stored === undefined || !(stored.bytes instanceof Binary))
              return { kind: 'Incomplete' as const };
            const decoded = decodeComparisonMeasurementEvidence(
              stored.artifact,
              Uint8Array.from(stored.bytes.buffer),
            );
            if (decoded.kind !== 'Accepted') return { kind: 'Incomplete' as const };
            const record = decoded.evidence;
            const expected = comparison.measurements[position];
            const sourceObservations = index.observations
              .filter(
                (candidate) =>
                  candidate.slot.arm === entry.slot.arm &&
                  candidate.slot.repetition === entry.slot.repetition,
              )
              .map((candidate) => candidate.artifactSaid);
            const revision =
              entry.slot.arm === 'H1TaskSearch'
                ? locked.manifest.revisions.H1
                : locked.manifest.revisions[entry.slot.arm];
            if (
              expected === undefined ||
              record.evaluationId !== evaluation._id ||
              record.manifestSaid !== locked.manifest.d ||
              record.harnessRevisionSaid !== revision ||
              !isDeepStrictEqual(record.measurement, expected) ||
              !isDeepStrictEqual(record.measurement.slot, entry.slot) ||
              !isDeepStrictEqual(record.sourceObservationSaids, sourceObservations)
            )
              return { kind: 'Incomplete' as const };
            measurementEvidence.push(record);
          }
          if (measurementEvidence.length !== 15) return { kind: 'Incomplete' as const };
          const nestedDocuments = await this.#artifacts
            .find(
              {
                ownerAid,
                evaluationId: evaluation._id,
                _id: { $in: [...nestedCustody.keys()] },
              },
              { session },
            )
            .limit(nestedCustody.size + 1)
            .toArray();
          if (nestedDocuments.length !== nestedCustody.size) return { kind: 'Incomplete' as const };
          for (const stored of nestedDocuments) {
            if (
              stored._id !== stored.artifact.d ||
              stored.custody !== nestedCustody.get(stored._id)
            )
              return { kind: 'Incomplete' as const };
            if (stored.custody === 'ProtectedCiphertext') {
              const decoded = decodeProtectedEvaluationArtifact(stored.artifact);
              if (
                decoded.kind !== 'Accepted' ||
                decoded.artifact.evaluationId !== evaluation._id ||
                decoded.artifact.purpose !== 'OracleObservation' ||
                decoded.artifact.objectSaid !== protectedConditionId ||
                decoded.artifact.segment !== 0
              )
                return { kind: 'Incomplete' as const };
            } else if (
              !(stored.bytes instanceof Binary) ||
              decodeEvidenceArtifact(stored.artifact, Uint8Array.from(stored.bytes.buffer)).kind !==
                'Accepted'
            )
              return { kind: 'Incomplete' as const };
          }
          const consumed = {
            ...replay.totals,
            evidencePlusArtifactsPerRunBytes: evaluation.acceptedBytes,
          } satisfies EvaluationAllowance;
          if (
            evaluationConsumables.some(
              (name) =>
                !Number.isSafeInteger(consumed[name]) ||
                consumed[name] < 0 ||
                consumed[name] > evaluation.reserved[name] ||
                consumed[name] > taskEvaluationBudgetCeilings[name],
            )
          )
            return { kind: 'Incomplete' as const };
          const debitBytes = new TextEncoder().encode(
            JSON.stringify({ evaluationId: evaluation._id, closureSaid: closure.d, consumed }),
          );
          const debitArtifact = prepareEvidenceArtifact(debitBytes, 'application/json');
          if (debitArtifact.kind !== 'Prepared') return { kind: 'Incomplete' as const };
          const administrativeBytes = input.evidenceIndex.bytes.byteLength + debitBytes.byteLength;
          const usage = await this.#usage.findOneAndUpdate(
            {
              _id: evidenceUsageDocumentId,
              acceptedBytes: {
                $lte:
                  taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes -
                  administrativeBytes,
              },
            },
            { $inc: { acceptedBytes: administrativeBytes, version: 1 } },
            { session, returnDocument: 'after' },
          );
          if (usage === null) return { kind: 'Incomplete' as const };
          await this.#artifacts.insertMany(
            [
              {
                _id: input.evidenceIndex.artifact.d,
                ownerAid,
                evaluationId: evaluation._id,
                custody: 'Public',
                artifact: input.evidenceIndex.artifact,
                bytes: new Binary(Uint8Array.from(input.evidenceIndex.bytes)),
                acceptedAt: new Date(),
              },
              {
                _id: debitArtifact.artifact.d,
                ownerAid,
                evaluationId: evaluation._id,
                custody: 'Public',
                artifact: debitArtifact.artifact,
                bytes: new Binary(debitBytes),
                acceptedAt: new Date(),
              },
            ],
            { session },
          );
          await this.#taskReservationFences.updateOne(
            {
              _id: evaluation.command.taskId,
              ownerAid,
              taskRevisionSaid: evaluation.command.taskRevisionSaid,
            },
            {
              $inc: { version: 1 },
              $setOnInsert: {
                ownerAid,
                taskRevisionSaid: evaluation.command.taskRevisionSaid,
              },
            },
            { upsert: true, session },
          );
          const committed = await this.#evaluations.updateOne(
            {
              _id: evaluation._id,
              ownerAid,
              version: evaluation.version,
              'lease.leaseId': evaluation.lease.leaseId,
              'lease.version': index.lease.version,
              'lease.expiresAt': { $gt: new Date().toISOString() },
              activeOwnerSlot: ownerAid,
              closure: { $exists: false },
            },
            {
              $set: {
                closure,
                settledDebit: {
                  closureSaid: closure.d,
                  consumed,
                  artifactSaid: debitArtifact.artifact.d,
                } satisfies SettledEvaluationDebit,
              },
              $unset: { activeOwnerSlot: '' },
              $inc: { version: 1 },
            },
            { session },
          );
          if (committed.matchedCount !== 1)
            throw new EvidenceTransactionAborted({ kind: 'Conflict' });
          return { kind: 'Closed' as const, closureSaid: closure.d };
        }),
      );
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
