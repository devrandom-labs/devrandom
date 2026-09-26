import { createHash } from 'node:crypto';

import {
  challengeResponseSaid,
  IdentityFailure,
  issuerAid,
  issuerOobi,
  userAid,
  type IssuerChallengeVerification,
  type IssuerChallengeProof,
} from '@devrandom/identity';
import { describe, expect, it, vi } from 'vitest';

import type { RegistrationSession } from '../domain/registration-session.js';
import {
  RegistrationEnrollment,
  type RegistrationEnrollmentFailure,
  type RegistrationSessions,
  type RegistrationSnapshot,
} from './registration-enrollment.js';

const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const response = challengeResponseSaid('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao');
const createdAt = Date.parse('2026-09-24T12:00:00.000Z');
const cliCapability = `cli_${'c'.repeat(43)}`;
const browserCapability = `browser_${'b'.repeat(43)}`;
const creationKey = `registration_${'r'.repeat(43)}`;

function capabilityHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class MemoryRegistrationSessions implements RegistrationSessions {
  #snapshot: RegistrationSnapshot | undefined;
  #creationKeyHash: string | undefined;

  create(session: RegistrationSession, creationKeyHash: string) {
    if (this.#snapshot !== undefined && this.#creationKeyHash === creationKeyHash) {
      return Promise.resolve({
        kind: 'registration-already-created',
        ...this.#snapshot,
      } as const);
    }
    this.#snapshot = { revision: 0, session };
    this.#creationKeyHash = creationKeyHash;
    return Promise.resolve({ kind: 'registration-created', ...this.#snapshot } as const);
  }

  retrieveByCreationKeyHash(creationKeyHash: string): Promise<RegistrationSnapshot | undefined> {
    return Promise.resolve(this.#creationKeyHash === creationKeyHash ? this.#snapshot : undefined);
  }

  retrieve(registrationId: string, observedAt: number): Promise<RegistrationSnapshot | undefined> {
    if (this.#snapshot?.session.binding.registrationId !== registrationId) {
      return Promise.resolve(undefined);
    }
    if (
      this.#snapshot.session.kind !== 'issued' &&
      this.#snapshot.session.kind !== 'rejected' &&
      this.#snapshot.session.kind !== 'expired' &&
      observedAt >= this.#snapshot.session.binding.expiresAt
    ) {
      this.#snapshot = {
        revision: this.#snapshot.revision + 1,
        session: {
          kind: 'expired',
          binding: this.#snapshot.session.binding,
          expiredAt: this.#snapshot.session.binding.expiresAt,
        },
      };
    }
    return Promise.resolve(this.#snapshot);
  }

  commit(current: RegistrationSnapshot, next: RegistrationSession) {
    if (this.#snapshot?.revision !== current.revision) {
      return Promise.resolve({ kind: 'registration-concurrently-modified' } as const);
    }
    this.#snapshot = { revision: current.revision + 1, session: next };
    return Promise.resolve({ kind: 'registration-committed', snapshot: this.#snapshot } as const);
  }
}

function enrollment(now: () => number = () => createdAt) {
  const sessions = new MemoryRegistrationSessions();
  const challengeCreation = vi.fn(() => Promise.resolve(['amber', 'cabin', 'delta']));
  const challengeVerification = vi.fn((input: IssuerChallengeVerification) =>
    Promise.resolve({ responseSaid: input.responseSaid }),
  );
  const challenge: IssuerChallengeProof = {
    createChallenge: challengeCreation,
    verifyResponse: challengeVerification,
  };
  const resolveUserOobi = vi.fn(() => Promise.resolve());
  const subject = new RegistrationEnrollment(
    {
      issuerAid: issuer,
      issuerOobi: issuerOobi(`http://issuer.test/oobi/${issuer}/agent/EAgent`),
      registrationSiteUrl: 'http://127.0.0.1:3210',
      lifetimeMs: 60_000,
      pollIntervalMs: 1_000,
      challengeOperationTimeoutMs: 30_000,
    },
    {
      sessions,
      challenge,
      resolveUserOobi,
      now,
      createRegistrationId: () => 'a'.repeat(32),
      issueCapabilities: () => ({
        cli: { value: cliCapability, hash: capabilityHash(cliCapability) },
        browser: { value: browserCapability, hash: capabilityHash(browserCapability) },
      }),
    },
  );
  return {
    subject,
    sessions,
    challengeCreation,
    challengeVerification,
    resolveUserOobi,
  };
}

describe('Registration enrollment', () => {
  it('creates one exact session after resolving the user OOBI and returns separated secrets', async () => {
    const { subject, sessions, resolveUserOobi } = enrollment();
    const userAgentOobi = `http://keria.test/oobi/${user}/agent/EAgent`;

    const creation = await subject.create(
      { protocolVersion: 1, userAid: user, userAgentOobi },
      creationKey,
    );
    const created = creation.response;

    expect(creation.kind).toBe('registration-created');
    expect(resolveUserOobi).toHaveBeenCalledWith({ userAid: user, userAgentOobi });
    expect(created).toEqual({
      registrationId: 'a'.repeat(32),
      cliCapability,
      browserUrl: `http://127.0.0.1:3210/#/registration/${'a'.repeat(32)}?capability=${browserCapability}`,
      challengeWords: ['amber', 'cabin', 'delta'],
      issuerAid: issuer,
      issuerOobi: `http://issuer.test/oobi/${issuer}/agent/EAgent`,
      expiresAt: '2026-09-24T12:01:00.000Z',
      pollIntervalMs: 1_000,
    });
    await expect(sessions.retrieve('a'.repeat(32), createdAt)).resolves.toMatchObject({
      revision: 0,
      session: {
        kind: 'pending-proof',
        binding: {
          cliCapabilityHash: capabilityHash(cliCapability),
          browserCapabilityHash: capabilityHash(browserCapability),
        },
      },
    });
  });

  it('returns the exact original session for an equivalent creation retry', async () => {
    const { subject, challengeCreation, resolveUserOobi } = enrollment();
    const request = {
      protocolVersion: 1 as const,
      userAid: user,
      userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
    };

    const first = await subject.create(request, creationKey);
    const retry = await subject.create(request, creationKey);

    expect(retry).toEqual({ kind: 'registration-replayed', response: first.response });
    expect(challengeCreation).toHaveBeenCalledTimes(1);
    expect(resolveUserOobi).toHaveBeenCalledTimes(1);
  });

  it('fails a conflicting creation retry closed before resolving another OOBI', async () => {
    const { subject, resolveUserOobi } = enrollment();
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    await expect(
      subject.create(
        {
          protocolVersion: 1,
          userAid: user,
          userAgentOobi: `http://keria.test/oobi/${user}/agent/EDifferentAgent`,
        },
        creationKey,
      ),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'registration-conflict' },
    });
    expect(resolveUserOobi).toHaveBeenCalledTimes(1);
  });

  it('verifies exact Signify proof before consuming its response SAID', async () => {
    const { subject, challengeVerification } = enrollment(() => createdAt + 1_000);
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    const proved = await subject.submitAidProof('a'.repeat(32), cliCapability, {
      responseSaid: response,
    });

    expect(challengeVerification).toHaveBeenCalledWith({
      sourceAid: user,
      challengeWords: ['amber', 'cabin', 'delta'],
      responseSaid: response,
      operationTimeoutMs: 30_000,
    });
    expect(proved.session).toMatchObject({
      kind: 'pending-approval',
      proof: { responseSaid: response },
    });
  });

  it('authoritatively rejects invalid email and wrong-purpose capabilities', async () => {
    const { subject } = enrollment(() => createdAt + 1_000);
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    await expect(
      subject.approve('a'.repeat(32), browserCapability, {
        contactEmail: 'not-an-email',
      }),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'request-invalid' },
    });
    await expect(
      subject.approve('a'.repeat(32), `cli_${'c'.repeat(43)}`, {
        contactEmail: 'User+Demo@example.com',
      }),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'registration-unavailable' },
    });
  });

  it('records early approval without authorizing issuance and makes its retry idempotent', async () => {
    const { subject } = enrollment(() => createdAt + 1_000);
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    const first = await subject.approve('a'.repeat(32), browserCapability, {
      contactEmail: 'User+Demo@example.com',
    });
    const retry = await subject.approve('a'.repeat(32), browserCapability, {
      contactEmail: 'User+Demo@example.com',
    });

    expect(first.session).toMatchObject({
      kind: 'pending-proof',
      approval: { kind: 'approval-recorded', contactEmail: 'User+Demo@example.com' },
    });
    expect(retry.session).toEqual(first.session);
  });

  it('commits a proved browser approval as the exact durable approval product', async () => {
    const { subject } = enrollment(() => createdAt + 1_000);
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );
    await subject.submitAidProof('a'.repeat(32), cliCapability, {
      responseSaid: response,
    });

    const approved = await subject.approve('a'.repeat(32), browserCapability, {
      contactEmail: 'User+Demo@example.com',
    });

    expect(approved.session).toMatchObject({ kind: 'approved' });
    if (approved.session.kind !== 'approved') {
      throw new Error('proved Registration Session was not approved');
    }
    expect(approved.session.approval).toEqual({
      contactEmail: 'User+Demo@example.com',
      approvedAt: createdAt + 1_000,
    });
  });

  it('fails expired actions closed before proof verification', async () => {
    let clockReads = 0;
    const { subject, challengeVerification } = enrollment(() => {
      clockReads += 1;
      return clockReads === 1 ? createdAt : createdAt + 60_000;
    });
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    await expect(
      subject.submitAidProof('a'.repeat(32), cliCapability, {
        responseSaid: response,
      }),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'registration-expired' },
    });
    expect(challengeVerification).not.toHaveBeenCalled();
  });

  it('expires a proof whose Signify verification completes at the session deadline', async () => {
    const instants = [createdAt, createdAt + 59_000, createdAt + 60_000];
    const { subject, sessions, challengeVerification } = enrollment(() => {
      const instant = instants.shift();
      if (instant === undefined) {
        throw new Error('clock was read more often than expected');
      }
      return instant;
    });
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );

    await expect(
      subject.submitAidProof('a'.repeat(32), cliCapability, { responseSaid: response }),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'registration-expired' },
    });
    expect(challengeVerification).toHaveBeenCalledOnce();
    await expect(sessions.retrieve('a'.repeat(32), createdAt + 60_000)).resolves.toMatchObject({
      session: { kind: 'expired' },
    });
  });

  it('durably rejects a Signify proof mismatch with a typed proof outcome', async () => {
    const { subject, sessions, challengeVerification } = enrollment(() => createdAt + 1_000);
    await subject.create(
      {
        protocolVersion: 1,
        userAid: user,
        userAgentOobi: `http://keria.test/oobi/${user}/agent/EAgent`,
      },
      creationKey,
    );
    challengeVerification.mockRejectedValue(
      new IdentityFailure({
        kind: 'challenge-response-invalid',
        reason: 'source AID did not match',
      }),
    );

    await expect(
      subject.submitAidProof('a'.repeat(32), cliCapability, { responseSaid: response }),
    ).rejects.toMatchObject<Partial<RegistrationEnrollmentFailure>>({
      detail: { kind: 'aid-proof-rejected' },
    });
    await expect(sessions.retrieve('a'.repeat(32), createdAt + 1_000)).resolves.toMatchObject({
      session: { kind: 'rejected', rejection: { kind: 'proof-rejected' } },
    });
  });
});
