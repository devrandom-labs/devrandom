import { issuerAid, issuerOobi, type DevrandomUserCredentialDelivery } from '@devrandom/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  approveRegistration,
  createRegistrationSession,
  submitAidProof,
} from '../domain/registration-session.js';
import {
  RegistrationEnrollment,
  type RegistrationSessions,
  type RegistrationSnapshot,
} from './registration-enrollment.js';
import { RegistrationIssuance } from './registration-issuance.js';
import { UserRegistration } from './user-registration.js';

const createdAt = Date.parse('2026-09-24T12:00:00.000Z');
const registrationId = 'a'.repeat(32);

function approvedSnapshot(): RegistrationSnapshot {
  const pending = createRegistrationSession({
    registrationId,
    protocolVersion: '1',
    userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
    userAgentOobi: 'http://keria.test/oobi/user/agent/agent',
    issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    challengeWords: ['amber', 'cabin', 'delta'],
    cliCapabilityHash: '1'.repeat(64),
    browserCapabilityHash: '2'.repeat(64),
    createdAt,
    expiresAt: createdAt + 300_000,
  });
  const proved = submitAidProof(pending, {
    registrationId,
    sourceAid: pending.binding.userAid,
    recipientAid: pending.binding.issuerAid,
    challengeWords: pending.binding.challengeWords,
    responseSaid: 'EResponse',
    acceptedAt: createdAt + 1_000,
  });
  return {
    revision: 2,
    session: approveRegistration(proved, {
      contactEmail: 'User+Demo@example.com',
      approvedAt: createdAt + 2_000,
    }),
  };
}

function enrollment(): RegistrationEnrollment {
  const sessions: RegistrationSessions = {
    create: () => Promise.reject(new Error('unexpected create')),
    retrieveByCreationKeyHash: () => Promise.reject(new Error('unexpected creation retrieval')),
    retrieve: () => Promise.reject(new Error('unexpected retrieval')),
    commit: () => Promise.reject(new Error('unexpected commit')),
  };
  return new RegistrationEnrollment(
    {
      issuerAid: issuerAid(approvedSnapshot().session.binding.issuerAid),
      issuerOobi: issuerOobi('http://issuer.test/oobi/issuer/agent/agent'),
      registrationSiteUrl: 'http://site.test',
      lifetimeMs: 300_000,
      pollIntervalMs: 1_000,
      challengeOperationTimeoutMs: 30_000,
    },
    {
      sessions,
      challenge: {
        createChallenge: () => Promise.reject(new Error('unexpected challenge')),
        verifyResponse: () => Promise.reject(new Error('unexpected verification')),
      },
      resolveUserOobi: () => Promise.reject(new Error('unexpected OOBI resolution')),
      now: () => createdAt,
      createRegistrationId: () => registrationId,
      issueCapabilities: () => ({
        cli: { value: `cli_${'c'.repeat(43)}`, hash: '1'.repeat(64) },
        browser: { value: `browser_${'b'.repeat(43)}`, hash: '2'.repeat(64) },
      }),
    },
  );
}

function issuance(sessions: RegistrationSessions): RegistrationIssuance {
  const credentialDelivery: DevrandomUserCredentialDelivery = {
    reconcileCredential: () => Promise.reject(new Error('unexpected reconciliation')),
    submitCredential: () => Promise.reject(new Error('unexpected issuance')),
    verifyCredential: () => Promise.reject(new Error('unexpected credential verification')),
    prepareGrant: () => Promise.reject(new Error('unexpected grant preparation')),
    reconcileGrant: () => Promise.reject(new Error('unexpected grant reconciliation')),
    submitGrant: () => Promise.reject(new Error('unexpected grant submission')),
    verifyGrant: () => Promise.reject(new Error('unexpected grant verification')),
  };
  return new RegistrationIssuance(
    {
      issuerAlias: 'devrandom-issuer',
      registryId: 'ERegistry',
      schemaId: 'ESchema',
      operationTimeoutMs: 30_000,
    },
    { sessions, credentialDelivery, now: () => createdAt + 3_000 },
  );
}

describe('user registration journey', () => {
  it('advances an approved browser mutation through the durable issuance capability', async () => {
    const approved = approvedSnapshot();
    const enrollmentCapability = enrollment();
    vi.spyOn(enrollmentCapability, 'approve').mockResolvedValue(approved);
    const sessions: RegistrationSessions = {
      create: () => Promise.reject(new Error('unexpected create')),
      retrieveByCreationKeyHash: () => Promise.reject(new Error('unexpected creation retrieval')),
      retrieve: () => Promise.resolve(approved),
      commit: () => Promise.reject(new Error('unexpected commit')),
    };
    const issuanceCapability = issuance(sessions);
    const issued = { ...approved, revision: approved.revision + 1 };
    const advance = vi.spyOn(issuanceCapability, 'advance').mockResolvedValue(issued);
    const subject = new UserRegistration(enrollmentCapability, issuanceCapability);

    await expect(
      subject.approve(registrationId, `browser_${'b'.repeat(43)}`, {
        contactEmail: 'User+Demo@example.com',
      }),
    ).resolves.toBe(issued);
    expect(advance).toHaveBeenCalledWith(approved);
  });

  it('resumes durable issuance through authorized CLI and browser polling', async () => {
    const approved = approvedSnapshot();
    const enrollmentCapability = enrollment();
    vi.spyOn(enrollmentCapability, 'cliSession').mockResolvedValue(approved);
    vi.spyOn(enrollmentCapability, 'browserSession').mockResolvedValue(approved);
    const sessions: RegistrationSessions = {
      create: () => Promise.reject(new Error('unexpected create')),
      retrieveByCreationKeyHash: () => Promise.reject(new Error('unexpected creation retrieval')),
      retrieve: () => Promise.resolve(approved),
      commit: () => Promise.reject(new Error('unexpected commit')),
    };
    const issuanceCapability = issuance(sessions);
    const issued = { ...approved, revision: approved.revision + 1 };
    const advance = vi.spyOn(issuanceCapability, 'advance').mockResolvedValue(issued);
    const subject = new UserRegistration(enrollmentCapability, issuanceCapability);

    await expect(subject.cliSession(registrationId, `cli_${'c'.repeat(43)}`)).resolves.toBe(issued);
    await expect(subject.browserSession(registrationId, `browser_${'b'.repeat(43)}`)).resolves.toBe(
      issued,
    );
    expect(advance).toHaveBeenNthCalledWith(1, approved);
    expect(advance).toHaveBeenNthCalledWith(2, approved);
  });
});
