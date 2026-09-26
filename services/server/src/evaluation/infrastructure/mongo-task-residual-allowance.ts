import { isDeepStrictEqual } from 'node:util';

import type { ClientSession, Collection, Db } from 'mongodb';
import Value from 'typebox/value';

import {
  assessResidualEvaluationAllowance,
  evaluationConsumables,
  taskBudgetNames,
  type EvaluationAllowance,
  type EvaluationDebit,
  type EvaluationReservation,
  type TaskBudgets,
  type Run,
} from '@devrandom/domain';
import {
  decodeEvaluationClosure,
  decodeRunSuccessorSegment,
  verifyContinuationPredecessor,
  type RunSuccessorSegment,
  evidenceArtifactReferences,
  evaluationAdmissionCommandSchema,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import {
  decodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  decodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import {
  evidenceEventBelongsToRun,
  evidenceCheckpointBelongsToRun,
  privacyCheckpointMarkersMatch,
} from '../../evidence/domain/run-binding.js';
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
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';

/** Stored projection only. The writer must derive usage from accepted raw events, verify the signed closure, retain the debit artifact, and commit both atomically. */
export interface SettledEvaluationDebit {
  readonly closureSaid: string;
  readonly consumed: EvaluationAllowance;
  readonly artifactSaid: string;
}

interface EvaluationSpendDocument extends EvaluationDocument {
  readonly settledDebit?: SettledEvaluationDebit;
}

export type TaskResidualAllowanceInspection =
  | { readonly kind: 'Available'; readonly remaining: EvaluationAllowance }
  | {
      readonly kind: 'Blocked';
      readonly reason:
        | 'TaskMissing'
        | 'TaskRevisionMismatch'
        | 'TaskProofInvalid'
        | 'UnresolvedRunSpend'
        | 'RunProofMissing'
        | 'RunProofInvalid'
        | 'EvaluationReservationProofInvalid'
        | 'EvaluationDebitProofMissing'
        | 'EvaluationDebitProofInvalid'
        | 'ResidualUnavailable';
      readonly detail?: string;
    }
  | { readonly kind: 'Unavailable' };

export interface TaskResidualAllowanceQuery {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  /** The caller has already verified the current Task Mandate, TEL and exact Task binding. */
  readonly verifiedMandateCeiling: EvaluationAllowance;
}

function consumables(budget: TaskBudgets): EvaluationAllowance {
  return Object.fromEntries(
    evaluationConsumables.map((name) => [name, budget[name]]),
  ) as EvaluationAllowance;
}

function validAllowance(amounts: EvaluationAllowance): boolean {
  return (
    Object.keys(amounts).length === evaluationConsumables.length &&
    evaluationConsumables.every((name) => Number.isSafeInteger(amounts[name]) && amounts[name] >= 0)
  );
}

function artifactSaid(value: object): string | undefined {
  const prepared = prepareEvidenceArtifact(
    new TextEncoder().encode(JSON.stringify(value)),
    'application/json',
  );
  return prepared.kind === 'Prepared' ? prepared.artifact.d : undefined;
}

/** Reads all Task spend; the admission writer must repeat this inside its reservation transaction. */
export class MongoTaskResidualAllowance {
  readonly #segments: Collection<RunSuccessorSegmentDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #evaluations: Collection<EvaluationSpendDocument>;

  constructor(database: Db) {
    this.#segments = database.collection(runSuccessorSegmentsCollectionName);
    this.#tasks = database.collection(tasksCollectionName);
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#events = database.collection(evidenceCollectionNames.events);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
  }

  async #incarnations(
    run: Run,
    session?: ClientSession,
  ): Promise<
    readonly { readonly run: Run; readonly predecessor?: RunSuccessorSegment }[] | undefined
  > {
    const documents = await this.#segments
      .find(
        { ownerAid: run.binding.ownerAid, runId: run.binding.runId },
        session === undefined ? {} : { session },
      )
      .toArray();
    if (documents.length === 0) return run.currentExecution === undefined ? [{ run }] : undefined;
    if (
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      run.lease.kind !== 'Held'
    )
      return undefined;
    const segments: RunSuccessorSegment[] = [];
    for (const document of documents) {
      const decoded = decodeRunSuccessorSegment(document.segment);
      if (decoded.kind !== 'Accepted') return undefined;
      const segment = decoded.segment;
      if (
        segment.version !== 2 ||
        document._id !== segment.d ||
        document.ownerAid !== run.binding.ownerAid ||
        document.runId !== run.binding.runId ||
        document.acceptedAt.toISOString() !== segment.admittedAt ||
        segment.ownerAid !== run.binding.ownerAid ||
        segment.runId !== run.binding.runId ||
        segment.taskId !== run.binding.taskId ||
        segment.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        segment.personalAgentAid !== run.binding.personalAgentAid ||
        segment.taskMandateSaid !== run.binding.taskMandateSaid ||
        segment.baseline.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        segment.successor.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid
      )
        return undefined;
      segments.push(segment);
    }
    const targets: { run: Run; predecessor?: RunSuccessorSegment }[] = [];
    const streams = new Set([run.binding.evidenceStreamId]);
    const incarnations = new Set<string>();
    let streamId = run.binding.evidenceStreamId;
    let previous: RunSuccessorSegment | undefined;
    while (segments.length > 0) {
      const matches = segments.filter(
        (segment) => segment.predecessor.evidenceStreamId === streamId,
      );
      const segment = matches[0];
      if (
        matches.length !== 1 ||
        segment === undefined ||
        streams.has(segment.successor.evidenceStreamId) ||
        incarnations.has(segment.successor.incarnationId) ||
        segment.predecessor.incarnationId === segment.successor.incarnationId ||
        (previous !== undefined &&
          (segment.predecessor.incarnationId !== previous.successor.incarnationId ||
            segment.fromRunVersion <= previous.fromRunVersion ||
            segment.admittedAt < previous.admittedAt))
      )
        return undefined;
      const original = { ...run };
      Reflect.deleteProperty(original, 'currentExecution');
      // Read-only verification projection: the committed segment identifies the old
      // incarnation; verifyContinuationPredecessor authenticates its sealed prefix.
      // This projection is never persisted or used to authorize execution.
      const historical: Run = {
        ...original,
        version: segment.fromRunVersion,
        consumedBudget: segment.consumedBudget,
        lease: { ...run.lease, incarnationId: segment.predecessor.incarnationId },
        lifecycle: {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: 'ContextLimitReached',
            checkpointSaid: segment.predecessor.checkpointSaid,
          },
        },
        ...(previous === undefined
          ? {}
          : {
              currentExecution: {
                segmentSaid: previous.d,
                evidenceStreamId: streamId,
                harnessRevisionSaid: previous.successor.harnessRevisionSaid,
              },
            }),
      };
      targets.push({ run: historical, predecessor: segment });
      streams.add(segment.successor.evidenceStreamId);
      incarnations.add(segment.predecessor.incarnationId);
      incarnations.add(segment.successor.incarnationId);
      streamId = segment.successor.evidenceStreamId;
      previous = segment;
      segments.splice(segments.indexOf(segment), 1);
    }
    if (
      previous === undefined ||
      run.currentExecution?.segmentSaid !== previous.d ||
      run.currentExecution.evidenceStreamId !== streamId ||
      run.currentExecution.harnessRevisionSaid !== previous.successor.harnessRevisionSaid ||
      run.lease.incarnationId !== previous.successor.incarnationId ||
      run.version <= previous.fromRunVersion
    )
      return undefined;
    targets.push({ run });
    return targets;
  }

  async inspect(
    input: TaskResidualAllowanceQuery,
    session?: ClientSession,
  ): Promise<TaskResidualAllowanceInspection> {
    const options = session === undefined ? {} : { session };
    try {
      const taskDocument = await this.#tasks.findOne(
        {
          _id: input.taskId,
          ownerAid: input.ownerAid,
        },
        options,
      );
      if (taskDocument === null) return { kind: 'Blocked', reason: 'TaskMissing' };
      let task;
      try {
        task = decodeTaskDocument(taskDocument).task;
      } catch {
        return { kind: 'Blocked', reason: 'TaskProofInvalid' };
      }
      if (
        task.taskId !== input.taskId ||
        task.ownerAid !== input.ownerAid ||
        task.revisionSaid !== input.taskRevisionSaid
      )
        return { kind: 'Blocked', reason: 'TaskRevisionMismatch' };

      const runDocuments = await this.#runs
        .find(
          {
            ownerAid: input.ownerAid,
            taskId: input.taskId,
          },
          options,
        )
        .toArray();
      const evaluationDocuments = await this.#evaluations
        .find(
          {
            ownerAid: input.ownerAid,
            'command.taskId': input.taskId,
          },
          options,
        )
        .toArray();
      const debits: EvaluationDebit[] = [];
      const reservations: EvaluationReservation[] = [];

      for (const document of runDocuments) {
        let run;
        try {
          run = decodeRunDocument(document).run;
        } catch {
          return { kind: 'Blocked', reason: 'RunProofInvalid' };
        }
        if (
          run.binding.ownerAid !== input.ownerAid ||
          run.binding.taskId !== input.taskId ||
          run.binding.taskRevisionSaid !== input.taskRevisionSaid
        )
          return { kind: 'Blocked', reason: 'RunProofInvalid' };
        const currentRun = run;
        const targets = await this.#incarnations(currentRun, session);
        if (targets === undefined) return { kind: 'Blocked', reason: 'RunProofInvalid' };
        const authorizedStreams: string[] = [];
        let previousBudget = { ...currentRun.consumedBudget };
        for (const name of taskBudgetNames) previousBudget[name] = 0;
        for (const target of targets) {
          const run = target.run;
          const streamId = run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId;
          authorizedStreams.push(streamId);
          const checkpointSaid =
            run.lifecycle.kind === 'Ended'
              ? run.lifecycle.outcome.checkpointSaid
              : run.lifecycle.phase.kind === 'Blocked'
                ? run.lifecycle.phase.checkpointSaid
                : undefined;
          if (checkpointSaid === undefined)
            return { kind: 'Blocked', reason: 'UnresolvedRunSpend' };
          const streamDocument = await this.#streams.findOne(
            {
              _id: streamId,
              'binding.ownerAid': input.ownerAid,
            },
            options,
          );
          const checkpointDocument = await this.#checkpoints.findOne(
            {
              _id: checkpointSaid,
              ownerAid: input.ownerAid,
              runId: run.binding.runId,
            },
            options,
          );
          if (streamDocument === null || checkpointDocument === null)
            return { kind: 'Blocked', reason: 'RunProofMissing' };
          try {
            const stream = decodeEvidenceStreamDocument(streamDocument);
            const checkpoint = decodeEvidenceCheckpointDocument(
              checkpointDocument,
              task.revision.completionConditions.map((condition) => condition.id),
            ).checkpoint;
            if (
              !evidenceCheckpointBelongsToRun(checkpoint, run) ||
              stream.binding.streamId !== streamId ||
              stream.binding.incarnationId !== checkpoint.incarnationId ||
              stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
              stream.binding.taskMandateSaid !== run.binding.taskMandateSaid ||
              stream.binding.harnessRevisionSaid !== checkpoint.harnessRevisionSaid ||
              checkpoint.taskId !== run.binding.taskId ||
              checkpoint.personalAgentAid !== run.binding.personalAgentAid ||
              checkpoint.taskMandateSaid !== run.binding.taskMandateSaid ||
              !isDeepStrictEqual(checkpoint.purpose, run.binding.purpose) ||
              stream.binding.runId !== run.binding.runId ||
              stream.binding.ownerAid !== input.ownerAid ||
              stream.binding.taskId !== input.taskId ||
              stream.binding.taskRevisionSaid !== input.taskRevisionSaid ||
              stream.seal.kind !== 'Sealed' ||
              stream.provisional.kind !== 'Checkpointed' ||
              stream.provisional.checkpointSaid !== checkpointSaid ||
              !isDeepStrictEqual(stream.provisional.lifecycle, run.lifecycle) ||
              checkpoint.runId !== run.binding.runId ||
              checkpoint.taskRevisionSaid !== input.taskRevisionSaid ||
              checkpointDocument.ownerAid !== input.ownerAid ||
              checkpointDocument.evidenceStreamId !== streamId ||
              !isDeepStrictEqual(checkpoint.budget.consumed, run.consumedBudget) ||
              taskBudgetNames.some(
                (name) =>
                  checkpoint.budget.remaining[name] !==
                  Math.max(0, run.binding.budget[name] - run.consumedBudget[name]),
              ) ||
              stream.cursor.kind !== 'Continued'
            )
              return { kind: 'Blocked', reason: 'RunProofInvalid' };
            const eventDocuments = await this.#events
              .find(
                {
                  ownerAid: input.ownerAid,
                  runId: run.binding.runId,
                  evidenceStreamId: streamId,
                  sequence: { $lte: stream.cursor.acceptedThrough },
                },
                options,
              )
              .sort({ sequence: 1 })
              .toArray();
            if (eventDocuments.length !== stream.cursor.acceptedThrough + 1)
              return { kind: 'Blocked', reason: 'RunProofInvalid' };
            const events = eventDocuments.map((document) => {
              const accepted = decodeEvidenceEventDocument(document);
              if (
                accepted.ownerAid !== input.ownerAid ||
                accepted.evidenceStreamId !== streamId ||
                (target.predecessor === undefined &&
                  !evidenceEventBelongsToRun(accepted.event, run))
              )
                throw new Error('Run event custody mismatch');
              return accepted.event;
            });
            for (let sequence = 0; sequence < events.length; sequence++) {
              const event = events[sequence];
              if (
                event === undefined ||
                event.sequence !== sequence ||
                (sequence === 0
                  ? event.predecessor.kind !== 'Genesis'
                  : event.predecessor.kind !== 'Previous' ||
                    event.predecessor.eventSaid !== events[sequence - 1]?.d)
              )
                return { kind: 'Blocked', reason: 'RunProofInvalid' };
            }
            if (
              target.predecessor !== undefined &&
              (target.predecessor.predecessor.finalSequence !== stream.cursor.acceptedThrough ||
                events.some((event) => event.recordedAt > (target.predecessor?.admittedAt ?? '')) ||
                stream.seal.sealedAt > target.predecessor.admittedAt ||
                verifyContinuationPredecessor({
                  run,
                  stream,
                  checkpoint,
                  events,
                  sealExchangeSaid: target.predecessor.predecessor.sealExchangeSaid,
                  chainHeadSaid: target.predecessor.predecessor.chainHeadSaid,
                  completionConditionIds: task.revision.completionConditions.map(
                    (condition) => condition.id,
                  ),
                }) !== 'Verified')
            )
              return { kind: 'Blocked', reason: 'RunProofInvalid' };
            if (currentRun.currentExecution !== undefined) {
              const replayed = { ...previousBudget };
              for (const event of events) {
                if (event.event.kind !== 'BudgetDebited') continue;
                const debit = event.event;
                const consumed = replayed[debit.budget] + debit.amount;
                if (!Number.isSafeInteger(consumed) || consumed !== debit.consumed)
                  return { kind: 'Blocked', reason: 'RunProofInvalid' };
                replayed[debit.budget] = consumed;
              }
              if (!isDeepStrictEqual(replayed, checkpoint.budget.consumed))
                return { kind: 'Blocked', reason: 'RunProofInvalid' };
              previousBudget = replayed;
            }
            const checkpointEvent = events[checkpoint.evidence.finalSequence];
            if (
              checkpoint.evidence.eventCount !== checkpoint.evidence.finalSequence + 1 ||
              checkpointEvent?.d !== checkpoint.evidence.chainHeadSaid ||
              checkpointEvent.incarnationId !== checkpoint.incarnationId ||
              events.at(-1)?.d !== stream.cursor.chainHeadSaid ||
              !privacyCheckpointMarkersMatch(
                checkpoint,
                events.slice(0, checkpoint.evidence.finalSequence + 1),
              )
            )
              return { kind: 'Blocked', reason: 'RunProofInvalid' };
            const references = new Set<string>([
              ...events.flatMap((event) => evidenceArtifactReferences(event.event)),
              ...checkpoint.outputArtifactSaids,
              ...checkpoint.verifierReceipts.flatMap((receipt) =>
                receipt.outcome.kind === 'Accepted' || receipt.outcome.kind === 'Rejected'
                  ? receipt.outcome.outputArtifactSaids
                  : [],
              ),
            ]);
            if (references.size > 0) {
              const artifacts = await this.#artifacts
                .find(
                  {
                    ownerAid: input.ownerAid,
                    runId: run.binding.runId,
                    evidenceStreamId: { $in: authorizedStreams },
                    'artifact.d': { $in: [...references] },
                  },
                  options,
                )
                .toArray();
              if (
                new Set(artifacts.map((document) => document.artifact.d)).size !== references.size
              )
                return { kind: 'Blocked', reason: 'RunProofMissing' };
              for (const document of artifacts) {
                const artifact = decodeEvidenceArtifactDocument(document);
                if (
                  artifact.ownerAid !== input.ownerAid ||
                  artifact.runId !== run.binding.runId ||
                  !authorizedStreams.includes(artifact.evidenceStreamId) ||
                  !references.has(artifact.artifact.d)
                )
                  return { kind: 'Blocked', reason: 'RunProofInvalid' };
              }
            }
          } catch {
            return { kind: 'Blocked', reason: 'RunProofInvalid' };
          }
        }
        debits.push({
          sourceId: run.binding.runId,
          kind: 'Settled',
          consumed: consumables(run.consumedBudget),
        });
      }

      for (const evaluation of evaluationDocuments) {
        if (
          evaluation.ownerAid !== input.ownerAid ||
          !Value.Check(evaluationAdmissionCommandSchema, evaluation.command) ||
          evaluation.command.taskId !== input.taskId ||
          evaluation.command.taskRevisionSaid !== input.taskRevisionSaid ||
          !validAllowance(evaluation.reserved) ||
          evaluation.reservationSaid !==
            artifactSaid({
              evaluationId: evaluation._id,
              ownerAid: evaluation.ownerAid,
              commandId: evaluation.command.commandId,
              originRunId: evaluation.command.originRunId,
              reserved: evaluation.reserved,
            })
        )
          return { kind: 'Blocked', reason: 'EvaluationReservationProofInvalid' };
        if (evaluation.closure === undefined) {
          if (
            evaluation.activeOwnerSlot !== input.ownerAid ||
            evaluation.settledDebit !== undefined
          )
            return { kind: 'Blocked', reason: 'EvaluationReservationProofInvalid' };
          reservations.push({ sourceId: evaluation._id, reserved: evaluation.reserved });
          continue;
        }
        if (evaluation.settledDebit === undefined)
          return { kind: 'Blocked', reason: 'EvaluationDebitProofMissing' };
        const decoded = decodeEvaluationClosure(evaluation.closure);
        const settled = evaluation.settledDebit;
        if (
          decoded.kind !== 'Accepted' ||
          evaluation.activeOwnerSlot !== undefined ||
          decoded.closure.evaluationId !== evaluation._id ||
          decoded.closure.originRunId !== evaluation.command.originRunId ||
          decoded.closure.evidenceStreamId !== evaluation.evidenceStreamId ||
          settled.closureSaid !== decoded.closure.d ||
          !validAllowance(settled.consumed) ||
          evaluationConsumables.some(
            (name) => settled.consumed[name] > evaluation.reserved[name],
          ) ||
          settled.artifactSaid !==
            artifactSaid({
              evaluationId: evaluation._id,
              closureSaid: settled.closureSaid,
              consumed: settled.consumed,
            })
        )
          return { kind: 'Blocked', reason: 'EvaluationDebitProofInvalid' };
        debits.push({ sourceId: evaluation._id, kind: 'Settled', consumed: settled.consumed });
      }

      const residual = assessResidualEvaluationAllowance({
        taskCeiling: consumables(task.revision.budgets),
        mandateCeiling: input.verifiedMandateCeiling,
        debits,
        reservations,
      });
      return residual.kind === 'Available'
        ? residual
        : { kind: 'Blocked', reason: 'ResidualUnavailable', detail: residual.reason };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
