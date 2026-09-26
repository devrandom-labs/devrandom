import { describe, expect, it } from 'vitest';

import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
} from '../../access/domain/work-access.js';
import { workAccessPolicy } from '../../access/domain/work-access-policy.js';
import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import { runFixture } from '../test/run-fixture.js';
import { workAccessRunAuthorizer } from './work-access-run-authorizer.js';

const credentialSaid = `E${'w'.repeat(43)}`;

function grantedAttempt() {
  const run = runFixture();
  const awaiting = createAwaitingWorkAccessAttempt({
    attemptId: '11111111-1111-4111-8111-111111111111',
    commandId: '22222222-2222-4222-8222-222222222222',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    userAid: run.binding.ownerAid,
    credentialSaid,
    issuerRecipientAid: `E${'c'.repeat(43)}`,
    grantSecretHash: `sha256:${'d'.repeat(64)}`,
    challengeWords: Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`),
    createdAt: '2026-09-24T19:55:00.000Z',
    expiresAt: '2026-09-24T20:00:00.000Z',
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
    ['RunPrivateTask'],
    '2026-09-24T19:56:00.000Z',
    '2026-09-24T20:26:00.000Z',
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

describe('Work Access Run authorizer', () => {
  it('maps an authorized grant to the authenticated Run owner facts', async () => {
    const authorizer = workAccessRunAuthorizer(
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
        scope: 'run:create',
        observedAt: '2026-09-24T20:00:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'RunAccessAuthorized',
      owner: { ownerAid: runFixture().binding.ownerAid, credentialSaid },
    });
  });

  it('keeps storage failure distinct from an invalid capability', async () => {
    const unavailable = attempts({ kind: 'GrantNotFound' });
    unavailable.authorizeGrant = () => Promise.reject(new Error('MongoDB unavailable'));

    await expect(
      workAccessRunAuthorizer(unavailable).authorize({
        bearerSecret: 's'.repeat(43),
        scope: 'run:execute',
        observedAt: '2026-09-24T20:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'RunAccessUnavailable', dependency: 'HostedMongoDB' });
  });
});
