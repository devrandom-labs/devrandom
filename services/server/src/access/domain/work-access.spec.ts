import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
  reconstructWorkAccessAttempt,
  scopesForEligibility,
  workAccessCommandFingerprint,
  workAccessGrantSecretHash,
} from './work-access.js';
import { workAccessPolicy, workAccessPolicyFingerprint } from './work-access-policy.js';

const command = {
  commandId: '33333333-3333-4333-8333-333333333333',
  clientInstanceId: '22222222-2222-4222-8222-222222222222',
  userAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
  credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
  grantSecretHash: `sha256:${'a'.repeat(64)}`,
} as const;

const words = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

describe('Work Access domain', () => {
  it('creates one exact AwaitingProof state and fingerprints command content deterministically', () => {
    const attempt = createAwaitingWorkAccessAttempt({
      ...command,
      attemptId: '11111111-1111-4111-8111-111111111111',
      issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
      challengeWords: words,
      createdAt: '2026-09-24T17:00:00.000Z',
      expiresAt: '2026-09-24T17:05:00.000Z',
    });

    expect(attempt.state).toEqual({ kind: 'AwaitingProof', challengeWords: words });
    expect(workAccessCommandFingerprint(command)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(workAccessCommandFingerprint(command)).toBe(workAccessCommandFingerprint(command));
  });

  it('retains exact proof provenance, erases challenge words on grant, and derives closed scopes', () => {
    const awaiting = createAwaitingWorkAccessAttempt({
      ...command,
      attemptId: '11111111-1111-4111-8111-111111111111',
      issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
      challengeWords: words,
      createdAt: '2026-09-24T17:00:00.000Z',
      expiresAt: '2026-09-24T17:05:00.000Z',
    });
    const verification = beginWorkAccessVerification(
      awaiting,
      'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'operation.challenge.verify.1',
    );
    expect(verification.kind).toBe('VerificationStarted');
    if (verification.kind !== 'VerificationStarted') {
      throw new Error('expected verification to start');
    }
    const verifying = verification.attempt;
    const granted = grantWorkAccessAttempt(
      verifying,
      ['CreateAgent', 'CreateTask', 'RunPrivateTask', 'PublishHarness', 'ReceiveTaskResults'],
      '2026-09-24T17:01:00.000Z',
      '2026-09-24T17:31:00.000Z',
      workAccessPolicy,
    );

    expect(granted.state).toMatchObject({
      kind: 'Granted',
      verifiedResponseSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      policyFingerprint: workAccessPolicyFingerprint,
      disposition: { kind: 'Active', remainingRequests: 2_000 },
    });
    expect(granted.state).not.toHaveProperty('challengeWords');
    expect(scopesForEligibility(['CreateTask'])).toEqual(['task:create', 'task:read']);
    expect(scopesForEligibility(['RunPrivateTask'])).toEqual([
      'evaluation:admit',
      'evaluation:append',
      'evaluation:close',
      'evaluation:prepare',
      'evidence:append',
      'evidence:seal',
      'run:create',
      'run:execute',
    ]);
    expect(scopesForEligibility(['ReceiveTaskResults'])).toEqual([
      'evidence:read',
      'experience:retrieve',
      'run:read',
    ]);
    if (granted.state.kind !== 'Granted') {
      throw new Error('expected a granted Work Access state');
    }
    expect(granted.state.scopes).toHaveLength(14);
    const grantedState = granted.state;
    expect(() =>
      reconstructWorkAccessAttempt(granted.binding, {
        ...grantedState,
        expiresAt: '2026-09-24T17:31:00.001Z',
      }),
    ).toThrow('Work Access Grant lifetime must match policy');
  });

  it('validates and hashes exactly one 32-byte unpadded base64url bearer secret', () => {
    const secret = Buffer.alloc(32, 7).toString('base64url');
    expect(workAccessGrantSecretHash(secret)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => workAccessGrantSecretHash('too-short')).toThrow(
      'Work Access Grant secret must encode exactly 32 bytes',
    );
  });

  it('rejects authority records whose attempt or grant lifetime exceeds the exact policy', () => {
    expect(() =>
      createAwaitingWorkAccessAttempt({
        ...command,
        attemptId: '11111111-1111-4111-8111-111111111111',
        issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
        challengeWords: words,
        createdAt: '2026-09-24T17:00:00.000Z',
        expiresAt: '2026-09-24T17:05:00.001Z',
      }),
    ).toThrow('Work Access Attempt lifetime must match policy');

    expect(() =>
      reconstructWorkAccessAttempt(
        {
          ...command,
          attemptId: '11111111-1111-4111-8111-111111111111',
          issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
          createdAt: '2026-09-24T17:00:00.000Z',
          attemptExpiresAt: '2026-09-24T17:05:00.001Z',
        },
        { kind: 'AwaitingProof', challengeWords: words },
      ),
    ).toThrow('Work Access Attempt lifetime must match policy');
  });
});
