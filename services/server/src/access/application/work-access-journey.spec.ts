import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkAccessAttempt,
  type CreateWorkAccessAttemptDependencies,
} from './create-work-access-attempt.js';
import { observeWorkAccessAttempt } from './observe-work-access-attempt.js';
import { releaseWorkAccessGrantCapability } from './release-work-access-grant.js';
import { submitWorkAccessProof } from './submit-work-access-proof.js';
import type {
  GrantAuthorization,
  StoredWorkAccessAttempt,
  WorkAccessAttemptCommit,
  WorkAccessAttemptCreation,
  WorkAccessAttemptLookup,
  WorkAccessAttempts,
  WorkAccessCommandReconciliation,
} from './work-access-attempts.js';
import {
  workAccessGrantSecretHash,
  type WorkAccessAttempt,
  type WorkAccessCommand,
} from '../domain/work-access.js';
import {
  workAccessPolicy,
  workAccessPolicyForGrantLifetime,
} from '../domain/work-access-policy.js';

const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
const issuerAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
const secret = Buffer.alloc(32, 7).toString('base64url');
const responseSaid = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const words = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

class MemoryWorkAccessAttempts implements WorkAccessAttempts {
  #stored: StoredWorkAccessAttempt | undefined;
  readonly #lifecycle: string[];

  constructor(lifecycle: string[] = []) {
    this.#lifecycle = lifecycle;
  }

  reconcileCommand(
    command: WorkAccessCommand,
    commandFingerprint: string,
  ): Promise<WorkAccessCommandReconciliation> {
    if (
      this.#stored === undefined ||
      this.#stored.attempt.binding.userAid !== command.userAid ||
      this.#stored.attempt.binding.clientInstanceId !== command.clientInstanceId ||
      this.#stored.attempt.binding.commandId !== command.commandId
    ) {
      return Promise.resolve({ kind: 'NoAttempt' });
    }
    return Promise.resolve(
      this.#stored.commandFingerprint === commandFingerprint
        ? { kind: 'ExistingAttempt', stored: this.#stored }
        : { kind: 'CommandConflict' },
    );
  }

  create(
    attempt: WorkAccessAttempt,
    commandFingerprint: string,
  ): Promise<WorkAccessAttemptCreation> {
    if (this.#stored !== undefined) {
      return Promise.resolve(
        this.#stored.commandFingerprint === commandFingerprint
          ? { kind: 'ExistingAttempt', stored: this.#stored }
          : { kind: 'CommandConflict' },
      );
    }
    this.#stored = { revision: 0, commandFingerprint, attempt };
    return Promise.resolve({ kind: 'AttemptCreated', stored: this.#stored });
  }

  retrieve(attemptId: string): Promise<StoredWorkAccessAttempt | undefined> {
    return Promise.resolve(
      this.#stored?.attempt.binding.attemptId === attemptId ? this.#stored : undefined,
    );
  }

  retrieveAuthorized(attemptId: string, grantSecretHash: string): Promise<WorkAccessAttemptLookup> {
    return Promise.resolve(
      this.#stored?.attempt.binding.attemptId === attemptId &&
        this.#stored.attempt.binding.grantSecretHash === grantSecretHash
        ? { kind: 'AttemptFound', stored: this.#stored }
        : { kind: 'AttemptNotFound' },
    );
  }

  commit(
    current: StoredWorkAccessAttempt,
    next: WorkAccessAttempt,
  ): Promise<WorkAccessAttemptCommit> {
    if (this.#stored?.revision !== current.revision) {
      return Promise.resolve({ kind: 'ConcurrentlyModified' });
    }
    this.#lifecycle.push(`commit:${next.state.kind}`);
    this.#stored = { ...current, revision: current.revision + 1, attempt: next };
    return Promise.resolve({ kind: 'AttemptCommitted', stored: this.#stored });
  }

  authorizeGrant(): Promise<GrantAuthorization> {
    return Promise.resolve({ kind: 'GrantNotFound' });
  }

  verify(): Promise<void> {
    return Promise.resolve();
  }
}

function dependencies(
  attempts: WorkAccessAttempts,
  lifecycle: string[] = [],
): CreateWorkAccessAttemptDependencies {
  return {
    issuerRecipientAid: issuerAid,
    policy: workAccessPolicy,
    attempts,
    credential: {
      verify: () => {
        lifecycle.push('credential');
        return Promise.resolve({
          kind: 'CurrentCredential',
          claims: [
            'CreateAgent',
            'CreateTask',
            'RunPrivateTask',
            'PublishHarness',
            'ReceiveTaskResults',
          ],
        });
      },
    },
    challenge: {
      issue: () => {
        lifecycle.push('challenge');
        return Promise.resolve({ kind: 'ChallengeIssued', words });
      },
      beginVerification: () =>
        Promise.resolve({
          kind: 'VerificationOperationStarted',
          operationName: 'operation.challenge.verify.1',
        }),
      observeVerification: () => {
        lifecycle.push('observe');
        return Promise.resolve({ kind: 'ChallengeVerified' });
      },
      acknowledgeResponse: () => {
        lifecycle.push('acknowledge');
        return Promise.resolve({ kind: 'ChallengeAcknowledged' });
      },
      cleanupVerification: () => {
        lifecycle.push('cleanup');
        return Promise.resolve({ kind: 'VerificationCleaned' });
      },
    },
    quota: {
      admit: () => {
        lifecycle.push('quota');
        return { kind: 'AttemptQuotaAdmitted' };
      },
    },
    now: () => '2026-09-24T17:00:00.000Z',
    newAttemptId: () => '11111111-1111-4111-8111-111111111111',
  };
}

const command = {
  commandId: '33333333-3333-4333-8333-333333333333',
  clientInstanceId: '22222222-2222-4222-8222-222222222222',
  userAid,
  credentialSaid,
  grantSecretHash: workAccessGrantSecretHash(secret),
  sourceAddress: '127.0.0.1',
} as const;

describe('Work Access application journey', () => {
  it.each(['verification pending', 'verification rejected', 'acknowledgement rejected'] as const)(
    'expires the exact verification operation when %s arrives after the deadline',
    async (stage) => {
      const lifecycle: string[] = [];
      const attempts = new MemoryWorkAccessAttempts(lifecycle);
      const base = dependencies(attempts, lifecycle);
      let now = '2026-09-24T17:00:00.000Z';
      const access: CreateWorkAccessAttemptDependencies = {
        ...base,
        now: () => now,
        challenge: {
          ...base.challenge,
          observeVerification: () => {
            lifecycle.push('observe');
            if (stage !== 'acknowledgement rejected') {
              now = '2026-09-24T17:05:00.001Z';
              return Promise.resolve(
                stage === 'verification pending'
                  ? { kind: 'ChallengeVerificationPending' as const }
                  : {
                      kind: 'ChallengeRejected' as const,
                      reason: 'ChallengeProofInvalid' as const,
                    },
              );
            }
            return Promise.resolve({ kind: 'ChallengeVerified' as const });
          },
          acknowledgeResponse: () => {
            lifecycle.push('acknowledge');
            now = '2026-09-24T17:05:00.001Z';
            return Promise.resolve({
              kind: 'ChallengeRejected' as const,
              reason: 'ChallengeAcknowledgementRejected' as const,
            });
          },
          cleanupVerification: (operationName) => {
            lifecycle.push(`cleanup:${operationName}`);
            return Promise.resolve({ kind: 'VerificationCleaned' });
          },
        },
      };
      const input = {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      };
      await createWorkAccessAttempt(command, access);
      await submitWorkAccessProof({ ...input, responseSaid }, access);
      lifecycle.length = 0;
      now = '2026-09-24T17:04:59.999Z';

      await expect(observeWorkAccessAttempt(input, access)).resolves.toEqual({
        kind: 'AttemptExpired',
      });
      expect((await attempts.retrieve(input.attemptId))?.attempt.state).toEqual({
        kind: 'Expired',
        expiredAt: '2026-09-24T17:05:00.001Z',
      });
      expect(lifecycle).toEqual([
        'observe',
        ...(stage === 'acknowledgement rejected' ? ['acknowledge'] : []),
        'commit:Expired',
        'cleanup:operation.challenge.verify.1',
      ]);
    },
  );

  it.each([
    ['verification', 'ChallengeProofInvalid'],
    ['acknowledgement', 'ChallengeAcknowledgementRejected'],
  ] as const)('preserves a %s rejection decided before expiry', async (stage, reason) => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const base = dependencies(attempts, lifecycle);
    let now = '2026-09-24T17:00:00.000Z';
    const access: CreateWorkAccessAttemptDependencies = {
      ...base,
      now: () => now,
      challenge: {
        ...base.challenge,
        observeVerification: () => {
          now = '2026-09-24T17:04:59.999Z';
          return Promise.resolve(
            stage === 'verification'
              ? { kind: 'ChallengeRejected' as const, reason }
              : { kind: 'ChallengeVerified' as const },
          );
        },
        acknowledgeResponse: () => Promise.resolve({ kind: 'ChallengeRejected' as const, reason }),
        cleanupVerification: (operationName) => {
          lifecycle.push(`cleanup:${operationName}`);
          return Promise.resolve({ kind: 'VerificationCleaned' });
        },
      },
    };
    const input = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      bearerSecret: secret,
    };
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof({ ...input, responseSaid }, access);
    lifecycle.length = 0;

    await expect(observeWorkAccessAttempt(input, access)).resolves.toEqual({
      kind: 'ProofRejected',
      reason,
    });
    expect((await attempts.retrieve(input.attemptId))?.attempt.state).toEqual({
      kind: 'Rejected',
      responseSaid,
      reason,
      rejectedAt: '2026-09-24T17:04:59.999Z',
    });
    expect(lifecycle).toEqual(['commit:Rejected', 'cleanup:operation.challenge.verify.1']);
  });

  it('expires a pending proof if credential verification crosses the five-minute deadline', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const base = dependencies(attempts, lifecycle);
    let now = '2026-09-24T17:00:00.000Z';
    let delayCredential = false;
    const access: CreateWorkAccessAttemptDependencies = {
      ...base,
      now: () => now,
      credential: {
        verify: async (input) => {
          const credential = await base.credential.verify(input);
          if (delayCredential) now = '2026-09-24T17:05:00.001Z';
          return credential;
        },
      },
      challenge: {
        ...base.challenge,
        cleanupVerification: (operationName) => {
          lifecycle.push(`cleanup:${operationName}`);
          return Promise.resolve({ kind: 'VerificationCleaned' });
        },
      },
    };
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof(
      { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret, responseSaid },
      access,
    );
    lifecycle.length = 0;
    now = '2026-09-24T17:04:59.999Z';
    delayCredential = true;

    await expect(
      observeWorkAccessAttempt(
        { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret },
        access,
      ),
    ).resolves.toEqual({ kind: 'AttemptExpired' });
    expect(
      (await attempts.retrieve('11111111-1111-4111-8111-111111111111'))?.attempt.state,
    ).toEqual({
      kind: 'Expired',
      expiredAt: '2026-09-24T17:05:00.001Z',
    });
    expect(lifecycle).toEqual([
      'observe',
      'acknowledge',
      'credential',
      'commit:Expired',
      'cleanup:operation.challenge.verify.1',
    ]);
  });

  it('issues a grant at the configured lower lifetime without changing its scopes or budget', async () => {
    const attempts = new MemoryWorkAccessAttempts();
    const access: CreateWorkAccessAttemptDependencies = {
      ...dependencies(attempts),
      policy: workAccessPolicyForGrantLifetime(45),
    };
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
        responseSaid,
      },
      access,
    );

    const observed = await observeWorkAccessAttempt(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      },
      access,
    );

    expect(observed).toMatchObject({
      kind: 'AttemptObserved',
      attempt: {
        kind: 'Granted',
        disposition: {
          kind: 'Active',
          expiresAt: '2026-09-24T17:00:45.000Z',
          remainingRequests: 2_000,
        },
        scopes: [
          'activation:commit',
          'evaluation:admit',
          'evaluation:append',
          'evaluation:close',
          'evaluation:prepare',
          'evaluation:renew',
          'evidence:append',
          'evidence:read',
          'evidence:seal',
          'experience:retrieve',
          'harness:publish',
          'run:create',
          'run:execute',
          'run:prepare',
          'run:read',
          'task:create',
          'task:read',
        ],
      },
    });
  });

  it('creates one attempt and reconciles an equivalent command without minting another result', async () => {
    const attempts = new MemoryWorkAccessAttempts();
    const lifecycle: string[] = [];
    const access = dependencies(attempts, lifecycle);
    const first = await createWorkAccessAttempt(command, access);
    const repeated = await createWorkAccessAttempt(command, access);

    expect(first.kind).toBe('AttemptCreated');
    expect(repeated.kind).toBe('ExistingAttempt');
    if (first.kind === 'AttemptCreated' && repeated.kind === 'ExistingAttempt') {
      expect(repeated.attempt.attemptId).toBe(first.attempt.attemptId);
      expect(repeated.attempt).toEqual(first.attempt);
    }
    expect(lifecycle).toEqual(['quota', 'credential', 'challenge']);

    const conflicting = await createWorkAccessAttempt(
      { ...command, grantSecretHash: `sha256:${'f'.repeat(64)}` },
      access,
    );
    expect(conflicting).toEqual({ kind: 'CommandConflict' });
    expect(lifecycle).toEqual(['quota', 'credential', 'challenge']);
  });

  it('persists VerifyingProof before returning pending and grants only after exact observation and credential recheck', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    const created = await createWorkAccessAttempt(command, access);
    expect(created.kind).toBe('AttemptCreated');

    const submitted = await submitWorkAccessProof(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
        responseSaid,
      },
      access,
    );
    expect(submitted.kind).toBe('ProofPending');
    const persisted = await attempts.retrieve('11111111-1111-4111-8111-111111111111');
    expect(persisted?.attempt.state).toMatchObject({
      kind: 'VerifyingProof',
      responseSaid,
      operationName: 'operation.challenge.verify.1',
    });
    lifecycle.length = 0;

    const observed = await observeWorkAccessAttempt(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      },
      { ...access, now: () => '2026-09-24T17:01:00.000Z' },
    );
    expect(observed.kind).toBe('AttemptObserved');
    if (observed.kind === 'AttemptObserved') {
      expect(observed.attempt).toMatchObject({
        kind: 'Granted',
        verifiedResponseSaid: responseSaid,
        attemptExpiresAt: '2026-09-24T17:05:00.000Z',
        disposition: {
          kind: 'Active',
          expiresAt: '2026-09-24T17:31:00.000Z',
          remainingRequests: 2_000,
        },
      });
    }
    expect(lifecycle).toEqual([
      'observe',
      'acknowledge',
      'credential',
      'commit:Granted',
      'cleanup',
    ]);
  });

  it('rejects a different proof SAID after the original proof has granted the attempt', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
        responseSaid,
      },
      access,
    );
    await observeWorkAccessAttempt(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      },
      { ...access, now: () => '2026-09-24T17:01:00.000Z' },
    );
    lifecycle.length = 0;

    await expect(
      submitWorkAccessProof(
        {
          attemptId: '11111111-1111-4111-8111-111111111111',
          bearerSecret: secret,
          responseSaid: `E${'b'.repeat(43)}`,
        },
        access,
      ),
    ).resolves.toEqual({ kind: 'ProofConflict' });
    await expect(
      submitWorkAccessProof(
        {
          attemptId: '11111111-1111-4111-8111-111111111111',
          bearerSecret: secret,
          responseSaid,
        },
        access,
      ),
    ).resolves.toMatchObject({
      kind: 'AttemptObserved',
      attempt: { kind: 'Granted', verifiedResponseSaid: responseSaid },
    });
    expect(lifecycle).toEqual([]);
  });

  it('releases only the exact grant bearer and reconciles a lost release response', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    const input = { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret };
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof({ ...input, responseSaid }, access);
    await observeWorkAccessAttempt(input, { ...access, now: () => '2026-09-24T17:01:00.000Z' });
    lifecycle.length = 0;
    const release = { ...access, now: () => '2026-09-24T17:02:00.000Z' };

    await expect(
      releaseWorkAccessGrantCapability(
        { ...input, bearerSecret: Buffer.alloc(32, 8).toString('base64url') },
        release,
      ),
    ).resolves.toEqual({ kind: 'CapabilityInvalid' });
    await expect(releaseWorkAccessGrantCapability(input, release)).resolves.toEqual({
      kind: 'GrantReleased',
    });
    await expect(releaseWorkAccessGrantCapability(input, release)).resolves.toEqual({
      kind: 'GrantReleased',
    });
    expect((await attempts.retrieve(input.attemptId))?.attempt.state).toMatchObject({
      kind: 'Granted',
      disposition: { kind: 'Released', releasedAt: '2026-09-24T17:02:00.000Z' },
    });
    expect(lifecycle).toEqual(['commit:Granted']);
  });

  it('retains expiry provenance when an exact bearer releases after its hard deadline', async () => {
    const attempts = new MemoryWorkAccessAttempts();
    const access = dependencies(attempts);
    const input = { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret };
    await createWorkAccessAttempt(command, access);
    await expect(releaseWorkAccessGrantCapability(input, access)).resolves.toEqual({
      kind: 'GrantReleaseConflict',
    });
    await submitWorkAccessProof({ ...input, responseSaid }, access);
    await observeWorkAccessAttempt(input, { ...access, now: () => '2026-09-24T17:01:00.000Z' });
    const settled = { ...access, now: () => '2026-09-24T17:31:00.000Z' };

    await expect(releaseWorkAccessGrantCapability(input, settled)).resolves.toEqual({
      kind: 'GrantReleased',
    });
    await expect(releaseWorkAccessGrantCapability(input, settled)).resolves.toEqual({
      kind: 'GrantReleased',
    });
    expect((await attempts.retrieve(input.attemptId))?.attempt.state).toMatchObject({
      kind: 'Granted',
      disposition: { kind: 'Expired' },
    });
  });

  it('reconciles concurrent exact release commands to one durable transition', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    const input = { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret };
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof({ ...input, responseSaid }, access);
    await observeWorkAccessAttempt(input, { ...access, now: () => '2026-09-24T17:01:00.000Z' });
    lifecycle.length = 0;
    const release = { ...access, now: () => '2026-09-24T17:02:00.000Z' };

    await expect(
      Promise.all([
        releaseWorkAccessGrantCapability(input, release),
        releaseWorkAccessGrantCapability(input, release),
      ]),
    ).resolves.toEqual([{ kind: 'GrantReleased' }, { kind: 'GrantReleased' }]);
    expect(lifecycle).toEqual(['commit:Granted']);
    expect((await attempts.retrieve(input.attemptId))?.attempt.state).toMatchObject({
      kind: 'Granted',
      disposition: { kind: 'Released' },
    });
  });

  it('restarts after a lost proof response and polls only the persisted verification operation', async () => {
    const attempts = new MemoryWorkAccessAttempts();
    const original = dependencies(attempts);
    await createWorkAccessAttempt(command, original);
    await submitWorkAccessProof(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
        responseSaid,
      },
      original,
    );

    const observeVerification = vi
      .fn<CreateWorkAccessAttemptDependencies['challenge']['observeVerification']>()
      .mockResolvedValueOnce({ kind: 'ChallengeVerificationPending' })
      .mockResolvedValue({ kind: 'ChallengeVerified' });
    const restarted: CreateWorkAccessAttemptDependencies = {
      ...dependencies(attempts),
      challenge: {
        ...original.challenge,
        beginVerification: () => Promise.reject(new Error('must reuse persisted operation')),
        observeVerification,
      },
      now: () => '2026-09-24T17:01:00.000Z',
    };
    await expect(
      submitWorkAccessProof(
        {
          attemptId: '11111111-1111-4111-8111-111111111111',
          bearerSecret: secret,
          responseSaid,
        },
        restarted,
      ),
    ).resolves.toMatchObject({ kind: 'ProofPending' });
    const poll = { attemptId: '11111111-1111-4111-8111-111111111111', bearerSecret: secret };
    await expect(observeWorkAccessAttempt(poll, restarted)).resolves.toMatchObject({
      kind: 'ProofPending',
    });
    await expect(observeWorkAccessAttempt(poll, restarted)).resolves.toMatchObject({
      kind: 'AttemptObserved',
      attempt: { kind: 'Granted', verifiedResponseSaid: responseSaid },
    });
    expect(observeVerification).toHaveBeenCalledTimes(2);
    expect(observeVerification).toHaveBeenNthCalledWith(1, {
      attemptId: poll.attemptId,
      sourceAid: userAid,
      recipientAid: issuerAid,
      challengeWords: words,
      responseSaid,
      operationName: 'operation.challenge.verify.1',
    });
    expect(observeVerification).toHaveBeenNthCalledWith(2, {
      attemptId: poll.attemptId,
      sourceAid: userAid,
      recipientAid: issuerAid,
      challengeWords: words,
      responseSaid,
      operationName: 'operation.challenge.verify.1',
    });
  });

  it('reconciles equivalent concurrent proof submissions and cleans the losing KERIA operation', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    let operation = 0;
    const concurrent: CreateWorkAccessAttemptDependencies = {
      ...access,
      challenge: {
        ...access.challenge,
        beginVerification: () => {
          operation += 1;
          return Promise.resolve({
            kind: 'VerificationOperationStarted',
            operationName: `operation.challenge.verify.${String(operation)}`,
          });
        },
        cleanupVerification: (operationName) => {
          lifecycle.push(`cleanup:${operationName}`);
          return Promise.resolve({ kind: 'VerificationCleaned' });
        },
      },
    };
    await createWorkAccessAttempt(command, concurrent);
    lifecycle.length = 0;

    const input = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      bearerSecret: secret,
      responseSaid,
    } as const;
    const outcomes = await Promise.all([
      submitWorkAccessProof(input, concurrent),
      submitWorkAccessProof(input, concurrent),
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: 'ProofPending' }),
      expect.objectContaining({ kind: 'ProofPending' }),
    ]);
    const persisted = await attempts.retrieve(input.attemptId);
    expect(persisted?.attempt.state).toMatchObject({
      kind: 'VerifyingProof',
      responseSaid,
      operationName: 'operation.challenge.verify.1',
    });
    expect(lifecycle).toEqual(['commit:VerifyingProof', 'cleanup:operation.challenge.verify.2']);
  });

  it('does not undo a durable grant when challenge-operation cleanup is deferred', async () => {
    const lifecycle: string[] = [];
    const attempts = new MemoryWorkAccessAttempts(lifecycle);
    const access = dependencies(attempts, lifecycle);
    await createWorkAccessAttempt(command, access);
    await submitWorkAccessProof(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
        responseSaid,
      },
      access,
    );
    const cleanupDeferred: CreateWorkAccessAttemptDependencies = {
      ...access,
      challenge: {
        ...access.challenge,
        cleanupVerification: () =>
          Promise.resolve({
            kind: 'ChallengeCleanupDeferred',
            dependency: 'KERIA',
          }),
      },
      now: () => '2026-09-24T17:01:00.000Z',
    };

    const observed = await observeWorkAccessAttempt(
      {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      },
      cleanupDeferred,
    );

    expect(observed).toMatchObject({ kind: 'AttemptObserved', attempt: { kind: 'Granted' } });
  });

  it.each(['submit', 'observe'] as const)(
    'retires the persisted verification operation after %s expires the attempt',
    async (caller) => {
      const lifecycle: string[] = [];
      const attempts = new MemoryWorkAccessAttempts(lifecycle);
      const access = dependencies(attempts, lifecycle);
      const input = {
        attemptId: '11111111-1111-4111-8111-111111111111',
        bearerSecret: secret,
      };
      await createWorkAccessAttempt(command, access);
      await submitWorkAccessProof({ ...input, responseSaid }, access);
      lifecycle.length = 0;
      const expired: CreateWorkAccessAttemptDependencies = {
        ...access,
        now: () => '2026-09-24T17:05:00.000Z',
        challenge: {
          ...access.challenge,
          cleanupVerification: (operationName) => {
            lifecycle.push(`cleanup:${operationName}`);
            return Promise.resolve({ kind: 'VerificationCleaned' });
          },
        },
      };

      const outcome =
        caller === 'submit'
          ? await submitWorkAccessProof({ ...input, responseSaid }, expired)
          : await observeWorkAccessAttempt(input, expired);

      expect(outcome).toEqual({ kind: 'AttemptExpired' });
      expect((await attempts.retrieve(input.attemptId))?.attempt.state.kind).toBe('Expired');
      expect(lifecycle).toEqual(['commit:Expired', 'cleanup:operation.challenge.verify.1']);
    },
  );
});
