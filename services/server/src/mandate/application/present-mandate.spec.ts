import { describe, expect, it, vi } from 'vitest';

import { promotionEvidenceClasses } from '@devrandom/domain';
import {
  promotionMandateSchemaSaid,
  taskMandateSchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';

import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import { presentMandate, type PresentMandateDependencies } from './present-mandate.js';
import type { StoredMandatePresentation } from './presentations.js';

const ownerAid = `E${'a'.repeat(43)}`;
const userCredentialSaid = `E${'b'.repeat(43)}`;
const credentialSaid = `E${'c'.repeat(43)}`;
const grantSaid = `E${'d'.repeat(43)}`;
const agentAid = `E${'e'.repeat(43)}`;
const registryId = `E${'f'.repeat(43)}`;
const issuerAid = `E${'g'.repeat(43)}`;
const issuerAnchor = `E${'h'.repeat(43)}`;
const attributeSaid = `E${'i'.repeat(43)}`;
const governorAid = `E${'j'.repeat(43)}`;
const promotionCredentialSaid = `E${'k'.repeat(43)}`;
const promotionAttributeSaid = `E${'l'.repeat(43)}`;
const promotionGrantSaid = `E${'m'.repeat(43)}`;
const requestedAt = '2026-09-24T12:00:00.000Z';
const expiresAt = '2026-09-24T12:30:00.000Z';
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const taskCommand = taskCommandFixture('2026-09-24T14:00:00.000Z');
const task: TaskProjection = {
  version: 1,
  taskId,
  ownerAid,
  label: taskCommand.label,
  harnessLineageId,
  revisionSaid: taskCommand.revision.d,
  revision: taskCommand.revision,
  lifecycle: { kind: 'Open' },
  commandId: taskCommand.commandId,
  createdAt: requestedAt,
  expectedVersion: 0,
};

const evidence = {
  grantSenderAid: agentAid,
  grantRecipientAid: issuerAid,
  inspection: {
    kind: 'TaskMandate' as const,
    value: {
      credential: {
        credentialSaid,
        attributeSaid,
        issuerAid: ownerAid,
        issueeAid: agentAid,
        registryId,
        schemaSaid: taskMandateSchemaSaid,
        issuedAt: requestedAt,
        credentialSaidBinding: { kind: 'Verified' as const },
        attributeSaidBinding: { kind: 'Verified' as const },
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: taskMandateSchemaSaid },
        telState: { kind: 'Issued' as const },
        issuerAnchor: { kind: 'Anchored' as const, eventSaid: issuerAnchor },
      },
      authority: 'ExecutePrivateTask' as const,
      taskId,
      taskRevisionSaid: task.revisionSaid,
      harnessLineageId,
      repository: task.revision.repository,
      allowedCapabilities: task.revision.requestedCapabilities.filter(
        (capability) => !task.revision.unavailableCapabilities.includes(capability),
      ),
      budgets: task.revision.budgets,
      allowedEvolutionClasses: task.revision.evolutionClasses,
      notBefore: requestedAt,
      expiresAt: task.revision.expiresAt,
    },
  },
};

const promotionEvidence = {
  grantSenderAid: governorAid,
  grantRecipientAid: issuerAid,
  inspection: {
    kind: 'PromotionMandate' as const,
    value: {
      credential: {
        credentialSaid: promotionCredentialSaid,
        attributeSaid: promotionAttributeSaid,
        issuerAid: ownerAid,
        issueeAid: governorAid,
        registryId,
        schemaSaid: promotionMandateSchemaSaid,
        issuedAt: requestedAt,
        credentialSaidBinding: { kind: 'Verified' as const },
        attributeSaidBinding: { kind: 'Verified' as const },
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: promotionMandateSchemaSaid },
        telState: { kind: 'Issued' as const },
        issuerAnchor: { kind: 'Anchored' as const, eventSaid: issuerAnchor },
      },
      authority: 'ActivateEvaluatedSuccessor' as const,
      taskId,
      taskRevisionSaid: task.revisionSaid,
      harnessLineageId,
      capabilityCeiling: evidence.inspection.value.allowedCapabilities,
      budgetCeiling: task.revision.budgets,
      evolutionClassCeiling: task.revision.evolutionClasses,
      requiredEvidenceClasses: promotionEvidenceClasses,
      notBefore: requestedAt,
      expiresAt: task.revision.expiresAt,
    },
  },
};

const input = {
  authority: { ownerAid, userCredentialSaid, grantExpiresAt: expiresAt },
  command: { mandateKind: 'TaskMandate' as const, credentialSaid, grantSaid },
};

function dependencies(
  overrides: Partial<PresentMandateDependencies> = {},
): PresentMandateDependencies {
  return {
    presentations: {
      reconcile: () => Promise.resolve({ kind: 'NoPresentation' }),
      create: (presentation) =>
        Promise.resolve({
          kind: 'PresentationCreated',
          stored: { revision: 0, presentation },
        }),
      commit: (_current, presentation) =>
        Promise.resolve({
          kind: 'PresentationCommitted',
          stored: { revision: 1, presentation },
        }),
      findAdmittedTaskMandates: () => Promise.resolve({ kind: 'NoAdmittedTaskMandate' }),
      findByCredential: () => Promise.resolve({ kind: 'PresentationNotFound' }),
    },
    eligibility: { verify: () => Promise.resolve({ kind: 'UserCredentialCurrent' }) },
    admission: {
      inspect: () => Promise.resolve({ kind: 'MandateAdmissionInspected', evidence }),
      begin: () =>
        Promise.resolve({ kind: 'MandateAdmissionStarted', operationName: 'operation.123' }),
      observe: () => Promise.resolve({ kind: 'MandateAdmissionPending' }),
    },
    tasks: { findById: () => Promise.resolve({ kind: 'TaskFound', task }) },
    issuerAid,
    now: () => requestedAt,
    ...overrides,
  };
}

function storedAdmitting(): StoredMandatePresentation {
  return {
    revision: 1,
    presentation: {
      version: 1,
      binding: {
        ownerAid,
        userCredentialSaid,
        mandateKind: 'TaskMandate',
        credentialSaid,
        grantSaid,
        requestedAt,
        expiresAt,
      },
      acceptedReference: null,
      state: { kind: 'Admitting', operationName: 'operation.123' },
    },
  };
}

describe('present mandate application', () => {
  it('keeps an exact not-yet-materialized IPEX grant AwaitingGrant with 202 semantics', async () => {
    const begin = vi.fn<PresentMandateDependencies['admission']['begin']>();

    const outcome = await presentMandate(
      input,
      dependencies({
        admission: {
          ...dependencies().admission,
          inspect: () => Promise.resolve({ kind: 'MandateGrantPending' }),
          begin,
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'MandatePresentationPending',
      presentation: {
        binding: { credentialSaid, grantSaid },
        state: { kind: 'AwaitingGrant' },
      },
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('persists the exact KERIA admission operation before reporting pending', async () => {
    const commit = vi.fn<PresentMandateDependencies['presentations']['commit']>(
      (_current, presentation) =>
        Promise.resolve({
          kind: 'PresentationCommitted',
          stored: { revision: 1, presentation },
        }),
    );
    const begin = vi.fn(() =>
      Promise.resolve({ kind: 'MandateAdmissionStarted' as const, operationName: 'operation.123' }),
    );

    const outcome = await presentMandate(
      input,
      dependencies({
        presentations: { ...dependencies().presentations, commit },
        admission: { ...dependencies().admission, begin },
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'MandatePresentationPending',
      presentation: {
        binding: { credentialSaid, mandateKind: 'TaskMandate' },
        state: { kind: 'Admitting', operationName: 'operation.123' },
      },
    });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 0 }),
      expect.objectContaining({ state: { kind: 'Admitting', operationName: 'operation.123' } }),
    );
    expect(begin).toHaveBeenCalledWith({
      ownerAid,
      credentialSaid,
      grantSaid,
      preparedAt: Date.parse(requestedAt),
    });
  });

  it('retries a lost admission response with the durable original preparation instant', async () => {
    const awaiting: StoredMandatePresentation = {
      revision: 0,
      presentation: {
        ...storedAdmitting().presentation,
        state: { kind: 'AwaitingGrant' },
      },
    };
    const begin = vi
      .fn<PresentMandateDependencies['admission']['begin']>()
      .mockResolvedValueOnce({ kind: 'DependencyUnavailable', dependency: 'Keria' })
      .mockResolvedValueOnce({
        kind: 'MandateAdmissionStarted',
        operationName: 'operation.recovered',
      });
    const observedTimes = ['2026-09-24T12:01:00.000Z', '2026-09-24T12:02:00.000Z'];
    const retryDependencies = dependencies({
      presentations: {
        ...dependencies().presentations,
        reconcile: () => Promise.resolve({ kind: 'ExistingPresentation', stored: awaiting }),
      },
      admission: { ...dependencies().admission, begin },
      now: () => observedTimes.shift() ?? '2026-09-24T12:03:00.000Z',
    });

    await expect(presentMandate(input, retryDependencies)).resolves.toEqual({
      kind: 'DependencyUnavailable',
      dependency: 'Keria',
    });
    await expect(presentMandate(input, retryDependencies)).resolves.toMatchObject({
      kind: 'MandatePresentationPending',
      presentation: { state: { kind: 'Admitting', operationName: 'operation.recovered' } },
    });
    expect(begin).toHaveBeenNthCalledWith(1, {
      ownerAid,
      credentialSaid,
      grantSaid,
      preparedAt: Date.parse(requestedAt),
    });
    expect(begin).toHaveBeenNthCalledWith(2, {
      ownerAid,
      credentialSaid,
      grantSaid,
      preparedAt: Date.parse(requestedAt),
    });
  });

  it('reconciles one persisted operation request-by-request into Admitted', async () => {
    const current = storedAdmitting();
    const commit = vi.fn<PresentMandateDependencies['presentations']['commit']>(
      (_stored, presentation) =>
        Promise.resolve({
          kind: 'PresentationCommitted',
          stored: { revision: 2, presentation },
        }),
    );

    const outcome = await presentMandate(
      input,
      dependencies({
        presentations: {
          ...dependencies().presentations,
          reconcile: () => Promise.resolve({ kind: 'ExistingPresentation', stored: current }),
          commit,
        },
        admission: {
          ...dependencies().admission,
          observe: () =>
            Promise.resolve({ kind: 'MandateAdmissionVerified', credentialSaid, evidence }),
        },
        now: () => '2026-09-24T12:02:00.000Z',
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'MandatePresentationAdmitted',
      presentation: {
        binding: { credentialSaid, mandateKind: 'TaskMandate' },
        state: {
          kind: 'Admitted',
          credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    });
    expect(commit).toHaveBeenCalledWith(
      current,
      expect.objectContaining({
        state: { kind: 'Admitted', credentialSaid, admittedAt: '2026-09-24T12:02:00.000Z' },
      }),
    );
  });

  it.each([
    ['holder grant sender does not match the credential issuee', 'GrantEvidenceInvalid'],
    ['ACDC issuer does not match the authenticated owner', 'CredentialBindingInvalid'],
  ] as const)('maps %s to the distinct %s rejection', async (_invalidity, reason) => {
    const outcome = await presentMandate(
      input,
      dependencies({
        admission: {
          ...dependencies().admission,
          begin: () => Promise.resolve({ kind: 'MandateAdmissionRejected', reason }),
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'MandatePresentationRejected', reason });
  });

  it('rechecks the current user credential before returning an admitted replay', async () => {
    const current = storedAdmitting();
    const admitted: StoredMandatePresentation = {
      revision: 2,
      presentation: {
        ...current.presentation,
        acceptedReference: {
          issueeAid: agentAid,
          registryId,
          taskId,
          taskRevisionSaid: task.revisionSaid,
        },
        state: {
          kind: 'Admitted',
          credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    };
    const observe = vi.fn();

    const outcome = await presentMandate(
      input,
      dependencies({
        presentations: {
          ...dependencies().presentations,
          reconcile: () => Promise.resolve({ kind: 'ExistingPresentation', stored: admitted }),
        },
        eligibility: {
          verify: () => Promise.resolve({ kind: 'UserCredentialNotCurrent' }),
        },
        admission: { ...dependencies().admission, observe },
      }),
    );

    expect(outcome).toEqual({ kind: 'UserCredentialNotCurrent' });
    expect(observe).not.toHaveBeenCalled();
  });

  it('rejects stable credential-key reuse with a different IPEX grant', async () => {
    const begin = vi.fn();
    const outcome = await presentMandate(
      input,
      dependencies({
        presentations: {
          ...dependencies().presentations,
          reconcile: () => Promise.resolve({ kind: 'PresentationConflict' }),
        },
        admission: { ...dependencies().admission, begin },
      }),
    );

    expect(outcome).toEqual({ kind: 'MandatePresentationConflict', credentialSaid });
    expect(begin).not.toHaveBeenCalled();
  });

  it('expires a pending presentation at the original Work Access Grant deadline', async () => {
    const current = storedAdmitting();
    const commit = vi.fn<PresentMandateDependencies['presentations']['commit']>(
      (_stored, presentation) =>
        Promise.resolve({
          kind: 'PresentationCommitted',
          stored: { revision: 2, presentation },
        }),
    );
    const observe = vi.fn();

    const outcome = await presentMandate(
      input,
      dependencies({
        presentations: {
          ...dependencies().presentations,
          reconcile: () => Promise.resolve({ kind: 'ExistingPresentation', stored: current }),
          commit,
        },
        admission: { ...dependencies().admission, observe },
        now: () => expiresAt,
      }),
    );

    expect(outcome).toEqual({ kind: 'MandatePresentationExpired', credentialSaid });
    expect(commit).toHaveBeenCalledWith(
      current,
      expect.objectContaining({ state: { kind: 'Expired' } }),
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    [
      'credential owner mismatch',
      {
        ...evidence,
        inspection: {
          ...evidence.inspection,
          value: {
            ...evidence.inspection.value,
            credential: {
              ...evidence.inspection.value.credential,
              issuerAid: `E${'z'.repeat(43)}`,
            },
          },
        },
      },
      'CredentialBindingInvalid',
    ],
    [
      'Task Revision mismatch',
      {
        ...evidence,
        inspection: {
          ...evidence.inspection,
          value: {
            ...evidence.inspection.value,
            taskRevisionSaid: `E${'z'.repeat(43)}`,
          },
        },
      },
      'ResourceBindingInvalid',
    ],
    [
      'unknown TEL state',
      {
        ...evidence,
        inspection: {
          ...evidence.inspection,
          value: {
            ...evidence.inspection.value,
            credential: {
              ...evidence.inspection.value.credential,
              telState: { kind: 'IncompatibleCredentialState' as const },
            },
          },
        },
      },
      'IncompatibleCredentialState',
    ],
  ])('rejects %s before asking KERIA to admit', async (_case, inspected, reason) => {
    const begin = vi.fn();

    const outcome = await presentMandate(
      input,
      dependencies({
        admission: {
          ...dependencies().admission,
          inspect: () =>
            Promise.resolve({ kind: 'MandateAdmissionInspected', evidence: inspected }),
          begin,
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'MandatePresentationRejected', reason });
    expect(begin).not.toHaveBeenCalled();
  });

  it('forbids a revoked presented mandate before asking KERIA to admit', async () => {
    const begin = vi.fn();
    const revoked = {
      ...evidence,
      inspection: {
        ...evidence.inspection,
        value: {
          ...evidence.inspection.value,
          credential: {
            ...evidence.inspection.value.credential,
            telState: { kind: 'Revoked' as const, revokedAt: requestedAt },
          },
        },
      },
    };

    const outcome = await presentMandate(
      input,
      dependencies({
        admission: {
          ...dependencies().admission,
          inspect: () => Promise.resolve({ kind: 'MandateAdmissionInspected', evidence: revoked }),
          begin,
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'MandatePresentationForbidden', reason: 'MandateRevoked' });
    expect(begin).not.toHaveBeenCalled();
  });

  it('rejects a mandate whose exact authoritative Task does not exist', async () => {
    const begin = vi.fn();

    const outcome = await presentMandate(
      input,
      dependencies({
        tasks: { findById: () => Promise.resolve({ kind: 'TaskNotFound' }) },
        admission: { ...dependencies().admission, begin },
      }),
    );

    expect(outcome).toEqual({
      kind: 'MandatePresentationRejected',
      reason: 'ResourceBindingInvalid',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('requires a freshly current admitted Task Mandate before beginning Promotion admission', async () => {
    const begin = vi.fn();
    const promotionInput = {
      ...input,
      command: {
        mandateKind: 'PromotionMandate' as const,
        credentialSaid: promotionCredentialSaid,
        grantSaid: promotionGrantSaid,
      },
    };

    const outcome = await presentMandate(
      promotionInput,
      dependencies({
        admission: {
          ...dependencies().admission,
          inspect: () =>
            Promise.resolve({ kind: 'MandateAdmissionInspected', evidence: promotionEvidence }),
          begin,
        },
      }),
    );

    expect(outcome).toEqual({
      kind: 'MandatePresentationRejected',
      reason: 'AuthorityCeilingInvalid',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('rejects one principal filling both personal-agent and Governor issuee roles', async () => {
    const admittedTask: StoredMandatePresentation = {
      revision: 2,
      presentation: {
        ...storedAdmitting().presentation,
        acceptedReference: {
          issueeAid: agentAid,
          registryId,
          taskId,
          taskRevisionSaid: task.revisionSaid,
        },
        state: {
          kind: 'Admitted',
          credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    };
    const samePrincipalPromotion = {
      ...promotionEvidence,
      grantSenderAid: agentAid,
      inspection: {
        ...promotionEvidence.inspection,
        value: {
          ...promotionEvidence.inspection.value,
          credential: {
            ...promotionEvidence.inspection.value.credential,
            issueeAid: agentAid,
          },
        },
      },
    };
    const begin = vi.fn(() =>
      Promise.resolve({ kind: 'MandateAdmissionStarted' as const, operationName: 'operation.456' }),
    );

    const outcome = await presentMandate(
      {
        ...input,
        command: {
          mandateKind: 'PromotionMandate',
          credentialSaid: promotionCredentialSaid,
          grantSaid: promotionGrantSaid,
        },
      },
      dependencies({
        presentations: {
          ...dependencies().presentations,
          findAdmittedTaskMandates: () =>
            Promise.resolve({
              kind: 'AdmittedTaskMandatesFound',
              presentations: [admittedTask],
            }),
        },
        admission: {
          ...dependencies().admission,
          inspect: ({ credentialSaid: inspectedCredentialSaid }) =>
            Promise.resolve({
              kind: 'MandateAdmissionInspected',
              evidence:
                inspectedCredentialSaid === credentialSaid ? evidence : samePrincipalPromotion,
            }),
          begin,
        },
      }),
    );

    expect(outcome).toEqual({
      kind: 'MandatePresentationRejected',
      reason: 'CredentialBindingInvalid',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it.each([
    ['admits a bounded Promotion Mandate', promotionEvidence, 'MandatePresentationPending'],
    [
      'rejects a Promotion ceiling broader than the current Task Mandate',
      {
        ...promotionEvidence,
        inspection: {
          ...promotionEvidence.inspection,
          value: {
            ...promotionEvidence.inspection.value,
            capabilityCeiling: ['SubmitResult' as const],
          },
        },
      },
      'MandatePresentationRejected',
    ],
  ])('%s', async (_case, presentedPromotion, expectedKind) => {
    const admittedTask: StoredMandatePresentation = {
      revision: 2,
      presentation: {
        ...storedAdmitting().presentation,
        acceptedReference: {
          issueeAid: agentAid,
          registryId,
          taskId,
          taskRevisionSaid: task.revisionSaid,
        },
        state: {
          kind: 'Admitted',
          credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    };
    const begin = vi.fn(() =>
      Promise.resolve({ kind: 'MandateAdmissionStarted' as const, operationName: 'operation.456' }),
    );
    const promotionInput = {
      ...input,
      command: {
        mandateKind: 'PromotionMandate' as const,
        credentialSaid: promotionCredentialSaid,
        grantSaid: promotionGrantSaid,
      },
    };

    const outcome = await presentMandate(
      promotionInput,
      dependencies({
        presentations: {
          ...dependencies().presentations,
          findAdmittedTaskMandates: () =>
            Promise.resolve({
              kind: 'AdmittedTaskMandatesFound',
              presentations: [admittedTask],
            }),
        },
        admission: {
          ...dependencies().admission,
          inspect: ({ credentialSaid: inspectedCredentialSaid }) =>
            Promise.resolve({
              kind: 'MandateAdmissionInspected',
              evidence: inspectedCredentialSaid === credentialSaid ? evidence : presentedPromotion,
            }),
          begin,
        },
      }),
    );

    expect(outcome.kind).toBe(expectedKind);
    if (expectedKind === 'MandatePresentationRejected') {
      expect(outcome).toEqual({
        kind: 'MandatePresentationRejected',
        reason: 'AuthorityCeilingInvalid',
      });
      expect(begin).not.toHaveBeenCalled();
    } else {
      expect(begin).toHaveBeenCalledOnce();
    }
  });
});
