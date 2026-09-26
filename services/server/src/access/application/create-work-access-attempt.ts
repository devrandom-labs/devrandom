import type { WorkAccessAttemptProjection } from '@devrandom/protocol';

import {
  createAwaitingWorkAccessAttempt,
  workAccessCommandFingerprint,
  type WorkAccessCommand,
} from '../domain/work-access.js';
import type { WorkAccessPolicy } from '../domain/work-access-policy.js';
import type { WorkAccessAttempts } from './work-access-attempts.js';
import type { WorkAccessChallengeProof } from './work-access-challenge.js';
import type { WorkAccessCredentialVerification } from './work-access-identity.js';
import { projectWorkAccessAttempt } from './work-access-projection.js';
import type { WorkAccessAttemptQuota } from './work-access-quota.js';
import type { WorkAccessDependency } from './work-access-dependency.js';

export interface CreateWorkAccessAttemptInput extends WorkAccessCommand {
  readonly sourceAddress: string;
}

export interface CreateWorkAccessAttemptDependencies {
  readonly issuerRecipientAid: string;
  readonly policy: WorkAccessPolicy;
  readonly attempts: WorkAccessAttempts;
  readonly credential: WorkAccessCredentialVerification;
  readonly challenge: WorkAccessChallengeProof;
  readonly quota: WorkAccessAttemptQuota;
  now(): string;
  newAttemptId(): string;
}

export type CreateWorkAccessAttemptOutcome =
  | { readonly kind: 'AttemptCreated'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'ExistingAttempt'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'CommandConflict' }
  | { readonly kind: 'CredentialRejected' }
  | { readonly kind: 'AttemptCapacityExceeded' }
  | { readonly kind: 'AttemptRateExceeded' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: WorkAccessDependency };

function plusSeconds(instant: string, seconds: number): string {
  const milliseconds = Date.parse(instant) + seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error('Work Access expiry exceeds the supported time range');
  }
  return new Date(milliseconds).toISOString();
}

export async function createWorkAccessAttempt(
  input: CreateWorkAccessAttemptInput,
  dependencies: CreateWorkAccessAttemptDependencies,
): Promise<CreateWorkAccessAttemptOutcome> {
  const commandFingerprint = workAccessCommandFingerprint(input);
  const reconciliation = await dependencies.attempts.reconcileCommand(input, commandFingerprint);
  if (reconciliation.kind === 'ExistingAttempt') {
    return {
      kind: 'ExistingAttempt',
      attempt: projectWorkAccessAttempt(reconciliation.stored.attempt),
    };
  }
  if (reconciliation.kind === 'CommandConflict') {
    return reconciliation;
  }
  const quota = dependencies.quota.admit(input.sourceAddress);
  if (quota.kind === 'AttemptRateExceeded') {
    return quota;
  }
  const credential = await dependencies.credential.verify({
    userAid: input.userAid,
    credentialSaid: input.credentialSaid,
  });
  if (credential.kind === 'CredentialRejected') {
    return credential;
  }
  if (credential.kind === 'CredentialUnavailable') {
    return { kind: 'DependencyUnavailable', dependency: credential.dependency };
  }
  const challenge = await dependencies.challenge.issue();
  if (challenge.kind === 'ChallengeUnavailable') {
    return { kind: 'DependencyUnavailable', dependency: challenge.dependency };
  }
  const now = dependencies.now();
  const attempt = createAwaitingWorkAccessAttempt({
    ...input,
    attemptId: dependencies.newAttemptId(),
    issuerRecipientAid: dependencies.issuerRecipientAid,
    challengeWords: challenge.words,
    createdAt: now,
    expiresAt: plusSeconds(now, dependencies.policy.attemptLifetimeSeconds),
  });
  const created = await dependencies.attempts.create(attempt, commandFingerprint);
  switch (created.kind) {
    case 'AttemptCreated':
      return { kind: 'AttemptCreated', attempt: projectWorkAccessAttempt(created.stored.attempt) };
    case 'ExistingAttempt':
      return { kind: 'ExistingAttempt', attempt: projectWorkAccessAttempt(created.stored.attempt) };
    case 'CommandConflict':
    case 'AttemptCapacityExceeded':
      return created;
  }
}

export function workAccessInstantPlusSeconds(instant: string, seconds: number): string {
  return plusSeconds(instant, seconds);
}
