import { describe, expect, it } from 'vitest';

import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
} from '../../access/domain/work-access.js';
import { workAccessPolicy } from '../../access/domain/work-access-policy.js';
import { workAccessMandateAuthorizer } from './work-access-mandate-authorizer.js';

const ownerAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';

function grantedAttempt() {
  const awaiting = createAwaitingWorkAccessAttempt({
    attemptId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    userAid: ownerAid,
    credentialSaid,
    issuerRecipientAid: `E${'c'.repeat(43)}`,
    grantSecretHash: `sha256:${'d'.repeat(64)}`,
    challengeWords: Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`),
    createdAt: '2026-09-24T11:55:00.000Z',
    expiresAt: '2026-09-24T12:00:00.000Z',
  });
  const verification = beginWorkAccessVerification(
    awaiting,
    `E${'e'.repeat(43)}`,
    'operation-name',
  );
  if (verification.kind === 'ProofConflict') {
    throw new Error('Work Access fixture could not begin verification');
  }
  return grantWorkAccessAttempt(
    verification.attempt,
    ['CreateAgent', 'RunPrivateTask'],
    '2026-09-24T11:56:00.000Z',
    '2026-09-24T12:26:00.000Z',
    workAccessPolicy,
  );
}

function attempts(
  authorization: Awaited<ReturnType<WorkAccessAttempts['authorizeGrant']>>,
): WorkAccessAttempts {
  return {
    reconcileCommand: () => Promise.resolve({ kind: 'NoAttempt' }),
    create: () => Promise.resolve({ kind: 'AttemptCapacityExceeded' }),
    retrieve: () => Promise.resolve(undefined),
    retrieveAuthorized: () => Promise.resolve({ kind: 'AttemptNotFound' }),
    commit: () => Promise.resolve({ kind: 'ConcurrentlyModified' }),
    authorizeGrant: () => Promise.resolve(authorization),
    verify: () => Promise.resolve(),
  };
}

describe('Work Access mandate authorizer', () => {
  it('derives owner identity and the original grant expiry from the authorized grant', async () => {
    const authorizer = workAccessMandateAuthorizer(
      attempts({
        kind: 'GrantAuthorized',
        remainingRequests: 8,
        stored: {
          revision: 2,
          commandFingerprint: `sha256:${'a'.repeat(64)}`,
          attempt: grantedAttempt(),
        },
      }),
    );

    await expect(
      authorizer.authorize({
        bearerSecret: 's'.repeat(43),
        scope: 'run:prepare',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'MandateAccessAuthorized',
      authority: {
        ownerAid,
        userCredentialSaid: credentialSaid,
        grantExpiresAt: '2026-09-24T12:26:00.000Z',
      },
    });
  });

  it('keeps storage unavailability distinct from an invalid capability', async () => {
    const unavailable = attempts({ kind: 'GrantNotFound' });
    unavailable.authorizeGrant = () => Promise.reject(new Error('MongoDB unavailable'));

    await expect(
      workAccessMandateAuthorizer(unavailable).authorize({
        bearerSecret: 's'.repeat(43),
        scope: 'run:prepare',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'MandateAccessUnavailable',
      dependency: 'HostedMongoDB',
    });
  });
});
