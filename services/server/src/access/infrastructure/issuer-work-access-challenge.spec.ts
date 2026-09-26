import {
  IdentityFailure,
  challengeResponseSaid,
  type AsynchronousIssuerChallengeProof,
} from '@devrandom/identity';
import { describe, expect, it, vi } from 'vitest';

import { issuerWorkAccessChallengeProof } from './issuer-work-access-challenge.js';

const user = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const issuer = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
const response = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const words = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

interface IssuerChallengeFixture {
  readonly capability: AsynchronousIssuerChallengeProof;
  readonly observeVerification: ReturnType<
    typeof vi.fn<AsynchronousIssuerChallengeProof['observeVerification']>
  >;
  readonly acknowledgeResponse: ReturnType<
    typeof vi.fn<AsynchronousIssuerChallengeProof['acknowledgeResponse']>
  >;
}

function issuerCapability(): IssuerChallengeFixture {
  const observeVerification = vi.fn<AsynchronousIssuerChallengeProof['observeVerification']>(
    (input) =>
      Promise.resolve({
        kind: 'Verified',
        responseSaid: input.responseSaid,
      }),
  );
  const acknowledgeResponse = vi.fn<AsynchronousIssuerChallengeProof['acknowledgeResponse']>(() =>
    Promise.resolve(),
  );
  return {
    capability: {
      createChallenge: () => Promise.resolve(words),
      startVerification: () => Promise.resolve({ operationName: 'challenge.operation' }),
      observeVerification,
      acknowledgeResponse,
      cleanupVerification: () => Promise.resolve(),
    },
    observeVerification,
    acknowledgeResponse,
  };
}

describe('issuer-backed Work Access challenge proof', () => {
  it('binds the captured issuer recipient and exposes acknowledgement and cleanup explicitly', async () => {
    const fixture = issuerCapability();
    const access = issuerWorkAccessChallengeProof(fixture.capability, issuer);

    await expect(
      access.observeVerification({
        attemptId: '11111111-1111-4111-8111-111111111111',
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: response,
        operationName: 'challenge.operation',
      }),
    ).resolves.toEqual({ kind: 'ChallengeVerified' });
    await expect(
      access.acknowledgeResponse({ sourceAid: user, responseSaid: response }),
    ).resolves.toEqual({ kind: 'ChallengeAcknowledged' });
    await expect(access.cleanupVerification('challenge.operation')).resolves.toEqual({
      kind: 'VerificationCleaned',
    });
    expect(fixture.acknowledgeResponse).toHaveBeenCalledExactlyOnceWith({
      sourceAid: user,
      responseSaid: challengeResponseSaid(response),
    });
  });

  it('rejects a recipient mismatch before calling the issuer capability', async () => {
    const fixture = issuerCapability();
    const access = issuerWorkAccessChallengeProof(fixture.capability, issuer);

    await expect(
      access.observeVerification({
        attemptId: '11111111-1111-4111-8111-111111111111',
        sourceAid: user,
        recipientAid: user,
        challengeWords: words,
        responseSaid: response,
        operationName: 'challenge.operation',
      }),
    ).resolves.toEqual({
      kind: 'ChallengeRejected',
      reason: 'ChallengeRecipientMismatch',
    });
    expect(fixture.observeVerification).not.toHaveBeenCalled();
  });

  it('maps proof invalidity to rejection and cleanup failure to a deferred operation', async () => {
    const capability: AsynchronousIssuerChallengeProof = {
      ...issuerCapability().capability,
      observeVerification: () =>
        Promise.resolve({
          kind: 'Rejected',
          rejection: { kind: 'InvalidProof', reason: 'ResponseEvidenceMismatch' },
        }),
      cleanupVerification: () =>
        Promise.reject(
          new IdentityFailure({
            kind: 'keria-unavailable',
            stage: 'operation cleanup',
            reason: 'offline',
          }),
        ),
    };
    const access = issuerWorkAccessChallengeProof(capability, issuer);

    await expect(
      access.observeVerification({
        attemptId: '11111111-1111-4111-8111-111111111111',
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: response,
        operationName: 'challenge.operation',
      }),
    ).resolves.toEqual({
      kind: 'ChallengeRejected',
      reason: 'ChallengeProofInvalid',
    });
    await expect(access.cleanupVerification('challenge.operation')).resolves.toEqual({
      kind: 'ChallengeCleanupDeferred',
      dependency: 'KERIA',
    });
  });
});
