import { isDeepStrictEqual } from 'node:util';

import type { Collection, Db } from 'mongodb';

import {
  assessFailureQualification,
  type PreparedCompatibilityFailureCategory,
  type Run,
  type SealedRunObservation,
} from '@devrandom/domain';
import {
  decodeEvaluationExecutionProfile,
  decodeRunSuccessorSegment,
  type RunSuccessorSegment,
  evidenceArtifactReferences,
  type EvidenceEvent,
  type PublicVerifierReceipt,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';

import {
  decodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  decodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from '../../run/infrastructure/mongo-run-continuations.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';

export interface FailureQualificationReading {
  assess(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly retainedRunId: string;
    readonly retainedCheckpointSaid: string;
    readonly retainedSealSaid: string;
    readonly executionProfileSaid: string;
    readonly personalAgentAid: string;
    readonly taskMandateSaid: string;
    readonly expectedActiveRevisionSaid: string;
  }): Promise<
    | { readonly kind: 'Qualified' }
    | { readonly kind: 'Blocked'; readonly gate: 'Qualification' | 'Evidence' | 'Profile' }
    | { readonly kind: 'Unavailable' }
  >;
}

type QualificationInput = Parameters<FailureQualificationReading['assess']>[0];
type QualificationOutcome = Awaited<ReturnType<FailureQualificationReading['assess']>>;
type RunObservation = {
  readonly kind: 'Observed';
  readonly observation: SealedRunObservation;
  readonly checkpoint: VerifiedCheckpoint;
  readonly failureEvent: EvidenceEvent | undefined;
};
type ObservationOutcome = RunObservation | Exclude<QualificationOutcome, { kind: 'Qualified' }>;

const blockedQualification = { kind: 'Blocked', gate: 'Qualification' } as const;
const blockedEvidence = { kind: 'Blocked', gate: 'Evidence' } as const;
const blockedProfile = { kind: 'Blocked', gate: 'Profile' } as const;

function calibrationCheckpointMatches(run: Run, checkpoint: VerifiedCheckpoint): boolean {
  if (run.lifecycle.kind !== 'Ended' || checkpoint.runState.kind !== 'Ended') return false;
  const outcome = run.lifecycle.outcome;
  const verified = checkpoint.runState.outcome;
  if (outcome.kind !== verified.kind) return false;
  if (outcome.kind === 'CalibrationConfirmed' && verified.kind === 'CalibrationConfirmed')
    return isDeepStrictEqual(outcome.category, verified.category);
  if (outcome.kind === 'CalibrationExcluded' && verified.kind === 'CalibrationExcluded')
    return outcome.reason === verified.reason;
  return false;
}

function retainedCheckpointMatches(run: Run, checkpoint: VerifiedCheckpoint): boolean {
  return (
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Blocked' &&
    run.lifecycle.phase.reason === 'HarnessCompatibilityFailure' &&
    checkpoint.runState.kind === 'Active' &&
    checkpoint.runState.phase.kind === 'Blocked' &&
    checkpoint.runState.phase.reason === 'HarnessCompatibilityFailure' &&
    checkpoint.runState.verification.kind === run.submissionVerification.kind
  );
}

function receiptPattern(
  receipts: readonly PublicVerifierReceipt[],
  category: PreparedCompatibilityFailureCategory,
  failureEvent: EvidenceEvent | undefined,
): boolean {
  if (receipts.length !== 3 || failureEvent?.event.kind !== 'FailureObserved') return false;
  const [current, tamper, legacy] = receipts;
  return (
    current !== undefined &&
    tamper !== undefined &&
    legacy !== undefined &&
    current.commandSaid === category.currentCommandSaid &&
    tamper.commandSaid === category.tamperCommandSaid &&
    legacy.commandSaid === category.legacyCommandSaid &&
    current.outcome.kind === 'Accepted' &&
    current.outcome.observedExitCode === 0 &&
    tamper.outcome.kind === 'Accepted' &&
    tamper.outcome.observedExitCode === 0 &&
    legacy.outcome.kind === 'Rejected' &&
    legacy.outcome.reason.kind === 'UnexpectedExitCode' &&
    legacy.outcome.reason.expected === 0 &&
    legacy.outcome.reason.observed === category.legacyObservedExitCode &&
    failureEvent.event.failure === 'HarnessCompatibilityFailure' &&
    failureEvent.event.receiptSaid === legacy.d
  );
}

/** Exact Mongo custody read feeding the frozen six-Run domain qualification law. */
export class MongoFailureQualification implements FailureQualificationReading {
  readonly #tasks: Collection<TaskDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #segments: Collection<RunSuccessorSegmentDocument>;

  constructor(database: Db) {
    this.#segments = database.collection(runSuccessorSegmentsCollectionName);
    this.#tasks = database.collection(tasksCollectionName);
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#events = database.collection(evidenceCollectionNames.events);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
  }

  async assess(input: QualificationInput): Promise<QualificationOutcome> {
    try {
      const taskDocument = await this.#tasks.findOne({
        _id: input.taskId,
        ownerAid: input.ownerAid,
      });
      if (taskDocument === null) return blockedQualification;
      const task = decodeTaskDocument(taskDocument).task;
      if (
        task.lifecycle.kind !== 'Open' ||
        task.revisionSaid !== input.taskRevisionSaid ||
        task.revision.d !== input.taskRevisionSaid
      )
        return blockedQualification;
      const retainedDocument = await this.#runs.findOne({
        _id: input.retainedRunId,
        ownerAid: input.ownerAid,
      });
      if (retainedDocument === null) return blockedQualification;
      const retainedRun = decodeRunDocument(retainedDocument).run;
      if (
        retainedRun.binding.purpose.kind !== 'Retained' ||
        retainedRun.binding.taskId !== input.taskId ||
        retainedRun.binding.taskRevisionSaid !== input.taskRevisionSaid ||
        retainedRun.binding.personalAgentAid !== input.personalAgentAid ||
        retainedRun.binding.taskMandateSaid !== input.taskMandateSaid ||
        retainedRun.binding.initialHarnessRevisionSaid !== input.expectedActiveRevisionSaid ||
        !isDeepStrictEqual(retainedRun.binding.repository, task.revision.repository)
      )
        return blockedQualification;
      const calibrationDocuments = await this.#runs
        .find({
          ownerAid: input.ownerAid,
          taskId: input.taskId,
          taskRevisionSaid: input.taskRevisionSaid,
          'purpose.kind': 'PreparedCompatibilityCalibration',
        })
        .toArray();
      if (calibrationDocuments.length !== 5) return blockedQualification;
      const calibrations = calibrationDocuments.map((document) => decodeRunDocument(document).run);
      calibrations.sort((left, right) => {
        const a = left.binding.purpose;
        const b = right.binding.purpose;
        return a.kind === 'PreparedCompatibilityCalibration' &&
          b.kind === 'PreparedCompatibilityCalibration'
          ? a.ordinal - b.ordinal
          : 0;
      });
      const retained = await this.#readObservation(
        retainedRun,
        task.revision.completionConditions.map((condition) => condition.id),
        input,
      );
      if (retained.kind !== 'Observed') return retained;
      const observations: SealedRunObservation[] = [];
      for (const run of calibrations) {
        const observed = await this.#readObservation(
          run,
          task.revision.completionConditions.map((condition) => condition.id),
          input,
        );
        if (observed.kind !== 'Observed') return observed;
        observations.push(observed.observation);
        if (
          run.lifecycle.kind === 'Ended' &&
          run.lifecycle.outcome.kind === 'CalibrationConfirmed'
        ) {
          if (
            !receiptPattern(
              observed.checkpoint.verifierReceipts,
              run.lifecycle.outcome.category,
              observed.failureEvent,
            )
          )
            return blockedEvidence;
        } else if (observed.failureEvent !== undefined) {
          return blockedEvidence;
        }
      }
      const firstConfirmed = calibrations.find(
        (run) =>
          run.lifecycle.kind === 'Ended' && run.lifecycle.outcome.kind === 'CalibrationConfirmed',
      );
      if (
        firstConfirmed === undefined ||
        firstConfirmed.lifecycle.kind !== 'Ended' ||
        firstConfirmed.lifecycle.outcome.kind !== 'CalibrationConfirmed'
      )
        return blockedQualification;
      const category = firstConfirmed.lifecycle.outcome.category;
      if (!receiptPattern(retained.checkpoint.verifierReceipts, category, retained.failureEvent))
        return blockedEvidence;
      const failure = retained.failureEvent;
      if (failure === undefined) return blockedEvidence;
      const qualification = assessFailureQualification({
        task: {
          taskId: task.taskId,
          ownerAid: task.ownerAid,
          harnessLineageId: task.harnessLineageId,
          revision: { said: task.revisionSaid },
          lifecycle: task.lifecycle,
        },
        calibrations: observations,
        retained: retained.observation,
        retainedFailure: {
          runId: retainedRun.binding.runId,
          eventSaid: failure.d,
          category,
        },
      });
      return qualification.kind === 'Qualified' ? { kind: 'Qualified' } : blockedQualification;
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #readObservation(
    run: Run,
    completionConditionIds: readonly string[],
    input: QualificationInput,
  ): Promise<ObservationOutcome> {
    const documents = await this.#segments
      .find({ ownerAid: input.ownerAid, runId: run.binding.runId })
      .toArray();
    const segments: RunSuccessorSegment[] = [];
    for (const document of documents) {
      const decoded = decodeRunSuccessorSegment(document.segment);
      if (
        decoded.kind !== 'Accepted' ||
        document._id !== decoded.segment.d ||
        decoded.segment.kind !== 'CalibrationContinuationSegment' ||
        run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
        decoded.segment.runId !== run.binding.runId ||
        decoded.segment.ownerAid !== input.ownerAid ||
        decoded.segment.taskId !== run.binding.taskId ||
        decoded.segment.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        decoded.segment.personalAgentAid !== run.binding.personalAgentAid ||
        decoded.segment.taskMandateSaid !== run.binding.taskMandateSaid ||
        decoded.segment.baseline.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        decoded.segment.successor.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        document.acceptedAt.toISOString() !== decoded.segment.admittedAt
      )
        return blockedEvidence;
      segments.push(decoded.segment);
    }
    const authorizedStreams = [run.binding.evidenceStreamId];
    const incarnations = new Set<string>();
    let latest: RunSuccessorSegment | undefined;
    let previousObservation: RunObservation | undefined;
    const chainArtifacts = new Set<string>();
    while (segments.length > 0) {
      const streamId = authorizedStreams.at(-1);
      const matches = segments.filter(
        (segment) => segment.predecessor.evidenceStreamId === streamId,
      );
      const segment = matches[0];
      if (latest === undefined && segment !== undefined)
        incarnations.add(segment.predecessor.incarnationId);
      if (
        matches.length !== 1 ||
        segment === undefined ||
        authorizedStreams.includes(segment.successor.evidenceStreamId) ||
        incarnations.has(segment.successor.incarnationId) ||
        segment.predecessor.segmentSaid !== latest?.d ||
        (latest !== undefined &&
          (segment.predecessor.incarnationId !== latest.successor.incarnationId ||
            segment.fromRunVersion <= latest.fromRunVersion ||
            segment.admittedAt < latest.admittedAt))
      )
        return blockedEvidence;
      const observed = await this.#readStream(run, completionConditionIds, input, {
        streamId: segment.predecessor.evidenceStreamId,
        checkpointSaid: segment.predecessor.checkpointSaid,
        authorizedStreams: [...authorizedStreams],
        predecessor: segment,
      });
      if (observed.kind !== 'Observed') return observed;
      if (
        previousObservation !== undefined &&
        Object.entries(previousObservation.checkpoint.budget.consumed).some(
          ([dimension, amount]) =>
            observed.checkpoint.budget.consumed[
              dimension as keyof typeof observed.checkpoint.budget.consumed
            ] < amount,
        )
      )
        return blockedEvidence;
      for (const said of observed.observation.seal.artifactSaids) chainArtifacts.add(said);
      previousObservation = observed;
      incarnations.add(segment.successor.incarnationId);
      latest = segment;
      authorizedStreams.push(segment.successor.evidenceStreamId);
      segments.splice(segments.indexOf(segment), 1);
    }
    if (
      latest === undefined
        ? run.currentExecution !== undefined
        : run.currentExecution?.segmentSaid !== latest.d ||
          run.currentExecution.evidenceStreamId !== latest.successor.evidenceStreamId ||
          run.currentExecution.harnessRevisionSaid !== latest.successor.harnessRevisionSaid ||
          run.lease.kind !== 'Held' ||
          run.lease.incarnationId !== latest.successor.incarnationId ||
          run.version <= latest.fromRunVersion
    )
      return blockedEvidence;
    const final = await this.#readStream(run, completionConditionIds, input, {
      streamId: authorizedStreams.at(-1) ?? run.binding.evidenceStreamId,
      authorizedStreams,
      ...(latest === undefined ? {} : { incarnationId: latest.successor.incarnationId }),
    });
    if (final.kind !== 'Observed') return final;
    if (
      previousObservation !== undefined &&
      Object.entries(previousObservation.checkpoint.budget.consumed).some(
        ([dimension, amount]) =>
          final.checkpoint.budget.consumed[
            dimension as keyof typeof final.checkpoint.budget.consumed
          ] < amount,
      )
    )
      return blockedEvidence;
    return {
      ...final,
      observation: {
        ...final.observation,
        seal: {
          ...final.observation.seal,
          artifactSaids: [...new Set([...chainArtifacts, ...final.observation.seal.artifactSaids])],
        },
      },
    };
  }

  async #readStream(
    run: Run,
    completionConditionIds: readonly string[],
    input: QualificationInput,
    target: {
      readonly streamId: string;
      readonly checkpointSaid?: string;
      readonly incarnationId?: string;
      readonly authorizedStreams: readonly string[];
      readonly predecessor?: RunSuccessorSegment;
    },
  ): Promise<ObservationOutcome> {
    const { ownerAid } = input;
    const streamDocument = await this.#streams.findOne({
      _id: target.streamId,
      'binding.ownerAid': ownerAid,
      'binding.runId': run.binding.runId,
    });
    if (streamDocument === null) return blockedEvidence;
    const stream = decodeEvidenceStreamDocument(streamDocument);
    if (
      stream.binding.ownerAid !== ownerAid ||
      stream.binding.taskId !== run.binding.taskId ||
      stream.binding.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      stream.binding.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
      stream.binding.taskMandateSaid !== run.binding.taskMandateSaid ||
      stream.cursor.kind !== 'Continued' ||
      stream.seal.kind !== 'Sealed'
    )
      return blockedEvidence;
    const checkpointSaid =
      target.checkpointSaid ??
      (run.lifecycle.kind === 'Ended'
        ? run.lifecycle.outcome.checkpointSaid
        : run.lifecycle.phase.kind === 'Blocked'
          ? run.lifecycle.phase.checkpointSaid
          : undefined);
    if (checkpointSaid === undefined) return blockedQualification;
    const checkpointDocument = await this.#checkpoints.findOne({
      _id: checkpointSaid,
      ownerAid,
      runId: run.binding.runId,
      evidenceStreamId: stream.binding.streamId,
    });
    if (checkpointDocument === null) return blockedEvidence;
    const checkpoint = decodeEvidenceCheckpointDocument(
      checkpointDocument,
      completionConditionIds,
    ).checkpoint;
    if (
      checkpoint.runId !== run.binding.runId ||
      (target.incarnationId !== undefined && checkpoint.incarnationId !== target.incarnationId) ||
      stream.provisional.kind !== 'Checkpointed' ||
      stream.provisional.checkpointSaid !== checkpoint.d ||
      !isDeepStrictEqual(
        stream.provisional.submissionVerification,
        checkpoint.runState.verification,
      ) ||
      (target.predecessor === undefined
        ? !isDeepStrictEqual(stream.provisional.lifecycle, run.lifecycle)
        : stream.provisional.lifecycle.kind !== 'Active' ||
          stream.provisional.lifecycle.phase.kind !== 'Blocked' ||
          (stream.provisional.lifecycle.phase.reason !== 'ContextLimitReached' &&
            stream.provisional.lifecycle.phase.reason !== 'ProcessLost') ||
          checkpoint.runState.kind !== 'Active' ||
          checkpoint.runState.phase.kind !== 'Blocked' ||
          stream.provisional.lifecycle.phase.reason !== checkpoint.runState.phase.reason) ||
      Object.entries(checkpoint.budget.consumed).some(([dimension, consumed]) => {
        const name = dimension as keyof typeof checkpoint.budget.consumed;
        return (
          consumed > run.binding.budget[name] ||
          consumed + checkpoint.budget.remaining[name] !== run.binding.budget[name]
        );
      }) ||
      checkpoint.taskId !== run.binding.taskId ||
      checkpoint.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      checkpoint.harnessLineageId !== run.binding.harnessLineageId ||
      checkpoint.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      checkpoint.personalAgentAid !== run.binding.personalAgentAid ||
      checkpoint.governorAid !== run.binding.governorAid ||
      checkpoint.taskMandateSaid !== run.binding.taskMandateSaid ||
      checkpoint.promotionMandateSaid !== run.binding.promotionMandateSaid ||
      !isDeepStrictEqual(checkpoint.purpose, run.binding.purpose) ||
      checkpoint.repository.objectFormat !== run.binding.repository.objectFormat ||
      checkpoint.repository.baseCommit !== run.binding.repository.commit ||
      checkpoint.repository.baseTree !== run.binding.repository.tree ||
      checkpoint.evidence.finalSequence >= stream.cursor.acceptedThrough ||
      checkpoint.evidence.eventCount !== checkpoint.evidence.finalSequence + 1 ||
      checkpoint.incarnationId !== stream.binding.incarnationId ||
      (target.predecessor === undefined
        ? checkpoint.runState.verification.kind !== run.submissionVerification.kind ||
          (run.binding.purpose.kind === 'Retained'
            ? !retainedCheckpointMatches(run, checkpoint)
            : !calibrationCheckpointMatches(run, checkpoint))
        : checkpoint.runState.kind !== 'Active' ||
          checkpoint.runState.phase.kind !== 'Blocked' ||
          (checkpoint.runState.phase.reason === 'ProcessLost'
            ? checkpoint.continuation.kind !== 'LaterRuntimeRecoveryRequired'
            : checkpoint.runState.phase.reason !== 'ContextLimitReached' ||
              checkpoint.continuation.kind !== 'ExternalResolutionRequired' ||
              checkpoint.continuation.reason !== 'ContextLimitReached') ||
          checkpoint.incarnationId !== target.predecessor.predecessor.incarnationId ||
          stream.cursor.acceptedThrough !== target.predecessor.predecessor.finalSequence ||
          stream.cursor.chainHeadSaid !== target.predecessor.predecessor.chainHeadSaid ||
          stream.seal.exchangeSaid !== target.predecessor.predecessor.sealExchangeSaid ||
          stream.seal.sealedAt > target.predecessor.admittedAt ||
          !isDeepStrictEqual(checkpoint.budget.consumed, target.predecessor.consumedBudget))
    )
      return blockedEvidence;
    if (
      run.binding.runId === input.retainedRunId &&
      (checkpoint.d !== input.retainedCheckpointSaid ||
        stream.seal.exchangeSaid !== input.retainedSealSaid)
    )
      return blockedEvidence;
    let sequence = 0;
    let previousSaid: string | undefined;
    let checkpointHeadFound = false;
    let profileEvent: EvidenceEvent | undefined;
    let failureEvent: EvidenceEvent | undefined;
    let calibrationEvent: EvidenceEvent | undefined;
    let blockedEvent: EvidenceEvent | undefined;
    let checkpointVerified = false;
    let checkpointAccepted = false;
    const artifactSaids = new Set<string>();
    const authorized = new Set<string>();
    const modelRequests = new Set<string>();
    const cursor = this.#events
      .find({ ownerAid, runId: run.binding.runId, evidenceStreamId: stream.binding.streamId })
      .sort({ sequence: 1 });
    for await (const document of cursor) {
      const event = decodeEvidenceEventDocument(document).event;
      if (
        event.sequence !== sequence ||
        event.runId !== run.binding.runId ||
        event.taskId !== run.binding.taskId ||
        event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        event.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        event.personalAgentAid !== run.binding.personalAgentAid ||
        event.taskMandateSaid !== run.binding.taskMandateSaid ||
        event.incarnationId !== checkpoint.incarnationId ||
        (sequence === 0
          ? event.predecessor.kind !== 'Genesis' || event.event.kind !== 'RunStarted'
          : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== previousSaid)
      )
        return blockedEvidence;
      if (sequence === checkpoint.evidence.finalSequence) {
        checkpointHeadFound = event.d === checkpoint.evidence.chainHeadSaid;
      }
      if (target.predecessor !== undefined) {
        const detail = event.event;
        if (detail.kind === 'ModelRequest' && profileEvent === undefined) return blockedProfile;
        if (
          detail.kind === 'ToolAuthorized' ||
          detail.kind === 'EffectCompleted' ||
          detail.kind === 'EffectFailed'
        ) {
          const key = `${detail.piSessionId}:${detail.modelTurnId}:${detail.toolCallId}:${String(detail.proposalIndex)}`;
          if (detail.kind === 'ToolAuthorized') {
            if (authorized.has(key)) return blockedEvidence;
            authorized.add(key);
          } else if (!authorized.delete(key)) return blockedEvidence;
        }
        if (detail.kind === 'ModelRequest' || detail.kind === 'ModelMessageCompleted') {
          const key = `${detail.piSessionId}:${detail.modelTurnId}`;
          if (detail.kind === 'ModelRequest') {
            if (modelRequests.has(key)) return blockedEvidence;
            modelRequests.add(key);
          } else if (!modelRequests.delete(key)) return blockedEvidence;
        }
        if (
          sequence === checkpoint.evidence.finalSequence &&
          (authorized.size !== 0 || modelRequests.size !== 0)
        )
          return blockedEvidence;
      }
      for (const said of evidenceArtifactReferences(event.event)) artifactSaids.add(said);
      switch (event.event.kind) {
        case 'RunExecutionProfileBound':
          if (profileEvent !== undefined || sequence > checkpoint.evidence.finalSequence)
            return blockedProfile;
          profileEvent = event;
          break;
        case 'FailureObserved':
          if (
            failureEvent !== undefined ||
            profileEvent === undefined ||
            sequence > checkpoint.evidence.finalSequence
          )
            return blockedEvidence;
          failureEvent = event;
          break;
        case 'RunCalibrationRecorded':
          if (calibrationEvent !== undefined || !checkpointVerified || checkpointAccepted)
            return blockedEvidence;
          calibrationEvent = event;
          break;
        case 'RunBlocked':
          if (
            blockedEvent !== undefined ||
            (target.predecessor === undefined && !checkpointVerified) ||
            checkpointAccepted ||
            sequence <= checkpoint.evidence.finalSequence
          )
            return blockedEvidence;
          blockedEvent = event;
          break;
        case 'CheckpointVerified':
          if (
            checkpointVerified ||
            sequence <= checkpoint.evidence.finalSequence ||
            event.event.checkpointSaid !== checkpoint.d
          )
            return blockedEvidence;
          checkpointVerified = true;
          break;
        case 'CheckpointAccepted':
          if (
            checkpointAccepted ||
            !checkpointVerified ||
            (calibrationEvent === undefined && blockedEvent === undefined) ||
            event.event.checkpointSaid !== checkpoint.d
          )
            return blockedEvidence;
          checkpointAccepted = true;
          break;
        case 'ModelRequest':
        case 'ModelMessageCompleted':
        case 'ToolProposed':
        case 'ToolAuthorized':
        case 'ToolRejected':
        case 'ApprovalRequired':
        case 'EffectCompleted':
        case 'EffectFailed':
        case 'Observation':
        case 'BudgetDebited':
        case 'ContextSummary':
        case 'ResultSubmitted':
        case 'TaskVerificationAccepted':
        case 'TaskVerificationRejected':
        case 'DataWithheld':
        case 'SecurityViolation':
          if (profileEvent === undefined) return blockedProfile;
          break;
        case 'RunStarted':
        case 'IncarnationStarted':
        case 'MandateVerified':
          break;
      }
      previousSaid = event.d;
      sequence += 1;
    }
    if (
      sequence !== stream.cursor.acceptedThrough + 1 ||
      previousSaid !== stream.cursor.chainHeadSaid ||
      !checkpointHeadFound ||
      (target.predecessor === undefined && (!checkpointVerified || !checkpointAccepted)) ||
      authorized.size !== 0 ||
      modelRequests.size !== 0 ||
      profileEvent?.event.kind !== 'RunExecutionProfileBound' ||
      profileEvent.event.executionProfileSaid !== input.executionProfileSaid ||
      profileEvent.incarnationId !== checkpoint.incarnationId
    )
      return blockedEvidence;
    if (target.predecessor !== undefined) {
      if (
        blockedEvent?.event.kind !== 'RunBlocked' ||
        checkpoint.runState.kind !== 'Active' ||
        checkpoint.runState.phase.kind !== 'Blocked' ||
        blockedEvent.event.reason !== checkpoint.runState.phase.reason ||
        blockedEvent.event.checkpointSaid !== checkpoint.d ||
        calibrationEvent !== undefined ||
        failureEvent !== undefined
      )
        return blockedEvidence;
    } else if (run.binding.purpose.kind === 'Retained') {
      if (
        blockedEvent?.event.kind !== 'RunBlocked' ||
        blockedEvent.event.reason !== 'HarnessCompatibilityFailure' ||
        blockedEvent.event.checkpointSaid !== checkpoint.d ||
        calibrationEvent !== undefined
      )
        return blockedEvidence;
    } else if (
      calibrationEvent?.event.kind !== 'RunCalibrationRecorded' ||
      calibrationEvent.event.checkpointSaid !== checkpoint.d ||
      !isDeepStrictEqual(
        calibrationEvent.event.disposition,
        run.lifecycle.kind === 'Ended' && run.lifecycle.outcome.kind === 'CalibrationConfirmed'
          ? { kind: 'Confirmed', category: run.lifecycle.outcome.category }
          : run.lifecycle.kind === 'Ended' && run.lifecycle.outcome.kind === 'CalibrationExcluded'
            ? { kind: 'Excluded', reason: run.lifecycle.outcome.reason }
            : null,
      )
    )
      return blockedEvidence;
    for (const said of checkpoint.outputArtifactSaids) artifactSaids.add(said);
    for (const receipt of checkpoint.verifierReceipts) {
      if (receipt.outcome.kind !== 'Unresolved') {
        for (const said of receipt.outcome.outputArtifactSaids) artifactSaids.add(said);
      }
    }
    let profileBytes: Uint8Array | undefined;
    for (const said of artifactSaids) {
      const rawDocument = await this.#artifacts.findOne({
        _id: evidenceArtifactDocumentId(run.binding.runId, said),
        ownerAid,
        runId: run.binding.runId,
        evidenceStreamId: { $in: [...target.authorizedStreams] },
        'artifact.d': said,
      });
      if (rawDocument === null) return blockedEvidence;
      const raw = decodeEvidenceArtifactDocument(rawDocument);
      if (raw.artifact.d !== said || raw.ownerAid !== ownerAid) return blockedEvidence;
      if (said === profileEvent.event.profileArtifactSaid) {
        if (raw.artifact.mediaType !== 'application/json') return blockedProfile;
        profileBytes = raw.bytes;
      }
    }
    if (profileBytes === undefined) return blockedProfile;
    let profileInput: unknown;
    try {
      profileInput = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes));
    } catch {
      return blockedProfile;
    }
    const profile = decodeEvaluationExecutionProfile(profileInput);
    if (
      profile.kind !== 'Accepted' ||
      profile.profile.d !== input.executionProfileSaid ||
      profile.profile.sourceGitCommit !== run.binding.repository.commit ||
      profile.profile.sourceGitTree !== run.binding.repository.tree
    )
      return blockedProfile;
    for (const said of [
      profile.profile.h1InstructionSaid,
      profile.profile.effectiveLimitsReceiptSaid,
      profile.profile.parentDeathCleanupReceiptSaid,
    ]) {
      artifactSaids.add(said);
      const rawDocument = await this.#artifacts.findOne({
        _id: evidenceArtifactDocumentId(run.binding.runId, said),
        ownerAid,
        runId: run.binding.runId,
        evidenceStreamId: { $in: [...target.authorizedStreams] },
        'artifact.d': said,
      });
      if (rawDocument === null) return blockedProfile;
      const raw = decodeEvidenceArtifactDocument(rawDocument);
      if (raw.artifact.d !== said || raw.ownerAid !== ownerAid) return blockedProfile;
    }
    return {
      kind: 'Observed',
      observation: {
        run,
        incarnationId: checkpoint.incarnationId,
        worktreeId: profileEvent.event.worktreeBranch,
        executionProfileSaid: profile.profile.d,
        seal: {
          kind: 'Acknowledged',
          runId: run.binding.runId,
          checkpointSaid: checkpoint.d,
          evidenceHeadSaid: stream.cursor.chainHeadSaid,
          sealSaid: stream.seal.exchangeSaid,
          artifactSaids: [...artifactSaids],
        },
      },
      checkpoint,
      failureEvent,
    };
  }
}
