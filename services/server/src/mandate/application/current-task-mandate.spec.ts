import { describe, expect, it, vi } from 'vitest';

import { taskMandateSchemaSaid, type TaskProjection } from '@devrandom/protocol';

import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import {
  authorizeCurrentTaskMandate,
  type CurrentTaskMandateDependencies,
} from './current-task-mandate.js';
import type { StoredMandatePresentation } from './presentations.js';

const ownerAid = `E${'a'.repeat(43)}`;
const userCredentialSaid = `E${'b'.repeat(43)}`;
const taskMandateSaid = `E${'c'.repeat(43)}`;
const taskMandateAttributeSaid = `E${'d'.repeat(43)}`;
const personalAgentAid = `E${'e'.repeat(43)}`;
const issuerAid = `E${'f'.repeat(43)}`;
const registryId = `E${'g'.repeat(43)}`;
const issuerAnchorSaid = `E${'h'.repeat(43)}`;
const grantSaid = `E${'i'.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const observedAt = '2026-09-24T12:30:00.000Z';
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
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0,
};

const stored: StoredMandatePresentation = {
  revision: 2,
  presentation: {
    version: 1,
    binding: {
      ownerAid,
      userCredentialSaid,
      mandateKind: 'TaskMandate',
      credentialSaid: taskMandateSaid,
      grantSaid,
      requestedAt: '2026-09-24T12:00:00.000Z',
      expiresAt: '2026-09-24T13:00:00.000Z',
    },
    acceptedReference: {
      issueeAid: personalAgentAid,
      registryId,
      taskId,
      taskRevisionSaid: task.revisionSaid,
    },
    state: {
      kind: 'Admitted',
      credentialSaid: taskMandateSaid,
      admittedAt: '2026-09-24T12:05:00.000Z',
    },
  },
};

const evidence = {
  grantSenderAid: personalAgentAid,
  grantRecipientAid: issuerAid,
  inspection: {
    kind: 'TaskMandate' as const,
    value: {
      credential: {
        credentialSaid: taskMandateSaid,
        attributeSaid: taskMandateAttributeSaid,
        issuerAid: ownerAid,
        issueeAid: personalAgentAid,
        registryId,
        schemaSaid: taskMandateSchemaSaid,
        issuedAt: '2026-09-24T12:00:00.000Z',
        credentialSaidBinding: { kind: 'Verified' as const },
        attributeSaidBinding: { kind: 'Verified' as const },
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: taskMandateSchemaSaid },
        telState: { kind: 'Issued' as const },
        issuerAnchor: { kind: 'Anchored' as const, eventSaid: issuerAnchorSaid },
      },
      authority: 'ExecutePrivateTask' as const,
      taskId,
      taskRevisionSaid: task.revisionSaid,
      harnessLineageId,
      repository: task.revision.repository,
      allowedCapabilities: task.revision.requestedCapabilities,
      budgets: task.revision.budgets,
      allowedEvolutionClasses: task.revision.evolutionClasses,
      notBefore: '2026-09-24T12:00:00.000Z',
      expiresAt: task.revision.expiresAt,
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
  observedAt,
};

function dependencies(): CurrentTaskMandateDependencies {
  return {
    issuerAid,
    tasks: { findById: () => Promise.resolve({ kind: 'TaskFound', task }) },
    presentations: {
      findByCredential: () => Promise.resolve({ kind: 'PresentationFound', stored }),
    },
    admission: {
      inspect: () => Promise.resolve({ kind: 'MandateAdmissionInspected', evidence }),
    },
  };
}

describe('current Task Mandate authorization', () => {
  it.each([
    ['2026-09-24T12:29:59.999Z', 'CurrentTaskMandateAuthorized'],
    ['2026-09-24T12:30:00.000Z', 'TaskMandateRevoked'],
    ['2026-09-24T12:30:00.001Z', 'TaskMandateRevoked'],
  ])('checks a revoked TEL state at the effect time %s', async (effectTime, kind) => {
    const outcome = await authorizeCurrentTaskMandate(
      { ...input, observedAt: effectTime },
      {
        ...dependencies(),
        admission: {
          inspect: () =>
            Promise.resolve({
              kind: 'MandateAdmissionInspected',
              evidence: {
                ...evidence,
                inspection: {
                  ...evidence.inspection,
                  value: {
                    ...evidence.inspection.value,
                    credential: {
                      ...evidence.inspection.value.credential,
                      telState: { kind: 'Revoked', revokedAt: '2026-09-24T12:30:00.000Z' },
                    },
                  },
                },
              },
            }),
        },
      },
    );
    expect(outcome.kind).toBe(kind);
  });

  it('returns the exact current Task Mandate only after a live KERIA/TEL reinspection', async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({ kind: 'MandateAdmissionInspected' as const, evidence }),
    );

    const outcome = await authorizeCurrentTaskMandate(input, {
      ...dependencies(),
      admission: { inspect },
    });

    expect(outcome).toMatchObject({
      kind: 'CurrentTaskMandateAuthorized',
      task: { taskId, revisionSaid: task.revisionSaid, harnessLineageId },
      mandate: {
        kind: 'TaskMandate',
        credential: { credentialSaid: taskMandateSaid, issueeAid: personalAgentAid },
      },
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith({
      ownerAid,
      credentialSaid: taskMandateSaid,
      grantSaid,
    });
  });

  it('does not trust a stored Admitted state after live revocation', async () => {
    const outcome = await authorizeCurrentTaskMandate(input, {
      ...dependencies(),
      admission: {
        inspect: () =>
          Promise.resolve({ kind: 'MandateAdmissionForbidden', reason: 'MandateRevoked' }),
      },
    });

    expect(outcome).toEqual({ kind: 'TaskMandateRevoked' });
  });
});
