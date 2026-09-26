import { describe, expect, it } from 'vitest';

import {
  admitMandatePresentation,
  awaitMandateGrant,
  expireMandatePresentation,
  recordMandateAdmission,
  rejectMandatePresentation,
} from './presentation.js';

const binding = {
  ownerAid: `E${'a'.repeat(43)}`,
  userCredentialSaid: `E${'b'.repeat(43)}`,
  mandateKind: 'TaskMandate' as const,
  credentialSaid: `E${'c'.repeat(43)}`,
  grantSaid: `E${'d'.repeat(43)}`,
  requestedAt: '2026-09-24T12:00:00.000Z',
  expiresAt: '2026-09-24T12:30:00.000Z',
};

const acceptedReference = {
  issueeAid: `E${'e'.repeat(43)}`,
  registryId: `E${'f'.repeat(43)}`,
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: `E${'g'.repeat(43)}`,
};

describe('Mandate Presentation', () => {
  it('opens one grant-bound presentation and persists operation identity before pending', () => {
    const opened = awaitMandateGrant(binding);
    expect(opened).toEqual({
      kind: 'PresentationOpened',
      presentation: {
        version: 1,
        binding,
        acceptedReference: null,
        state: { kind: 'AwaitingGrant' },
      },
    });
    if (opened.kind !== 'PresentationOpened') {
      return;
    }

    expect(
      recordMandateAdmission(opened.presentation, {
        operationName: 'operation.123',
        observedAt: '2026-09-24T12:01:00.000Z',
      }),
    ).toEqual({
      kind: 'PresentationTransitioned',
      presentation: {
        ...opened.presentation,
        state: { kind: 'Admitting', operationName: 'operation.123' },
      },
    });
  });

  it('admits only the exact bound credential before the original grant deadline', () => {
    const opened = awaitMandateGrant(binding);
    if (opened.kind !== 'PresentationOpened') {
      return;
    }
    const admitting = recordMandateAdmission(opened.presentation, {
      operationName: 'operation.123',
      observedAt: '2026-09-24T12:01:00.000Z',
    });
    if (admitting.kind !== 'PresentationTransitioned') {
      return;
    }

    expect(
      admitMandatePresentation(admitting.presentation, {
        credentialSaid: binding.credentialSaid,
        admittedAt: '2026-09-24T12:02:00.000Z',
        acceptedReference,
      }),
    ).toEqual({
      kind: 'PresentationTransitioned',
      presentation: {
        ...admitting.presentation,
        acceptedReference,
        state: {
          kind: 'Admitted',
          credentialSaid: binding.credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    });
    expect(
      admitMandatePresentation(admitting.presentation, {
        credentialSaid: `E${'e'.repeat(43)}`,
        admittedAt: '2026-09-24T12:02:00.000Z',
        acceptedReference,
      }),
    ).toEqual({ kind: 'PresentationTransitionRejected', reason: 'CredentialConflict' });
    expect(
      admitMandatePresentation(admitting.presentation, {
        credentialSaid: binding.credentialSaid,
        admittedAt: binding.expiresAt,
        acceptedReference,
      }),
    ).toEqual({ kind: 'PresentationTransitionRejected', reason: 'PresentationExpired' });
  });

  it('retains closed rejected and expired terminal alternatives', () => {
    const opened = awaitMandateGrant(binding);
    if (opened.kind !== 'PresentationOpened') {
      return;
    }

    expect(
      rejectMandatePresentation(opened.presentation, {
        reason: 'GrantEvidenceInvalid',
        observedAt: '2026-09-24T12:01:00.000Z',
      }),
    ).toEqual({
      kind: 'PresentationTransitioned',
      presentation: {
        ...opened.presentation,
        state: { kind: 'Rejected', reason: 'GrantEvidenceInvalid' },
      },
    });
    expect(expireMandatePresentation(opened.presentation, binding.expiresAt)).toEqual({
      kind: 'PresentationTransitioned',
      presentation: { ...opened.presentation, state: { kind: 'Expired' } },
    });
  });

  it('rejects invalid time bindings and illegal lifecycle transitions', () => {
    expect(awaitMandateGrant({ ...binding, expiresAt: binding.requestedAt })).toEqual({
      kind: 'PresentationOpeningRejected',
      reason: 'DeadlineInvalid',
    });
    const opened = awaitMandateGrant(binding);
    if (opened.kind !== 'PresentationOpened') {
      return;
    }

    expect(
      recordMandateAdmission(opened.presentation, {
        operationName: '',
        observedAt: '2026-09-24T12:01:00.000Z',
      }),
    ).toEqual({ kind: 'PresentationTransitionRejected', reason: 'OperationInvalid' });
    expect(expireMandatePresentation(opened.presentation, '2026-09-24T12:29:59.999Z')).toEqual({
      kind: 'PresentationTransitionRejected',
      reason: 'PresentationActive',
    });
  });
});
