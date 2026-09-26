import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings, type TaskBudgets } from '../task/authority.js';
import {
  promotionEvidenceClasses,
  verifyPromotionMandate,
  verifyTaskMandate,
  type MandateCredentialEvidence,
  type MandateCredentialExpectation,
  type MandateTask,
  type PromotionMandateInspection,
  type TaskMandateInspection,
} from './mandate-verification.js';

const ownerAid = `E${'o'.repeat(43)}`;
const agentAid = `E${'a'.repeat(43)}`;
const governorAid = `E${'g'.repeat(43)}`;
const registryId = `E${'r'.repeat(43)}`;
const taskSchemaSaid = `E${'t'.repeat(43)}`;
const promotionSchemaSaid = `E${'p'.repeat(43)}`;
const taskCredentialSaid = `E${'c'.repeat(43)}`;
const promotionCredentialSaid = `E${'d'.repeat(43)}`;
const issuedAt = '2026-09-24T14:00:00.000Z';
const expiresAt = '2026-09-24T18:00:00.000Z';

const task: MandateTask = {
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  ownerAid,
  revisionSaid: `E${'v'.repeat(43)}`,
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  repository: {
    objectFormat: 'sha1',
    commit: '1'.repeat(40),
    tree: '2'.repeat(40),
  },
  requestedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
  unavailableCapabilities: ['EditRepository'],
  budgets: taskBudgetCeilings,
  evolutionClasses: ['C1', 'C2'],
  expiresAt,
};

function credential(
  issueeAid: string,
  schemaSaid: string,
  credentialSaid: string,
): MandateCredentialEvidence {
  return {
    credentialSaid,
    attributeSaid: `E${'b'.repeat(43)}`,
    issuerAid: ownerAid,
    issueeAid,
    registryId,
    schemaSaid,
    issuedAt,
    credentialSaidBinding: { kind: 'Verified' },
    attributeSaidBinding: { kind: 'Verified' },
    schemaDocument: { kind: 'Resolved', schemaSaid },
    telState: { kind: 'Issued' },
    issuerAnchor: { kind: 'Anchored', eventSaid: `E${'i'.repeat(43)}` },
  };
}

function expectation(
  issueeAid: string,
  schemaSaid: string,
  credentialSaid: string,
): MandateCredentialExpectation {
  return { issuerAid: ownerAid, issueeAid, registryId, schemaSaid, credentialSaid };
}

function taskInspection(): TaskMandateInspection {
  return {
    credential: credential(agentAid, taskSchemaSaid, taskCredentialSaid),
    authority: 'ExecutePrivateTask',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.repository,
    allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgets: taskBudgetCeilings,
    allowedEvolutionClasses: ['C1', 'C2'],
    notBefore: issuedAt,
    expiresAt,
  };
}

function verifiedTaskMandate(mandateTask: MandateTask, inspection: TaskMandateInspection) {
  const verification = verifyTaskMandate(
    {
      credential: expectation(agentAid, taskSchemaSaid, taskCredentialSaid),
      task: mandateTask,
      observedAt: '2026-09-24T15:00:00.000Z',
    },
    inspection,
  );
  if (verification.kind !== 'Current') {
    throw new Error(`Task Mandate fixture failed: ${verification.invalidity.kind}`);
  }
  return verification.mandate;
}

function currentTaskMandate() {
  return verifiedTaskMandate(task, taskInspection());
}

function promotionInspection(): PromotionMandateInspection {
  return {
    credential: credential(governorAid, promotionSchemaSaid, promotionCredentialSaid),
    authority: 'ActivateEvaluatedSuccessor',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgetCeiling: taskBudgetCeilings,
    evolutionClassCeiling: ['C1', 'C2'],
    requiredEvidenceClasses: promotionEvidenceClasses,
    notBefore: issuedAt,
    expiresAt,
  };
}

describe('Task Mandate verification', () => {
  it('constructs current authority only after every credential and Task binding is verified', () => {
    const inspection = taskInspection();

    const result = verifyTaskMandate(
      {
        credential: expectation(agentAid, taskSchemaSaid, taskCredentialSaid),
        task,
        observedAt: '2026-09-24T15:00:00.000Z',
      },
      inspection,
    );

    expect(result).toMatchObject({ kind: 'Current', mandate: inspection });
  });

  it('requires the Task owner to be the credential issuer', () => {
    const original = taskInspection();
    const inspection: TaskMandateInspection = {
      ...original,
      credential: { ...original.credential, issuerAid: governorAid },
    };

    const result = verifyTaskMandate(
      {
        credential: {
          ...expectation(agentAid, taskSchemaSaid, taskCredentialSaid),
          issuerAid: governorAid,
        },
        task,
        observedAt: '2026-09-24T15:00:00.000Z',
      },
      inspection,
    );

    expect(result).toEqual({
      kind: 'Invalid',
      invalidity: { kind: 'UnexpectedIssuer', expected: ownerAid, actual: governorAid },
    });
  });

  it('authorizes historical effects before revocation and fails closed at or after it', () => {
    const original = taskInspection();
    const revoked: TaskMandateInspection = {
      ...original,
      credential: {
        ...original.credential,
        telState: { kind: 'Revoked', revokedAt: '2026-09-24T15:30:00.000Z' },
      },
    };
    const expected = expectation(agentAid, taskSchemaSaid, taskCredentialSaid);

    expect(
      verifyTaskMandate(
        { credential: expected, task, observedAt: '2026-09-24T15:29:59.999Z' },
        revoked,
      ),
    ).toMatchObject({ kind: 'Current' });
    expect(
      verifyTaskMandate(
        { credential: expected, task, observedAt: '2026-09-24T15:30:00.000Z' },
        revoked,
      ),
    ).toEqual({
      kind: 'Invalid',
      invalidity: { kind: 'CredentialRevoked', revokedAt: '2026-09-24T15:30:00.000Z' },
    });
    expect(
      verifyTaskMandate(
        { credential: expected, task, observedAt: '2026-09-24T15:00:00.000Z' },
        {
          ...revoked,
          credential: {
            ...revoked.credential,
            telState: { kind: 'Revoked', revokedAt: 'not-a-timestamp' },
          },
        },
      ),
    ).toEqual({
      kind: 'Invalid',
      invalidity: { kind: 'IncompatibleCredentialState' },
    });
  });

  it.each([
    [
      'UnexpectedIssuer',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: { ...inspection.credential, issuerAid: governorAid },
      }),
    ],
    [
      'UnexpectedIssuee',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: { ...inspection.credential, issueeAid: governorAid },
      }),
    ],
    [
      'UnexpectedRegistry',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: { ...inspection.credential, registryId: `E${'x'.repeat(43)}` },
      }),
    ],
    [
      'UnexpectedSchema',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: { ...inspection.credential, schemaSaid: promotionSchemaSaid },
      }),
    ],
    [
      'CredentialSaidMismatch',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: {
          ...inspection.credential,
          credentialSaidBinding: { kind: 'Mismatch' },
        },
      }),
    ],
    [
      'AttributeSaidMismatch',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: {
          ...inspection.credential,
          attributeSaidBinding: { kind: 'Mismatch' },
        },
      }),
    ],
    [
      'CredentialRevoked',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        credential: {
          ...inspection.credential,
          telState: { kind: 'Revoked', revokedAt: issuedAt },
        },
      }),
    ],
    [
      'UnexpectedTaskRevision',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        taskRevisionSaid: `E${'x'.repeat(43)}`,
      }),
    ],
    [
      'RepositoryBindingMismatch',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        repository: { ...inspection.repository, commit: '3'.repeat(40) },
      }),
    ],
    [
      'CapabilityOutsideTask',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        allowedCapabilities: ['EditRepository'],
      }),
    ],
    [
      'EvolutionClassOutsideTask',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        allowedEvolutionClasses: ['C3'],
      }),
    ],
    [
      'ExpiryMismatch',
      (inspection: TaskMandateInspection): TaskMandateInspection => ({
        ...inspection,
        expiresAt: '2026-09-24T17:59:59.999Z',
      }),
    ],
  ] satisfies readonly [string, (inspection: TaskMandateInspection) => TaskMandateInspection][])(
    'preserves %s as a distinct invalidity',
    (kind, change) => {
      const inspection = change(taskInspection());
      const result = verifyTaskMandate(
        {
          credential: expectation(agentAid, taskSchemaSaid, taskCredentialSaid),
          task,
          observedAt: '2026-09-24T15:00:00.000Z',
        },
        inspection,
      );

      expect(result).toMatchObject({ kind: 'Invalid', invalidity: { kind } });
    },
  );
});

describe('Promotion Mandate verification', () => {
  it('constructs current promotion authority only within the current Task Mandate ceiling', () => {
    const inspection = promotionInspection();
    const result = verifyPromotionMandate(
      {
        credential: expectation(governorAid, promotionSchemaSaid, promotionCredentialSaid),
        task,
        taskMandate: currentTaskMandate(),
        observedAt: '2026-09-24T15:00:00.000Z',
      },
      inspection,
    );

    expect(result).toMatchObject({ kind: 'Current', mandate: inspection });
  });

  it('requires the ceiling source to be the current mandate for the same Task', () => {
    const otherTask: MandateTask = {
      ...task,
      taskId: '918cb3d4-4674-43a1-9077-dcbf837cb4ed',
    };
    const otherInspection: TaskMandateInspection = {
      ...taskInspection(),
      taskId: otherTask.taskId,
    };

    const result = verifyPromotionMandate(
      {
        credential: expectation(governorAid, promotionSchemaSaid, promotionCredentialSaid),
        task,
        taskMandate: verifiedTaskMandate(otherTask, otherInspection),
        observedAt: '2026-09-24T15:00:00.000Z',
      },
      promotionInspection(),
    );

    expect(result).toEqual({
      kind: 'Invalid',
      invalidity: {
        kind: 'UnexpectedTask',
        expected: task.taskId,
        actual: otherTask.taskId,
      },
    });
  });

  it.each([
    [
      'AuthorityMismatch',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        authority: 'ExecutePrivateTask',
      }),
    ],
    [
      'CapabilityCeilingOutsideTaskMandate',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        capabilityCeiling: ['RunFormatter'],
      }),
    ],
    [
      'DuplicateCapability',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        capabilityCeiling: ['ReadRepository', 'ReadRepository'],
      }),
    ],
    [
      'BudgetCeilingOutsideTaskMandate',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        budgetCeiling: {
          ...taskBudgetCeilings,
          providerRequests: taskBudgetCeilings.providerRequests + 1,
        } satisfies TaskBudgets,
      }),
    ],
    [
      'EvolutionClassCeilingOutsideTaskMandate',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        evolutionClassCeiling: ['C3'],
      }),
    ],
    [
      'DuplicateEvolutionClass',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        evolutionClassCeiling: ['C1', 'C1'],
      }),
    ],
    [
      'EvidenceRequirementsMismatch',
      (inspection: PromotionMandateInspection): PromotionMandateInspection => ({
        ...inspection,
        requiredEvidenceClasses: ['Diagnosis'],
      }),
    ],
  ] satisfies readonly [
    string,
    (inspection: PromotionMandateInspection) => PromotionMandateInspection,
  ][])('preserves %s as a distinct invalidity', (kind, change) => {
    const inspection = change(promotionInspection());
    const result = verifyPromotionMandate(
      {
        credential: expectation(governorAid, promotionSchemaSaid, promotionCredentialSaid),
        task,
        taskMandate: currentTaskMandate(),
        observedAt: '2026-09-24T15:00:00.000Z',
      },
      inspection,
    );

    expect(result).toMatchObject({ kind: 'Invalid', invalidity: { kind } });
  });
});
