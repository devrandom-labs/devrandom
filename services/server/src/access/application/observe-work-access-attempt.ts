import type { WorkAccessAttemptProjection } from '@devrandom/protocol';

import {
  expireWorkAccessAttempt,
  grantWorkAccessAttempt,
  rejectWorkAccessAttempt,
  workAccessGrantSecretHash,
} from '../domain/work-access.js';
import {
  type CreateWorkAccessAttemptDependencies,
  workAccessInstantPlusSeconds,
} from './create-work-access-attempt.js';
import { projectWorkAccessAttempt } from './work-access-projection.js';
import type { WorkAccessDependency } from './work-access-dependency.js';
import type { WorkAccessRejectionReason } from '@devrandom/protocol';

export interface ObserveWorkAccessAttemptInput {
  readonly attemptId: string;
  readonly bearerSecret: string;
}

export type ObserveWorkAccessAttemptOutcome =
  | { readonly kind: 'AttemptObserved'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'ProofPending'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'CapabilityInvalid' }
  | { readonly kind: 'CredentialRejected' }
  | { readonly kind: 'AttemptExpired' }
  | { readonly kind: 'ProofRejected'; readonly reason: WorkAccessRejectionReason }
  | { readonly kind: 'ProofReplayed' }
  | { readonly kind: 'GrantCapacityExceeded' }
  | { readonly kind: 'ConcurrentUpdate' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: WorkAccessDependency };

export async function observeWorkAccessAttempt(
  input: ObserveWorkAccessAttemptInput,
  dependencies: CreateWorkAccessAttemptDependencies,
): Promise<ObserveWorkAccessAttemptOutcome> {
  let secretHash: string;
  try {
    secretHash = workAccessGrantSecretHash(input.bearerSecret);
  } catch {
    return { kind: 'CapabilityInvalid' };
  }
  const lookup = await dependencies.attempts.retrieveAuthorized(input.attemptId, secretHash);
  if (lookup.kind === 'AttemptNotFound') {
    return { kind: 'CapabilityInvalid' };
  }
  const current = lookup.stored;
  const expireAfterDeadline = async (
    observedAt: string,
  ): Promise<ObserveWorkAccessAttemptOutcome | undefined> => {
    if (
      current.attempt.state.kind === 'Granted' ||
      observedAt < current.attempt.binding.attemptExpiresAt
    ) {
      return undefined;
    }
    const expired = await dependencies.attempts.commit(
      current,
      expireWorkAccessAttempt(current.attempt, observedAt),
    );
    if (expired.kind === 'AttemptCommitted' && current.attempt.state.kind === 'VerifyingProof') {
      await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
    }
    return expired.kind === 'AttemptCommitted'
      ? { kind: 'AttemptExpired' }
      : expired.kind === 'ProofResponseReplayed'
        ? { kind: 'ProofReplayed' }
        : { kind: 'ConcurrentUpdate' };
  };
  const initialExpiry = await expireAfterDeadline(dependencies.now());
  if (initialExpiry !== undefined) {
    return initialExpiry;
  }
  if (current.attempt.state.kind !== 'VerifyingProof') {
    return current.attempt.state.kind === 'Expired'
      ? { kind: 'AttemptExpired' }
      : { kind: 'AttemptObserved', attempt: projectWorkAccessAttempt(current.attempt) };
  }
  const observed = await dependencies.challenge.observeVerification({
    attemptId: current.attempt.binding.attemptId,
    sourceAid: current.attempt.binding.userAid,
    recipientAid: current.attempt.binding.issuerRecipientAid,
    challengeWords: current.attempt.state.challengeWords,
    responseSaid: current.attempt.state.responseSaid,
    operationName: current.attempt.state.operationName,
  });
  const observedAt = dependencies.now();
  const verificationExpiry = await expireAfterDeadline(observedAt);
  if (verificationExpiry !== undefined) {
    return verificationExpiry;
  }
  if (observed.kind === 'ChallengeUnavailable') {
    return { kind: 'DependencyUnavailable', dependency: observed.dependency };
  }
  if (observed.kind === 'ChallengeVerificationPending') {
    return { kind: 'ProofPending', attempt: projectWorkAccessAttempt(current.attempt) };
  }
  if (observed.kind === 'ChallengeRejected') {
    const rejected = await dependencies.attempts.commit(
      current,
      rejectWorkAccessAttempt(current.attempt, observed.reason, observedAt),
    );
    if (rejected.kind === 'AttemptCommitted') {
      await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
      return { kind: 'ProofRejected', reason: observed.reason };
    }
    return rejected.kind === 'ProofResponseReplayed'
      ? { kind: 'ProofReplayed' }
      : { kind: 'ConcurrentUpdate' };
  }
  const acknowledgement = await dependencies.challenge.acknowledgeResponse({
    sourceAid: current.attempt.binding.userAid,
    responseSaid: current.attempt.state.responseSaid,
  });
  const acknowledgedAt = dependencies.now();
  const acknowledgementExpiry = await expireAfterDeadline(acknowledgedAt);
  if (acknowledgementExpiry !== undefined) {
    return acknowledgementExpiry;
  }
  if (acknowledgement.kind === 'ChallengeUnavailable') {
    return { kind: 'DependencyUnavailable', dependency: acknowledgement.dependency };
  }
  if (acknowledgement.kind === 'ChallengeRejected') {
    const rejected = await dependencies.attempts.commit(
      current,
      rejectWorkAccessAttempt(current.attempt, acknowledgement.reason, acknowledgedAt),
    );
    if (rejected.kind === 'AttemptCommitted') {
      await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
      return { kind: 'ProofRejected', reason: acknowledgement.reason };
    }
    return rejected.kind === 'ProofResponseReplayed'
      ? { kind: 'ProofReplayed' }
      : { kind: 'ConcurrentUpdate' };
  }
  const credential = await dependencies.credential.verify({
    userAid: current.attempt.binding.userAid,
    credentialSaid: current.attempt.binding.credentialSaid,
  });
  // KERIA acknowledgement and credential revalidation can outlive the
  // five-minute attempt. Grant time must describe the actual final decision.
  const grantAt = dependencies.now();
  const credentialExpiry = await expireAfterDeadline(grantAt);
  if (credentialExpiry !== undefined) {
    return credentialExpiry;
  }
  if (credential.kind === 'CredentialUnavailable') {
    return { kind: 'DependencyUnavailable', dependency: credential.dependency };
  }
  if (credential.kind === 'CredentialRejected') {
    const rejected = await dependencies.attempts.commit(
      current,
      rejectWorkAccessAttempt(current.attempt, 'CredentialNotCurrent', grantAt),
    );
    if (rejected.kind === 'AttemptCommitted') {
      await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
      return credential;
    }
    return rejected.kind === 'ProofResponseReplayed'
      ? { kind: 'ProofReplayed' }
      : { kind: 'ConcurrentUpdate' };
  }
  const granted = grantWorkAccessAttempt(
    current.attempt,
    credential.claims,
    grantAt,
    workAccessInstantPlusSeconds(grantAt, dependencies.policy.grantLifetimeSeconds),
    dependencies.policy,
  );
  const committed = await dependencies.attempts.commit(current, granted);
  switch (committed.kind) {
    case 'AttemptCommitted':
      await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
      return {
        kind: 'AttemptObserved',
        attempt: projectWorkAccessAttempt(committed.stored.attempt),
      };
    case 'ProofResponseReplayed':
      return { kind: 'ProofReplayed' };
    case 'GrantCapacityExceeded':
      return { kind: 'GrantCapacityExceeded' };
    case 'ConcurrentlyModified':
      return { kind: 'ConcurrentUpdate' };
  }
}
