import { describe, expect, it } from 'vitest';

import {
  promotionEvidenceClasses,
  verifyTaskMandate,
  type MandateCredentialEvidence,
  type MandateTask,
  type PromotionMandateExpectation,
  type TaskMandateInspection,
} from '../mandate/mandate-verification.js';
import { taskBudgetCeilings } from '../task/authority.js';
import {
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  verifyExactPromotionMandate,
  type ExactPromotionMandateInspection,
} from './exact-mandate.js';

const ownerAid = `E${'o'.repeat(43)}`;
const agentAid = `E${'a'.repeat(43)}`;
const governorAid = `E${'g'.repeat(43)}`;
const registryId = `E${'r'.repeat(43)}`;
const manifestSaid = `E${'m'.repeat(43)}`;
const schemaSaid = `E${'s'.repeat(43)}`;
const task: MandateTask = {
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  ownerAid,
  revisionSaid: `E${'v'.repeat(43)}`,
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
  requestedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
  unavailableCapabilities: ['EditRepository'],
  budgets: taskBudgetCeilings,
  evolutionClasses: ['C1', 'C2'],
  expiresAt: '2026-09-24T18:00:00.000Z',
};

function credential(
  issueeAid: string,
  said: string,
  credentialSchemaSaid: string,
): MandateCredentialEvidence {
  return {
    credentialSaid: said,
    attributeSaid: `E${'b'.repeat(43)}`,
    issuerAid: ownerAid,
    issueeAid,
    registryId,
    schemaSaid: credentialSchemaSaid,
    issuedAt: '2026-09-24T14:00:00.000Z',
    credentialSaidBinding: { kind: 'Verified' },
    attributeSaidBinding: { kind: 'Verified' },
    schemaDocument: { kind: 'Resolved', schemaSaid: credentialSchemaSaid },
    telState: { kind: 'Issued' },
    issuerAnchor: { kind: 'Anchored', eventSaid: `E${'i'.repeat(43)}` },
  };
}

const taskInspection: TaskMandateInspection = {
  credential: credential(agentAid, `E${'t'.repeat(43)}`, `E${'k'.repeat(43)}`),
  authority: 'ExecutePrivateTask',
  taskId: task.taskId,
  taskRevisionSaid: task.revisionSaid,
  harnessLineageId: task.harnessLineageId,
  repository: task.repository,
  allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
  budgets: taskBudgetCeilings,
  allowedEvolutionClasses: ['C1', 'C2'],
  notBefore: '2026-09-24T14:00:00.000Z',
  expiresAt: task.expiresAt,
};

function expectation(): PromotionMandateExpectation & { readonly evaluationManifestSaid: string } {
  const verifiedTask = verifyTaskMandate(
    {
      credential: {
        issuerAid: ownerAid,
        issueeAid: agentAid,
        registryId,
        schemaSaid: taskInspection.credential.schemaSaid,
        credentialSaid: taskInspection.credential.credentialSaid,
      },
      task,
      observedAt: '2026-09-24T15:00:00.000Z',
    },
    taskInspection,
  );
  if (verifiedTask.kind !== 'Current') throw new Error('Task fixture is invalid');
  return {
    credential: {
      issuerAid: ownerAid,
      issueeAid: governorAid,
      registryId,
      schemaSaid,
      credentialSaid: `E${'p'.repeat(43)}`,
    },
    task,
    taskMandate: verifiedTask.mandate,
    observedAt: '2026-09-24T15:00:00.000Z',
    evaluationManifestSaid: manifestSaid,
  };
}

function inspection(): ExactPromotionMandateInspection {
  return {
    credential: credential(governorAid, `E${'p'.repeat(43)}`, schemaSaid),
    authority: 'ActivateEvaluatedSuccessor',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgetCeiling: taskBudgetCeilings,
    evolutionClassCeiling: ['C1', 'C2'],
    requiredEvidenceClasses: promotionEvidenceClasses,
    notBefore: '2026-09-24T14:00:00.000Z',
    expiresAt: task.expiresAt,
    evaluationManifestSaid: manifestSaid,
    requiredMetrics: promotionRequiredMetrics,
    requiredChecks: promotionRequiredChecks,
    riskLimit: promotionRiskLimit,
  };
}

describe('exact-M Promotion Mandate', () => {
  it('requires the current user-issued Governor mandate and exact frozen M', () => {
    const result = verifyExactPromotionMandate(expectation(), inspection());
    expect(result).toMatchObject({
      kind: 'Current',
      mandate: { evaluationManifestSaid: manifestSaid },
    });
    expect(
      verifyExactPromotionMandate(expectation(), {
        ...inspection(),
        evaluationManifestSaid: `E${'x'.repeat(43)}`,
      }),
    ).toEqual({ kind: 'Invalid', invalidity: { kind: 'EvaluationManifestMismatch' } });
  });

  it('rejects omitted or reordered required metrics/checks and any relaxed risk ceiling', () => {
    expect(
      verifyExactPromotionMandate(expectation(), {
        ...inspection(),
        requiredMetrics: promotionRequiredMetrics.slice(1),
      }),
    ).toEqual({ kind: 'Invalid', invalidity: { kind: 'RequiredMetricsMismatch' } });
    expect(
      verifyExactPromotionMandate(expectation(), {
        ...inspection(),
        requiredChecks: [...promotionRequiredChecks].reverse(),
      }),
    ).toEqual({ kind: 'Invalid', invalidity: { kind: 'RequiredChecksMismatch' } });
    expect(
      verifyExactPromotionMandate(expectation(), {
        ...inspection(),
        riskLimit: { ...promotionRiskLimit, maximumUnsafeEffects: 1 },
      }),
    ).toEqual({ kind: 'Invalid', invalidity: { kind: 'RiskLimitMismatch' } });
  });

  it('does not turn an expired or wrong-schema mandate into current exact authority', () => {
    const expired = verifyExactPromotionMandate(
      { ...expectation(), observedAt: task.expiresAt },
      inspection(),
    );
    expect(expired).toMatchObject({ kind: 'Invalid', invalidity: { kind: 'Expired' } });
    const wrongSchema = verifyExactPromotionMandate(expectation(), {
      ...inspection(),
      credential: credential(governorAid, `E${'p'.repeat(43)}`, `E${'z'.repeat(43)}`),
    });
    expect(wrongSchema).toMatchObject({
      kind: 'Invalid',
      invalidity: { kind: 'UnexpectedSchema' },
    });
  });
});
