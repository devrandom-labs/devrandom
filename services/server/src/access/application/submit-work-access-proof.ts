import type { WorkAccessAttemptProjection } from '@devrandom/protocol';

import {
  beginWorkAccessVerification,
  expireWorkAccessAttempt,
  workAccessGrantSecretHash,
} from '../domain/work-access.js';
import type { CreateWorkAccessAttemptDependencies } from './create-work-access-attempt.js';
import type { WorkAccessAttemptCommit } from './work-access-attempts.js';
import { projectWorkAccessAttempt } from './work-access-projection.js';
import type { WorkAccessDependency } from './work-access-dependency.js';

export interface SubmitWorkAccessProofInput {
  readonly attemptId: string;
  readonly bearerSecret: string;
  readonly responseSaid: string;
}

export type SubmitWorkAccessProofOutcome =
  | { readonly kind: 'ProofPending'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'AttemptObserved'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'CapabilityInvalid' }
  | { readonly kind: 'ProofConflict' }
  | { readonly kind: 'ProofReplayed' }
  | { readonly kind: 'AttemptExpired' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: WorkAccessDependency };

function submittedProofOutcome(committed: WorkAccessAttemptCommit): SubmitWorkAccessProofOutcome {
  switch (committed.kind) {
    case 'AttemptCommitted':
      return {
        kind: 'ProofPending',
        attempt: projectWorkAccessAttempt(committed.stored.attempt),
      };
    case 'ProofResponseReplayed':
      return { kind: 'ProofReplayed' };
    case 'ConcurrentlyModified':
    case 'GrantCapacityExceeded':
      return { kind: 'ProofConflict' };
  }
}

async function reconcileConcurrentProof(
  input: SubmitWorkAccessProofInput,
  operationName: string,
  dependencies: CreateWorkAccessAttemptDependencies,
): Promise<SubmitWorkAccessProofOutcome> {
  const latest = await dependencies.attempts.retrieveAuthorized(
    input.attemptId,
    workAccessGrantSecretHash(input.bearerSecret),
  );
  if (latest.kind === 'AttemptNotFound') {
    await dependencies.challenge.cleanupVerification(operationName);
    return { kind: 'ProofConflict' };
  }
  const state = latest.stored.attempt.state;
  if (state.kind === 'VerifyingProof' && state.responseSaid === input.responseSaid) {
    if (state.operationName !== operationName) {
      await dependencies.challenge.cleanupVerification(operationName);
    }
    return {
      kind: 'ProofPending',
      attempt: projectWorkAccessAttempt(latest.stored.attempt),
    };
  }
  if (state.kind === 'Granted' && state.verifiedResponseSaid === input.responseSaid) {
    await dependencies.challenge.cleanupVerification(operationName);
    return {
      kind: 'AttemptObserved',
      attempt: projectWorkAccessAttempt(latest.stored.attempt),
    };
  }
  await dependencies.challenge.cleanupVerification(operationName);
  return { kind: 'ProofConflict' };
}

export async function submitWorkAccessProof(
  input: SubmitWorkAccessProofInput,
  dependencies: CreateWorkAccessAttemptDependencies,
): Promise<SubmitWorkAccessProofOutcome> {
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
  const now = dependencies.now();
  if (current.attempt.state.kind !== 'Granted' && now >= current.attempt.binding.attemptExpiresAt) {
    const expiration = await dependencies.attempts.commit(
      current,
      expireWorkAccessAttempt(current.attempt, now),
    );
    if (expiration.kind === 'AttemptCommitted') {
      if (current.attempt.state.kind === 'VerifyingProof') {
        await dependencies.challenge.cleanupVerification(current.attempt.state.operationName);
      }
      return { kind: 'AttemptExpired' };
    }
    return expiration.kind === 'ProofResponseReplayed'
      ? { kind: 'ProofReplayed' }
      : { kind: 'ProofConflict' };
  }
  switch (current.attempt.state.kind) {
    case 'AwaitingProof': {
      const started = await dependencies.challenge.beginVerification({
        attemptId: current.attempt.binding.attemptId,
        sourceAid: current.attempt.binding.userAid,
        recipientAid: current.attempt.binding.issuerRecipientAid,
        challengeWords: current.attempt.state.challengeWords,
        responseSaid: input.responseSaid,
      });
      if (started.kind === 'ChallengeUnavailable') {
        return { kind: 'DependencyUnavailable', dependency: started.dependency };
      }
      if (started.kind === 'ChallengeRejected') {
        return { kind: 'ProofConflict' };
      }
      const transition = beginWorkAccessVerification(
        current.attempt,
        input.responseSaid,
        started.operationName,
      );
      if (transition.kind !== 'VerificationStarted') {
        return { kind: 'ProofConflict' };
      }
      const committed = await dependencies.attempts.commit(current, transition.attempt);
      if (committed.kind === 'ConcurrentlyModified') {
        return reconcileConcurrentProof(input, started.operationName, dependencies);
      }
      if (committed.kind !== 'AttemptCommitted') {
        await dependencies.challenge.cleanupVerification(started.operationName);
      }
      return submittedProofOutcome(committed);
    }
    case 'VerifyingProof':
      return current.attempt.state.responseSaid === input.responseSaid
        ? { kind: 'ProofPending', attempt: projectWorkAccessAttempt(current.attempt) }
        : { kind: 'ProofConflict' };
    case 'Granted':
      return current.attempt.state.verifiedResponseSaid === input.responseSaid
        ? { kind: 'AttemptObserved', attempt: projectWorkAccessAttempt(current.attempt) }
        : { kind: 'ProofConflict' };
    case 'Rejected':
      return current.attempt.state.responseSaid === input.responseSaid
        ? { kind: 'AttemptObserved', attempt: projectWorkAccessAttempt(current.attempt) }
        : { kind: 'ProofConflict' };
    case 'Expired':
      return { kind: 'AttemptExpired' };
  }
}
