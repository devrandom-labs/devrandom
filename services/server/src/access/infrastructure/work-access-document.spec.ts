import { describe, expect, it } from 'vitest';

import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
  releaseWorkAccessGrant,
} from '../domain/work-access.js';
import { workAccessPolicy } from '../domain/work-access-policy.js';
import {
  decodeWorkAccessAttemptDocument,
  encodeWorkAccessAttemptDocument,
} from './work-access-document.js';

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

describe('Mongo Work Access document codec', () => {
  it('round-trips a closed verifying attempt with its replay and capacity metadata', () => {
    const transition = beginWorkAccessVerification(
      awaiting,
      'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'operation.challenge.verify.1',
    );
    if (transition.kind !== 'VerificationStarted') {
      throw new Error('expected verification to start');
    }
    const document = encodeWorkAccessAttemptDocument(
      { revision: 2, commandFingerprint: `sha256:${'b'.repeat(64)}`, attempt: transition.attempt },
      { kind: 'AttemptCapacity', userSlot: 1, globalSlot: 17 },
    );

    expect(decodeWorkAccessAttemptDocument(document)).toEqual({
      stored: {
        revision: 2,
        commandFingerprint: `sha256:${'b'.repeat(64)}`,
        attempt: transition.attempt,
      },
      allocation: { kind: 'AttemptCapacity', userSlot: 1, globalSlot: 17 },
    });
  });

  it('rejects indexed metadata that disagrees with the closed aggregate', () => {
    const document = encodeWorkAccessAttemptDocument(
      { revision: 0, commandFingerprint: `sha256:${'b'.repeat(64)}`, attempt: awaiting },
      { kind: 'AttemptCapacity', userSlot: 0, globalSlot: 0 },
    );

    expect(() =>
      decodeWorkAccessAttemptDocument({
        ...document,
        expiresAt: new Date('2026-09-24T17:06:00.000Z'),
      }),
    ).toThrow('indexed metadata does not match');
  });

  it('round-trips a released grant without retaining an active slot', () => {
    const verification = beginWorkAccessVerification(
      awaiting,
      'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'operation.challenge.verify.1',
    );
    if (verification.kind !== 'VerificationStarted') throw new Error('expected verification');
    const grant = grantWorkAccessAttempt(
      verification.attempt,
      ['CreateTask'],
      '2026-09-24T17:01:00.000Z',
      '2026-09-24T17:31:00.000Z',
      workAccessPolicy,
    );
    const release = releaseWorkAccessGrant(grant, '2026-09-24T17:02:00.000Z');
    if (release.kind !== 'GrantReleased') throw new Error('expected release');
    const stored = {
      revision: 3,
      commandFingerprint: `sha256:${'b'.repeat(64)}`,
      attempt: release.attempt,
    };
    const document = encodeWorkAccessAttemptDocument(stored, { kind: 'ReleasedCapacity' });

    expect(document).not.toHaveProperty('grantSlot');
    expect(decodeWorkAccessAttemptDocument(document)).toEqual({
      stored,
      allocation: { kind: 'ReleasedCapacity' },
    });
  });

  it('persists new PRD03 scopes without adding them to an older stored grant', () => {
    const verification = beginWorkAccessVerification(
      awaiting,
      'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'operation.challenge.verify.1',
    );
    if (verification.kind !== 'VerificationStarted') throw new Error('expected verification');
    const grant = grantWorkAccessAttempt(
      verification.attempt,
      ['CreateAgent', 'CreateTask', 'RunPrivateTask', 'PublishHarness', 'ReceiveTaskResults'],
      '2026-09-24T17:01:00.000Z',
      '2026-09-24T17:31:00.000Z',
      workAccessPolicy,
    );
    const stored = {
      revision: 3,
      commandFingerprint: `sha256:${'b'.repeat(64)}`,
      attempt: grant,
    };
    const document = encodeWorkAccessAttemptDocument(stored, {
      kind: 'GrantCapacity',
      userSlot: 0,
    });
    expect(decodeWorkAccessAttemptDocument(document).stored.attempt.state).toEqual(grant.state);
    if (document.state.kind !== 'Granted') throw new Error('expected granted document');
    expect(document.state.scopes).toContain('activation:commit');
    const olderDocument = {
      ...document,
      state: {
        ...document.state,
        scopes: ['evidence:append', 'evidence:seal', 'run:create', 'run:execute'],
      },
    };
    const older = decodeWorkAccessAttemptDocument(olderDocument).stored.attempt.state;
    if (older.kind !== 'Granted') throw new Error('expected old granted state');
    expect(older.scopes).toEqual(['evidence:append', 'evidence:seal', 'run:create', 'run:execute']);
  });
});
