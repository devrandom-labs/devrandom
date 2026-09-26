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
} from '@devrandom/domain';
import {
  decodeEvaluationClosure,
  evaluationAdmissionCommandSchema,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import {
  decodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
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
  readonly #tasks: Collection<TaskDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #evaluations: Collection<EvaluationSpendDocument>;

  constructor(database: Db) {
    this.#tasks = database.collection(tasksCollectionName);
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
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
        const checkpointSaid =
          run.lifecycle.kind === 'Ended'
            ? run.lifecycle.outcome.checkpointSaid
            : run.lifecycle.phase.kind === 'Blocked'
              ? run.lifecycle.phase.checkpointSaid
              : undefined;
        if (checkpointSaid === undefined) return { kind: 'Blocked', reason: 'UnresolvedRunSpend' };
        const streamDocument = await this.#streams.findOne(
          {
            _id: run.binding.evidenceStreamId,
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
            checkpointDocument.evidenceStreamId !== run.binding.evidenceStreamId ||
            !isDeepStrictEqual(checkpoint.budget.consumed, run.consumedBudget) ||
            taskBudgetNames.some(
              (name) =>
                checkpoint.budget.remaining[name] !==
                Math.max(0, run.binding.budget[name] - run.consumedBudget[name]),
            ) ||
            stream.cursor.kind !== 'Continued' ||
            stream.cursor.acceptedThrough !== checkpoint.evidence.finalSequence ||
            stream.cursor.chainHeadSaid !== checkpoint.evidence.chainHeadSaid
          )
            return { kind: 'Blocked', reason: 'RunProofInvalid' };
        } catch {
          return { kind: 'Blocked', reason: 'RunProofInvalid' };
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
