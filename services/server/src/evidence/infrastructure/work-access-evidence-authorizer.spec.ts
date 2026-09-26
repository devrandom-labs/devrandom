import { describe, expect, it, vi } from 'vitest';

import {
  type GrantAuthorization,
  type WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import {
  createAwaitingWorkAccessAttempt,
  workAccessGrantSecretHash,
} from '../../access/domain/work-access.js';
import { workAccessEvidenceAuthorizer } from './work-access-evidence-authorizer.js';

const ownerAid = `E${'o'.repeat(43)}`;

const stored = {
  revision: 0,
  commandFingerprint: `sha256:${'c'.repeat(64)}`,
  attempt: createAwaitingWorkAccessAttempt({
    attemptId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    userAid: ownerAid,
    credentialSaid: `E${'c'.repeat(43)}`,
    issuerRecipientAid: `E${'i'.repeat(43)}`,
    grantSecretHash: `sha256:${'a'.repeat(64)}`,
    challengeWords: Array.from({ length: 24 }, (_, index) => `word-${String(index)}`),
    createdAt: '2026-09-24T20:00:00.000Z',
    expiresAt: '2026-09-24T20:05:00.000Z',
  }),
};

function attempts(authorizeGrant: WorkAccessAttempts['authorizeGrant']): WorkAccessAttempts {
  return {
    reconcileCommand: vi.fn().mockResolvedValue({ kind: 'NoAttempt' }),
    create: vi.fn().mockResolvedValue({ kind: 'AttemptCreated', stored }),
    retrieve: vi.fn().mockResolvedValue(undefined),
    retrieveAuthorized: vi.fn().mockResolvedValue({ kind: 'AttemptNotFound' }),
    commit: vi.fn().mockResolvedValue({ kind: 'ConcurrentlyModified' }),
    authorizeGrant,
    verify: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Work Access evidence authorization', () => {
  it('derives evidence ownership from the consumed grant rather than caller input', async () => {
    const authorization: GrantAuthorization = {
      kind: 'GrantAuthorized',
      stored,
      remainingRequests: 1999,
    };
    const authorizeGrant = vi.fn().mockResolvedValue(authorization);
    const authorizer = workAccessEvidenceAuthorizer(attempts(authorizeGrant));

    await expect(
      authorizer.authorize({
        bearerSecret: `A${'s'.repeat(42)}`,
        scope: 'evidence:seal',
        observedAt: '2026-09-24T20:01:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'EvidenceAccessAuthorized', ownerAid });
    expect(authorizeGrant).toHaveBeenCalledWith({
      grantSecretHash: workAccessGrantSecretHash(`A${'s'.repeat(42)}`),
      scope: 'evidence:seal',
      observedAt: '2026-09-24T20:01:00.000Z',
    });
  });

  it('fails closed when the durable grant store is unavailable', async () => {
    const authorizer = workAccessEvidenceAuthorizer(
      attempts(vi.fn().mockRejectedValue(new Error('offline'))),
    );

    await expect(
      authorizer.authorize({
        bearerSecret: `A${'s'.repeat(42)}`,
        scope: 'run:read',
        observedAt: '2026-09-24T20:01:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'EvidenceAccessUnavailable', dependency: 'HostedMongoDB' });
  });
});
