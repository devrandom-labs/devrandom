import { describe, expect, it, vi } from 'vitest';

import { promotionEvidenceClasses, verifyTaskMandate } from '@devrandom/domain';
import {
  promotionMandateSchemaSaid,
  taskMandateSchemaSaid,
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
