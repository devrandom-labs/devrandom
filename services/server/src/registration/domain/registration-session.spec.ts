import { describe, expect, it } from 'vitest';

import {
  approveRegistration,
  beginIssuance,
  completeIssuance,
  createRegistrationSession,
  observeRegistrationSession,
  recordCredentialSubmission,
  recordCredentialVerification,
  recordGrantPreparation,
  recordGrantSubmission,
  rejectRegistration,
  RegistrationSessionFailure,
  submitAidProof,
  type AidProof,
  type RegistrationSession,
} from './registration-session.js';

const createdAt = 1_000;
const expiresAt = 2_000;

const creation = {
  registrationId: 'registration-1',
  protocolVersion: '1',
  userAid: 'EUser',
  userAgentOobi: 'http://keria.example/oobi/EUser/agent/EAgent',
  issuerAid: 'EIssuer',
  challengeWords: ['amber', 'cabin', 'delta'],
  cliCapabilityHash: 'cli-hash',
  browserCapabilityHash: 'browser-hash',
  createdAt,
  expiresAt,
};

const proof: AidProof = {
  registrationId: creation.registrationId,
  sourceAid: creation.userAid,
  recipientAid: creation.issuerAid,
  challengeWords: creation.challengeWords,
  responseSaid: 'EResponse',
  acceptedAt: 1_100,
};

function approvedSession(): RegistrationSession {
  return approveRegistration(submitAidProof(createRegistrationSession(creation), proof), {
    contactEmail: 'User+Demo@example.com',
    approvedAt: 1_200,
  });
}

function credentialVerifiedSession(): RegistrationSession {
  const issuing = beginIssuance(approvedSession(), { issuedAt: 1_300 });
  const submitted = recordCredentialSubmission(issuing, {
    credentialSaid: 'ECredential',
    operationName: 'credential-operation',
    recordedAt: 1_400,
  });
  return recordCredentialVerification(submitted, {
    credentialSaid: 'ECredential',
    verifiedAt: 1_500,
  });
}

describe('Registration Session', () => {
  it('moves through proof, approval, explicit issuance progress, and issuance', () => {
    const pendingProof = createRegistrationSession(creation);
    expect(pendingProof).toMatchObject({
      kind: 'pending-proof',
      approval: { kind: 'awaiting-approval' },
    });

    const pendingApproval = submitAidProof(pendingProof, proof);
    expect(pendingApproval).toMatchObject({
      kind: 'pending-approval',
      proof: { responseSaid: 'EResponse' },
    });

    const approved = approveRegistration(pendingApproval, {
      contactEmail: 'User+Demo@example.com',
      approvedAt: 1_200,
    });
    expect(approved).toMatchObject({
      kind: 'approved',
      approval: { contactEmail: 'User+Demo@example.com' },
    });

    const prepared = beginIssuance(approved, { issuedAt: 1_300 });
    expect(prepared).toMatchObject({
      kind: 'issuing',
      progress: { kind: 'prepared', issuedAt: 1_300 },
    });

    const credentialSubmitted = recordCredentialSubmission(prepared, {
      credentialSaid: 'ECredential',
      operationName: 'credential-operation',
      recordedAt: 1_400,
    });
    expect(credentialSubmitted).toMatchObject({
      kind: 'issuing',
      progress: {
        kind: 'credential-submitted',
        credentialSaid: 'ECredential',
        operationName: 'credential-operation',
      },
    });

    const credentialVerified = recordCredentialVerification(credentialSubmitted, {
      credentialSaid: 'ECredential',
      verifiedAt: 1_500,
    });
    const grantPrepared = recordGrantPreparation(credentialVerified, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      preparedAt: 1_600,
    });
    const grantSubmitted = recordGrantSubmission(grantPrepared, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      operationName: 'grant-operation',
      recordedAt: 1_700,
    });
    const issued = completeIssuance(grantSubmitted, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      completedAt: 1_800,
    });

    expect(issued).toMatchObject({
      kind: 'issued',
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      issuedAt: 1_300,
      completedAt: 1_800,
    });
  });

  it('records early browser approval but cannot issue until the exact AID proof arrives', () => {
    const pendingProof = approveRegistration(createRegistrationSession(creation), {
      contactEmail: 'user@example.com',
      approvedAt: 1_100,
    });

    expect(pendingProof).toMatchObject({
      kind: 'pending-proof',
      approval: { kind: 'approval-recorded', contactEmail: 'user@example.com' },
    });
    expect(() => beginIssuance(pendingProof, { issuedAt: 1_200 })).toThrow(
      RegistrationSessionFailure,
    );

    expect(submitAidProof(pendingProof, { ...proof, acceptedAt: 1_200 })).toMatchObject({
      kind: 'approved',
      proof: { responseSaid: proof.responseSaid },
      approval: { contactEmail: 'user@example.com' },
    });
  });

  it.each([
    ['registrationId', { registrationId: 'registration-2' }],
    ['sourceAid', { sourceAid: 'EAnotherUser' }],
    ['recipientAid', { recipientAid: 'EAnotherIssuer' }],
    ['challengeWords', { challengeWords: ['wrong', 'challenge'] }],
  ])('rejects proof with a mismatched %s binding', (field, mismatch) => {
    expect(() =>
      submitAidProof(createRegistrationSession(creation), { ...proof, ...mismatch }),
    ).toThrow(
      expect.objectContaining({
        detail: { kind: 'proof-mismatch', field },
      }),
    );
  });

  it('makes equivalent proof and approval retries idempotent and rejects conflicts', () => {
    const pendingApproval = submitAidProof(createRegistrationSession(creation), proof);
    expect(submitAidProof(pendingApproval, proof)).toBe(pendingApproval);
    expect(() =>
      submitAidProof(pendingApproval, { ...proof, responseSaid: 'EOtherResponse' }),
    ).toThrow(expect.objectContaining({ detail: { kind: 'conflicting-retry', action: 'prove' } }));

    const approved = approveRegistration(pendingApproval, {
      contactEmail: 'user@example.com',
      approvedAt: 1_200,
    });
    expect(
      approveRegistration(approved, {
        contactEmail: 'user@example.com',
        approvedAt: 1_200,
      }),
    ).toBe(approved);
    expect(() =>
      approveRegistration(approved, {
        contactEmail: 'other@example.com',
        approvedAt: 1_200,
      }),
    ).toThrow(
      expect.objectContaining({ detail: { kind: 'conflicting-retry', action: 'approve' } }),
    );
  });

  it('expires active state on observation and every transition at the deadline', () => {
    const pending = createRegistrationSession(creation);
    expect(observeRegistrationSession(pending, expiresAt)).toMatchObject({
      kind: 'expired',
      expiredAt: expiresAt,
    });
    expect(submitAidProof(pending, { ...proof, acceptedAt: expiresAt })).toMatchObject({
      kind: 'expired',
    });
    expect(
      approveRegistration(submitAidProof(pending, proof), {
        contactEmail: 'user@example.com',
        approvedAt: expiresAt,
      }),
    ).toMatchObject({ kind: 'expired' });
    expect(beginIssuance(approvedSession(), { issuedAt: expiresAt })).toMatchObject({
      kind: 'expired',
    });

    const prepared = beginIssuance(approvedSession(), { issuedAt: 1_300 });
    const credentialSubmitted = recordCredentialSubmission(prepared, {
      credentialSaid: 'ECredential',
      operationName: 'credential-operation',
      recordedAt: 1_400,
    });
    const credentialVerified = recordCredentialVerification(credentialSubmitted, {
      credentialSaid: 'ECredential',
      verifiedAt: 1_500,
    });
    const grantPrepared = recordGrantPreparation(credentialVerified, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      preparedAt: 1_600,
    });
    const grantSubmitted = recordGrantSubmission(grantPrepared, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      operationName: 'grant-operation',
      recordedAt: 1_700,
    });

    const expiringTransitions: readonly [string, () => RegistrationSession][] = [
      [
        'reject',
        () =>
          rejectRegistration(pending, {
            rejection: { kind: 'browser-declined' },
            rejectedAt: expiresAt,
          }),
      ],
      [
        'credential submission',
        () =>
          recordCredentialSubmission(prepared, {
            credentialSaid: 'ECredential',
            operationName: 'credential-operation',
            recordedAt: expiresAt,
          }),
      ],
      [
        'credential verification',
        () =>
          recordCredentialVerification(credentialSubmitted, {
            credentialSaid: 'ECredential',
            verifiedAt: expiresAt,
          }),
      ],
      [
        'grant preparation',
        () =>
          recordGrantPreparation(credentialVerified, {
            credentialSaid: 'ECredential',
            grantSaid: 'EGrant',
            preparedAt: expiresAt,
          }),
      ],
      [
        'grant submission',
        () =>
          recordGrantSubmission(grantPrepared, {
            credentialSaid: 'ECredential',
            grantSaid: 'EGrant',
            operationName: 'grant-operation',
            recordedAt: expiresAt,
          }),
      ],
      [
        'issuance completion',
        () =>
          completeIssuance(grantSubmitted, {
            credentialSaid: 'ECredential',
            grantSaid: 'EGrant',
            completedAt: expiresAt,
          }),
      ],
    ];

    for (const [transition, apply] of expiringTransitions) {
      expect(apply(), transition).toMatchObject({ kind: 'expired', expiredAt: expiresAt });
    }
  });

  it('keeps terminal issued and rejected outcomes terminal after the deadline', () => {
    const rejected = rejectRegistration(createRegistrationSession(creation), {
      rejection: { kind: 'browser-declined' },
      rejectedAt: 1_100,
    });
    expect(
      rejectRegistration(rejected, {
        rejection: { kind: 'browser-declined' },
        rejectedAt: 1_100,
      }),
    ).toBe(rejected);
    expect(observeRegistrationSession(rejected, expiresAt)).toBe(rejected);

    const verified = credentialVerifiedSession();
    const prepared = recordGrantPreparation(verified, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      preparedAt: 1_600,
    });
    const submitted = recordGrantSubmission(prepared, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      operationName: 'grant-operation',
      recordedAt: 1_700,
    });
    const issued = completeIssuance(submitted, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      completedAt: 1_800,
    });
    expect(observeRegistrationSession(issued, expiresAt)).toBe(issued);
  });

  it('rejects conflicting issuance retries without losing durable progress', () => {
    const issuing = beginIssuance(approvedSession(), { issuedAt: 1_300 });
    expect(beginIssuance(issuing, { issuedAt: 1_300 })).toBe(issuing);
    expect(() => beginIssuance(issuing, { issuedAt: 1_301 })).toThrow(
      expect.objectContaining({
        detail: { kind: 'conflicting-retry', action: 'begin-issuance' },
      }),
    );

    const submitted = recordCredentialSubmission(issuing, {
      credentialSaid: 'ECredential',
      operationName: 'credential-operation',
      recordedAt: 1_400,
    });
    expect(
      recordCredentialSubmission(submitted, {
        credentialSaid: 'ECredential',
        operationName: 'credential-operation',
        recordedAt: 1_400,
      }),
    ).toBe(submitted);
    expect(() =>
      recordCredentialSubmission(submitted, {
        credentialSaid: 'EOtherCredential',
        operationName: 'credential-operation',
        recordedAt: 1_400,
      }),
    ).toThrow(
      expect.objectContaining({
        detail: { kind: 'conflicting-retry', action: 'record-credential-submission' },
      }),
    );

    const verified = recordCredentialVerification(submitted, {
      credentialSaid: 'ECredential',
      verifiedAt: 1_500,
    });
    const grantPrepared = recordGrantPreparation(verified, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      preparedAt: 1_600,
    });
    const grantSubmitted = recordGrantSubmission(grantPrepared, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      operationName: 'grant-operation',
      recordedAt: 1_700,
    });

    expect(
      recordCredentialSubmission(grantSubmitted, {
        credentialSaid: 'ECredential',
        operationName: 'credential-operation',
        recordedAt: 1_750,
      }),
    ).toBe(grantSubmitted);
    expect(
      recordCredentialVerification(grantSubmitted, {
        credentialSaid: 'ECredential',
        verifiedAt: 1_750,
      }),
    ).toBe(grantSubmitted);
    expect(
      recordGrantPreparation(grantSubmitted, {
        credentialSaid: 'ECredential',
        grantSaid: 'EGrant',
        preparedAt: 1_750,
      }),
    ).toBe(grantSubmitted);
    expect(
      recordGrantSubmission(grantSubmitted, {
        credentialSaid: 'ECredential',
        grantSaid: 'EGrant',
        operationName: 'grant-operation',
        recordedAt: 1_750,
      }),
    ).toBe(grantSubmitted);

    const issued = completeIssuance(grantSubmitted, {
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      completedAt: 1_800,
    });
    expect(
      completeIssuance(issued, {
        credentialSaid: 'ECredential',
        grantSaid: 'EGrant',
        completedAt: 1_900,
      }),
    ).toBe(issued);
    expect(() =>
      completeIssuance(issued, {
        credentialSaid: 'ECredential',
        grantSaid: 'EOtherGrant',
        completedAt: 1_900,
      }),
    ).toThrow(
      expect.objectContaining({
        detail: { kind: 'conflicting-retry', action: 'complete-issuance' },
      }),
    );
  });

  it('rejects invalid creation data and illegal transitions', () => {
    expect(() =>
      createRegistrationSession({
        ...creation,
        browserCapabilityHash: creation.cliCapabilityHash,
      }),
    ).toThrow(
      expect.objectContaining({
        detail: { kind: 'invalid-creation', reason: 'capabilities-not-separated' },
      }),
    );

    expect(() =>
      recordCredentialVerification(beginIssuance(approvedSession(), { issuedAt: 1_300 }), {
        credentialSaid: 'ECredential',
        verifiedAt: 1_400,
      }),
    ).toThrow(
      expect.objectContaining({
        detail: {
          kind: 'invalid-transition',
          action: 'record-credential-verification',
          state: 'issuing',
        },
      }),
    );
  });
});
