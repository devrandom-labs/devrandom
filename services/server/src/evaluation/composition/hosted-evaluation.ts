import { randomUUID } from 'node:crypto';

import type { Db, MongoClient } from 'mongodb';

import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import { workAccessHostedEvaluationAuthorizer } from '../../access/infrastructure/work-access-hosted-evaluation-authorizer.js';
import { readEvidence } from '../../evidence/application/read-evidence.js';
import { MongoEvidenceReading } from '../../evidence/infrastructure/mongo-evidence-reading.js';
import type { EvidenceReadRoutesConfiguration } from '../../evidence/route/evidence-read-routes.js';
import {
  retrieveExperience,
  type AnalogousExperience,
} from '../../experience/application/retrieve-experience.js';
import {
  readExperienceQueryReceipt,
  type ExperienceQueryReceiptReading,
} from '../../experience/application/read-query-receipt.js';
import type { ExperienceRoutesConfiguration } from '../../experience/route/experience-routes.js';
import type {
  CurrentTaskMandateAuthorization,
  CurrentTaskMandateInput,
} from '../../mandate/application/current-task-mandate.js';
import type { MandatePresentations } from '../../mandate/application/presentations.js';
import type { Tasks } from '../../task/application/tasks.js';
import { admitEvaluation } from '../application/admit-evaluation.js';
import { acceptEvaluationEvidence } from '../application/accept-evaluation-evidence.js';
import { closeEvaluation } from '../application/close-evaluation.js';
import { prepareEvaluation } from '../application/prepare-evaluation.js';
import { renewHostedEvaluationLease } from '../application/renew-evaluation-lease.js';
import { CurrentEvaluationEligibility } from '../infrastructure/current-evaluation-eligibility.js';
import { CurrentEvaluationSourceScopes } from '../infrastructure/current-evaluation-source-scopes.js';
import { MongoEvaluationEvidence } from '../infrastructure/mongo-evaluation-evidence.js';
import {
  evaluationCollectionNames,
  MongoEvaluationPreparations,
  MongoEvaluationReservations,
  type EvaluationDocument,
} from '../infrastructure/mongo-evaluation-reservations.js';
import type { EvaluationRoutesConfiguration } from '../route/evaluation-routes.js';

export interface HostedEvaluationComposition {
  readonly evaluation: EvaluationRoutesConfiguration;
  readonly evidenceReading: EvidenceReadRoutesConfiguration;
  readonly experience: ExperienceRoutesConfiguration;
}

/** No grading, winner selection or Governor signing key crosses into this server. */
export function composeHostedEvaluation(input: {
  readonly client: MongoClient;
  readonly database: Db;
  readonly attempts: WorkAccessAttempts;
  readonly tasks: Pick<Tasks, 'findById'>;
  readonly presentations: Pick<MandatePresentations, 'findByCredential'>;
  readonly currentTaskMandate: {
    authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
  };
  readonly experience?: AnalogousExperience;
  readonly experienceReceipts?: ExperienceQueryReceiptReading;
}): HostedEvaluationComposition {
  const access = workAccessHostedEvaluationAuthorizer(input.attempts);
  const sources = new CurrentEvaluationSourceScopes({
    database: input.database,
    tasks: input.tasks,
    presentations: input.presentations,
    currentTaskMandate: input.currentTaskMandate,
  });
  const preparations = new MongoEvaluationPreparations(input.database);
  const reservations = new MongoEvaluationReservations(input.client, input.database);
  const evidence = new MongoEvaluationEvidence(input.client, input.database);
  const reading = new MongoEvidenceReading(input.database);
  const eligibility = new CurrentEvaluationEligibility(input.database, sources);
  const evaluations = input.database.collection<EvaluationDocument>(
    evaluationCollectionNames.evaluations,
  );
  const now = () => new Date().toISOString();

  return {
    evaluation: {
      access,
      preparation: {
        prepare: (request) =>
          prepareEvaluation(request, {
            scopes: { inspect: (query) => sources.inspectPreparation(query) },
            storage: preparations,
          }),
      },
      admission: {
        admit: (request) => admitEvaluation(request, { eligibility, reservations }),
      },
      leases: {
        renew: (request) =>
          renewHostedEvaluationLease(request, {
            authority: {
              async inspect({ ownerAid, command }) {
                try {
                  const evaluation = await evaluations.findOne({
                    _id: command.evaluationId,
                    ownerAid,
                  });
                  if (evaluation === null || evaluation.closure !== undefined)
                    return { kind: 'Blocked', gate: 'Closed' } as const;
                  const current = await sources.inspectInventory({
                    ownerAid,
                    taskId: evaluation.command.taskId,
                    sourceInventorySaid: evaluation.command.sourceInventorySaid,
                  });
                  if (current.kind === 'Unavailable') return { kind: 'Unavailable' } as const;
                  if (
                    current.kind !== 'Authorized' ||
                    current.scope.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
                    current.scope.mandate.kind !== 'AuthorizedExperience' ||
                    current.scope.mandate.mandateSaid !== evaluation.command.taskMandateSaid
                  )
                    return { kind: 'Blocked', gate: 'Authority' } as const;
                  // The lease cannot extend effects without a reconciled residual allowance.
                  return { kind: 'Blocked', gate: 'Budget' } as const;
                } catch {
                  return { kind: 'Unavailable' } as const;
                }
              },
            },
            leases: reservations,
          }),
      },
      evidence: {
        async accept(request) {
          try {
            const evaluation = await evaluations.findOne({
              _id: request.upload.batch.evaluationId,
              ownerAid: request.ownerAid,
            });
            if (evaluation === null) return { kind: 'Conflict' };
            const current = await sources.inspectInventory({
              ownerAid: request.ownerAid,
              taskId: evaluation.command.taskId,
              sourceInventorySaid: evaluation.command.sourceInventorySaid,
            });
            if (current.kind === 'Unavailable') return { kind: 'Unavailable' };
            if (
              current.kind !== 'Authorized' ||
              current.scope.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
              current.scope.mandate.kind !== 'AuthorizedExperience' ||
              current.scope.mandate.mandateSaid !== evaluation.command.taskMandateSaid
            )
              return { kind: 'Rejected', reason: 'Binding' };
            return await acceptEvaluationEvidence(request, { batches: evidence });
          } catch {
            return { kind: 'Unavailable' };
          }
        },
        close: (request) =>
          closeEvaluation(request, {
            authority: {
              // agentSealSaid is content binding, not a verified agent signature.
              verify: () => Promise.resolve({ kind: 'Denied' }),
            },
            closures: evidence,
          }),
      },
      now,
      newCorrelationId: randomUUID,
    },
    evidenceReading: {
      access,
      conversation: {
        read: (request) =>
          readEvidence(request, {
            scope: { inspect: (query) => sources.inspectInventory(query) },
            reading,
          }),
      },
      now,
      newCorrelationId: randomUUID,
    },
    experience: {
      access,
      conversation: {
        retrieve: (request) =>
          input.experience === undefined
            ? Promise.resolve({ kind: 'Unavailable' as const })
            : retrieveExperience(request, {
                scopes: { inspect: (query) => sources.inspectInventory(query) },
                experience: input.experience,
              }),
        readReceipt: (request) =>
          input.experienceReceipts === undefined
            ? Promise.resolve({ kind: 'Unavailable' as const })
            : readExperienceQueryReceipt(request, {
                scopes: { inspect: (query) => sources.inspectInventory(query) },
                receipts: input.experienceReceipts,
              }),
      },
      now,
      newCorrelationId: randomUUID,
    },
  };
}
