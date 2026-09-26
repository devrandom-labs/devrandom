import { describe, expect, it, vi } from 'vitest';

import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  verifyTaskMandate,
} from '@devrandom/domain';
import {
  prepareTaskCommandV2,
  promotionMandateSchemaSaid,
  promotionMandateV3SchemaSaid,
  taskEvaluationBudgetCeilings,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';

import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import {
  authorizeCurrentPromotionMandate,
  type CurrentPromotionMandateDependencies,
} from './current-promotion-mandate.js';
import type { StoredMandatePresentation } from './presentations.js';

const value = (character: string) => `E${character.repeat(43)}`;
const ownerAid = value('a');
const taskMandateSaid = value('b');
const personalAgentAid = value('c');
const promotionMandateSaid = value('d');
const governorAid = value('e');
const issuerAid = value('f');
const registryId = value('g');
const promotionGrantSaid = value('h');
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const observedAt = '2026-09-24T12:30:00.000Z';
const issuedAt = '2026-09-24T12:00:00.000Z';
const command = taskCommandFixture('2026-09-24T14:00:00.000Z');
const task: TaskProjection = {
  version: 1,
  taskId,
  ownerAid,
  label: command.label,
  harnessLineageId,
  revisionSaid: command.revision.d,
  revision: command.revision,
  lifecycle: { kind: 'Open' },
  commandId: command.commandId,
  createdAt: issuedAt,
  expectedVersion: 0,
};

const taskMandateEvidence = {
  credential: {
    credentialSaid: taskMandateSaid,
    attributeSaid: value('i'),
    issuerAid: ownerAid,
    issueeAid: personalAgentAid,
    registryId,
    schemaSaid: taskMandateSchemaSaid,
    issuedAt,
    credentialSaidBinding: { kind: 'Verified' as const },
    attributeSaidBinding: { kind: 'Verified' as const },
    schemaDocument: { kind: 'Resolved' as const, schemaSaid: taskMandateSchemaSaid },
    telState: { kind: 'Issued' as const },
    issuerAnchor: { kind: 'Anchored' as const, eventSaid: value('j') },
  },
  authority: 'ExecutePrivateTask' as const,
  taskId,
  taskRevisionSaid: task.revisionSaid,
  harnessLineageId,
  repository: task.revision.repository,
  allowedCapabilities: task.revision.requestedCapabilities,
  budgets: task.revision.budgets,
  allowedEvolutionClasses: task.revision.evolutionClasses,
  notBefore: issuedAt,
  expiresAt: task.revision.expiresAt,
};

const taskMandateVerification = verifyTaskMandate(
  {
    credential: {
      issuerAid: ownerAid,
      issueeAid: personalAgentAid,
      registryId,
      schemaSaid: taskMandateSchemaSaid,
      credentialSaid: taskMandateSaid,
    },
    task: {
      taskId,
      ownerAid,
      revisionSaid: task.revisionSaid,
      harnessLineageId,
      repository: task.revision.repository,
      requestedCapabilities: task.revision.requestedCapabilities,
      unavailableCapabilities: task.revision.unavailableCapabilities,
      budgets: task.revision.budgets,
      evolutionClasses: task.revision.evolutionClasses,
      expiresAt: task.revision.expiresAt,
    },
    observedAt,
  },
  taskMandateEvidence,
);
if (taskMandateVerification.kind !== 'Current') {
  throw new Error('expected a current Task Mandate fixture');
}
const currentTaskMandate = taskMandateVerification.mandate;

const promotionEvidence = {
  grantSenderAid: governorAid,
  grantRecipientAid: issuerAid,
  inspection: {
    kind: 'PromotionMandate' as const,
    value: {
      credential: {
        credentialSaid: promotionMandateSaid,
        attributeSaid: value('k'),
        issuerAid: ownerAid,
        issueeAid: governorAid,
        registryId,
        schemaSaid: promotionMandateSchemaSaid,
        issuedAt,
        credentialSaidBinding: { kind: 'Verified' as const },
        attributeSaidBinding: { kind: 'Verified' as const },
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: promotionMandateSchemaSaid },
        telState: { kind: 'Issued' as const },
        issuerAnchor: { kind: 'Anchored' as const, eventSaid: value('l') },
      },
      authority: 'ActivateEvaluatedSuccessor' as const,
      taskId,
      taskRevisionSaid: task.revisionSaid,
      harnessLineageId,
      capabilityCeiling: taskMandateEvidence.allowedCapabilities,
      budgetCeiling: task.revision.budgets,
      evolutionClassCeiling: task.revision.evolutionClasses,
      requiredEvidenceClasses: promotionEvidenceClasses,
      notBefore: issuedAt,
      expiresAt: task.revision.expiresAt,
    },
  },
};

const stored: StoredMandatePresentation = {
  revision: 2,
  presentation: {
    version: 1,
    binding: {
      ownerAid,
      userCredentialSaid: value('m'),
      mandateKind: 'PromotionMandate',
      credentialSaid: promotionMandateSaid,
      grantSaid: promotionGrantSaid,
      requestedAt: issuedAt,
      expiresAt: task.revision.expiresAt,
    },
    acceptedReference: {
      issueeAid: governorAid,
      registryId,
      taskId,
      taskRevisionSaid: task.revisionSaid,
    },
    state: {
      kind: 'Admitted',
      credentialSaid: promotionMandateSaid,
      admittedAt: '2026-09-24T12:05:00.000Z',
    },
  },
};

const input = {
  ownerAid,
  taskId,
  taskRevisionSaid: task.revisionSaid,
  harnessLineageId,
  personalAgentAid,
  taskMandateSaid,
  governorAid,
  promotionMandateSaid,
  observedAt,
};

function dependencies(): CurrentPromotionMandateDependencies {
  return {
    issuerAid,
    currentTaskMandate: {
      authorize: () =>
        Promise.resolve({
          kind: 'CurrentTaskMandateAuthorized',
          task,
          mandate: currentTaskMandate,
        }),
    },
    presentations: {
      findByCredential: () => Promise.resolve({ kind: 'PresentationFound', stored }),
    },
    admission: {
      inspect: () =>
        Promise.resolve({ kind: 'MandateAdmissionInspected', evidence: promotionEvidence }),
    },
  };
}

describe('current Promotion Mandate authorization', () => {
  it('reinspects the exact v3 Governor credential for a current v2 Task', async () => {
    const experience = {
      corpusSaid: value('q'),
      repositoryResourceSaid: value('r'),
      disclosure: 'AuthorizedAnalogy' as const,
    };
    const prepared = prepareTaskCommandV2(
      {
        version: 2,
        label: command.label,
        title: task.revision.title,
        objective: task.revision.objective,
        repository: { kind: 'currentHead' },
        deliverables: [...task.revision.deliverables],
        completionConditions: [...task.revision.completionConditions],
        constraints: {
          ...task.revision.constraints,
          dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
          experience,
        },
        requestedCapabilities: [...task.revision.requestedCapabilities, 'ReadTaskMemory'],
        unavailableCapabilities: [...task.revision.unavailableCapabilities],
        budgets: { ...task.revision.budgets, ...taskEvaluationBudgetCeilings },
        expiresAt: task.revision.expiresAt,
        evolutionClasses: [...task.revision.evolutionClasses],
        checkpointExpectations: [...task.revision.checkpointExpectations],
      },
      task.commandId,
      task.revision.repository,
    );
    if (prepared.kind !== 'Prepared') throw new Error('expected v2 Task fixture');
    const currentTask = {
      ...task,
      revisionSaid: prepared.command.revision.d,
      revision: prepared.command.revision,
    };
    const v2TaskMandateEvidence = {
      ...taskMandateEvidence,
      credential: {
        ...taskMandateEvidence.credential,
        schemaSaid: taskMandateV2SchemaSaid,
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: taskMandateV2SchemaSaid },
      },
      taskRevisionSaid: currentTask.revisionSaid,
      allowedCapabilities: currentTask.revision.requestedCapabilities,
      budgets: currentTask.revision.budgets,
      allowedEvolutionClasses: currentTask.revision.evolutionClasses,
      experience,
    };
    const verifiedTaskMandate = verifyTaskMandate(
      {
        credential: {
          issuerAid: ownerAid,
          issueeAid: personalAgentAid,
          registryId,
          schemaSaid: taskMandateV2SchemaSaid,
          credentialSaid: taskMandateSaid,
        },
        task: {
          taskId,
          ownerAid,
          revisionSaid: currentTask.revisionSaid,
          harnessLineageId,
          repository: currentTask.revision.repository,
          requestedCapabilities: currentTask.revision.requestedCapabilities,
          unavailableCapabilities: currentTask.revision.unavailableCapabilities,
          budgets: currentTask.revision.budgets,
          evolutionClasses: currentTask.revision.evolutionClasses,
          expiresAt: currentTask.revision.expiresAt,
          experience,
        },
        observedAt,
      },
      v2TaskMandateEvidence,
    );
    if (verifiedTaskMandate.kind !== 'Current') throw new Error('expected current v2 mandate');
    const v3Evidence = {
      ...promotionEvidence,
      inspection: {
        ...promotionEvidence.inspection,
        value: {
          ...promotionEvidence.inspection.value,
          credential: {
            ...promotionEvidence.inspection.value.credential,
            schemaSaid: promotionMandateV3SchemaSaid,
            schemaDocument: {
              kind: 'Resolved' as const,
              schemaSaid: promotionMandateV3SchemaSaid,
            },
          },
          taskRevisionSaid: currentTask.revisionSaid,
          capabilityCeiling: v2TaskMandateEvidence.allowedCapabilities,
          budgetCeiling: currentTask.revision.budgets,
          evolutionClassCeiling: currentTask.revision.evolutionClasses,
          experience,
          evaluationManifestSaid: value('s'),
          requiredMetrics: promotionRequiredMetrics,
          requiredChecks: promotionRequiredChecks,
          riskLimit: promotionRiskLimit,
        },
      },
    };
    const outcome = await authorizeCurrentPromotionMandate(
      { ...input, taskRevisionSaid: currentTask.revisionSaid },
      {
        ...dependencies(),
        currentTaskMandate: {
          authorize: () =>
            Promise.resolve({
              kind: 'CurrentTaskMandateAuthorized',
              task: currentTask,
              mandate: verifiedTaskMandate.mandate,
            }),
        },
        presentations: {
          findByCredential: () =>
            Promise.resolve({
              kind: 'PresentationFound',
              stored: {
                ...stored,
                presentation: {
                  ...stored.presentation,
                  acceptedReference: {
                    issueeAid: governorAid,
                    registryId,
                    taskId,
                    taskRevisionSaid: currentTask.revisionSaid,
                  },
                },
              },
            }),
        },
        admission: {
          inspect: () =>
            Promise.resolve({ kind: 'MandateAdmissionInspected', evidence: v3Evidence }),
        },
      },
    );
    expect(outcome).toMatchObject({
      kind: 'CurrentPromotionMandateAuthorized',
      promotionMandate: { credential: { schemaSaid: promotionMandateV3SchemaSaid } },
    });
  });

  it('reinspects the exact Governor-held credential against the exact current Task Mandate', async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({ kind: 'MandateAdmissionInspected' as const, evidence: promotionEvidence }),
    );

    const outcome = await authorizeCurrentPromotionMandate(input, {
      ...dependencies(),
      admission: { inspect },
    });

    expect(outcome).toMatchObject({
      kind: 'CurrentPromotionMandateAuthorized',
      task: { taskId, revisionSaid: task.revisionSaid },
      taskMandate: { credential: { credentialSaid: taskMandateSaid } },
      promotionMandate: {
        kind: 'PromotionMandate',
        credential: { credentialSaid: promotionMandateSaid, issueeAid: governorAid },
      },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith({
      ownerAid,
      credentialSaid: promotionMandateSaid,
      grantSaid: promotionGrantSaid,
    });
  });

  it('fails closed when the stored admitted credential is now revoked', async () => {
    const outcome = await authorizeCurrentPromotionMandate(input, {
      ...dependencies(),
      admission: {
        inspect: () =>
          Promise.resolve({ kind: 'MandateAdmissionForbidden', reason: 'MandateRevoked' }),
      },
    });

    expect(outcome).toEqual({ kind: 'PromotionMandateRevoked' });
  });
});
