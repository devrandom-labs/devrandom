import { describe, expect, it } from 'vitest';

import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
  releaseWorkAccessGrant,
  reconstructWorkAccessAttempt,
} from '../domain/work-access.js';
import { workAccessPolicy } from '../domain/work-access-policy.js';
import { classifyUncommittedWorkAccessGrant } from './mongo-work-access-attempts.js';

const commandFingerprint = `sha256:${'b'.repeat(64)}`;

function activeGrant() {
  const awaiting = createAwaitingWorkAccessAttempt({
    attemptId: '11111111-1111-4111-8111-111111111111',
    commandId: '33333333-3333-4333-8333-333333333333',
    clientInstanceId: '22222222-2222-4222-8222-222222222222',
    userAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
    credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
    issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
    grantSecretHash: `sha256:${'a'.repeat(64)}`,
    challengeWords: Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`),
    createdAt: '2026-09-24T17:00:00.000Z',
    expiresAt: '2026-09-24T17:05:00.000Z',
  });
  const verification = beginWorkAccessVerification(
    awaiting,
    'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'operation.challenge.verify.1',
  );
  if (verification.kind !== 'VerificationStarted') {
    throw new Error('expected verification to start');
  }
  return {
    revision: 2,
    commandFingerprint,
    attempt: grantWorkAccessAttempt(
      verification.attempt,
      ['CreateTask'],
      '2026-09-24T17:01:00.000Z',
      '2026-09-24T17:31:00.000Z',
      workAccessPolicy,
    ),
  };
}

describe('Mongo Work Access grant classification', () => {
  it('reports an atomic authorization conflict instead of falsely claiming exhaustion', () => {
    const grant = activeGrant();

    expect(
      classifyUncommittedWorkAccessGrant(grant, 'task:read', new Date('2026-09-24T17:02:00.000Z')),
    ).toEqual({ kind: 'GrantAuthorizationConflict' });
    expect(
      classifyUncommittedWorkAccessGrant(grant, 'run:read', new Date('2026-09-24T17:02:00.000Z')),
    ).toEqual({ kind: 'GrantScopeRejected' });
  });

  it('distinguishes expired, exhausted, and revoked authority', () => {
    const grant = activeGrant();
    if (grant.attempt.state.kind !== 'Granted') {
      throw new Error('expected a granted Work Access attempt');
    }

    expect(
      classifyUncommittedWorkAccessGrant(grant, 'task:read', new Date('2026-09-24T17:31:00.000Z')),
    ).toEqual({ kind: 'GrantExpired' });

    for (const disposition of [
      { kind: 'Exhausted' } as const,
      { kind: 'Revoked', reason: 'SecurityIncident' } as const,
    ]) {
      const stored = {
        ...grant,
        attempt: reconstructWorkAccessAttempt(grant.attempt.binding, {
          ...grant.attempt.state,
          disposition,
        }),
      };
      expect(
        classifyUncommittedWorkAccessGrant(
          stored,
          'task:read',
          new Date('2026-09-24T17:02:00.000Z'),
        ),
      ).toEqual(
        disposition.kind === 'Exhausted'
          ? { kind: 'GrantExhausted' }
          : { kind: 'GrantRevoked', reason: 'SecurityIncident' },
      );
    }
  });

  it('classifies a released grant distinctly even after its former hard deadline', () => {
    const grant = activeGrant();
    const release = releaseWorkAccessGrant(grant.attempt, '2026-09-24T17:02:00.000Z');
    if (release.kind !== 'GrantReleased') throw new Error('expected release');
    expect(
      classifyUncommittedWorkAccessGrant(
        { ...grant, attempt: release.attempt },
        'task:read',
        new Date('2026-09-24T17:32:00.000Z'),
      ),
    ).toEqual({ kind: 'GrantReleased' });
  });
});
