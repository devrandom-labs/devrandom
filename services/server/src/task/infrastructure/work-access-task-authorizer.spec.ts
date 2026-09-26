import { describe, expect, it } from 'vitest';

import { workAccessTaskAuthorizer } from './work-access-task-authorizer.js';
import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
} from '../../access/domain/work-access.js';
import { workAccessPolicy } from '../../access/domain/work-access-policy.js';
import { taskCredentialSaid, taskOwnerAid } from '../test/task-command-fixture.js';

function grantedAttempt() {
  const awaiting = createAwaitingWorkAccessAttempt({
    attemptId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    userAid: taskOwnerAid,
    credentialSaid: taskCredentialSaid,
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
    ['CreateTask'],
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

describe('Work Access Task authorizer', () => {
  it('maps the grant binding to authenticated Task owner facts', async () => {
    const authorizer = workAccessTaskAuthorizer(
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
        scope: 'task:create',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'TaskAccessAuthorized',
      owner: { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid },
    });
  });

  it.each([
    [{ kind: 'GrantNotFound' as const }, { kind: 'TaskAccessInvalid' as const }],
    [{ kind: 'GrantExpired' as const }, { kind: 'TaskAccessExpired' as const }],
    [{ kind: 'GrantReleased' as const }, { kind: 'TaskAccessReleased' as const }],
    [
      { kind: 'GrantRevoked' as const, reason: 'SecurityIncident' as const },
      { kind: 'TaskAccessRevoked' as const, reason: 'SecurityIncident' as const },
    ],
    [{ kind: 'GrantScopeRejected' as const }, { kind: 'TaskAccessScopeRejected' as const }],
    [
      { kind: 'GrantAuthorizationConflict' as const },
      { kind: 'TaskAccessConcurrentUpdate' as const },
    ],
    [{ kind: 'GrantExhausted' as const }, { kind: 'TaskAccessExhausted' as const }],
  ])('maps %j without erasing its grant disposition', async (grant, expected) => {
    const authorizer = workAccessTaskAuthorizer(attempts(grant));
    await expect(
      authorizer.authorize({
        bearerSecret: 's'.repeat(43),
        scope: 'task:read',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    ).resolves.toEqual(expected);
  });

  it('keeps authorization storage failure distinct from an invalid grant', async () => {
    const unavailable = attempts({ kind: 'GrantNotFound' });
    unavailable.authorizeGrant = () => Promise.reject(new Error('MongoDB unavailable'));
    const authorizer = workAccessTaskAuthorizer(unavailable);

    await expect(
      authorizer.authorize({
        bearerSecret: 's'.repeat(43),
        scope: 'task:read',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'TaskAccessUnavailable',
      dependency: 'HostedMongoDB',
    });
  });
});
