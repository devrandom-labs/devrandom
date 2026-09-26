import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  CredentialCapability,
  WorkAccessRejectionReason,
  WorkAccessScope,
} from '@devrandom/protocol';
import { workAccessScopes } from '@devrandom/protocol';

import {
  workAccessPolicy,
  workAccessPolicyFingerprintFor,
  type WorkAccessPolicy,
} from './work-access-policy.js';

export interface WorkAccessCommand {
  readonly commandId: string;
  readonly clientInstanceId: string;
  readonly userAid: string;
  readonly credentialSaid: string;
  readonly grantSecretHash: string;
}

export interface WorkAccessBinding extends WorkAccessCommand {
  readonly attemptId: string;
  readonly issuerRecipientAid: string;
  readonly createdAt: string;
  readonly attemptExpiresAt: string;
}

export type WorkAccessGrantDisposition =
  | { readonly kind: 'Active'; readonly remainingRequests: number }
  | { readonly kind: 'Expired' }
  | { readonly kind: 'Exhausted' }
  | { readonly kind: 'Released'; readonly releasedAt: string }
  | { readonly kind: 'Revoked'; readonly reason: 'SecurityIncident' };

export type WorkAccessAttemptState =
  | { readonly kind: 'AwaitingProof'; readonly challengeWords: readonly string[] }
  | {
      readonly kind: 'VerifyingProof';
      readonly challengeWords: readonly string[];
      readonly responseSaid: string;
      readonly operationName: string;
    }
  | {
      readonly kind: 'Granted';
      readonly verifiedResponseSaid: string;
      readonly scopes: readonly WorkAccessScope[];
      readonly policyFingerprint: string;
      readonly grantedAt: string;
      readonly expiresAt: string;
      readonly disposition: WorkAccessGrantDisposition;
    }
  | {
      readonly kind: 'Rejected';
      readonly responseSaid?: string;
      readonly reason: WorkAccessRejectionReason;
      readonly rejectedAt: string;
    }
  | { readonly kind: 'Expired'; readonly expiredAt: string };

const validWorkAccessAttempt: unique symbol = Symbol('ValidWorkAccessAttempt');

export interface WorkAccessAttempt {
  readonly binding: WorkAccessBinding;
  readonly state: WorkAccessAttemptState;
  readonly [validWorkAccessAttempt]: true;
}

export interface AwaitingWorkAccessAttemptInput extends WorkAccessCommand {
  readonly attemptId: string;
  readonly issuerRecipientAid: string;
  readonly challengeWords: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type WorkAccessVerificationTransition =
  | { readonly kind: 'VerificationStarted'; readonly attempt: WorkAccessAttempt }
  | { readonly kind: 'EquivalentVerification'; readonly attempt: WorkAccessAttempt }
  | { readonly kind: 'ProofConflict'; readonly existingResponseSaid: string };

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keriIdentifier = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const fingerprint = /^sha256:[a-f0-9]{64}$/u;
const millisecondInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function checkedInstant(value: string, field: string): string {
  if (!millisecondInstant.test(value)) {
    throw new Error(`${field} must be a UTC RFC 3339 instant with millisecond precision`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${field} is not a valid instant`);
  }
  return value;
}

function checkedIdentifier(value: string, field: string): string {
  if (!keriIdentifier.test(value)) {
    throw new Error(`${field} must be a KERI identifier`);
  }
  return value;
}

function checkedUuid(value: string, field: string): string {
  if (!uuidV4.test(value)) {
    throw new Error(`${field} must be a UUIDv4`);
  }
  return value;
}

function checkedFingerprint(value: string, field: string): string {
  if (!fingerprint.test(value)) {
    throw new Error(`${field} must be a SHA-256 fingerprint`);
  }
  return value;
}

function requireExactLifetime(
  startsAt: string,
  expiresAt: string,
  lifetimeSeconds: number,
  authority: 'Attempt' | 'Grant',
): void {
  if (Date.parse(expiresAt) - Date.parse(startsAt) !== lifetimeSeconds * 1_000) {
    throw new Error(`Work Access ${authority} lifetime must match policy`);
  }
}

function checkedWords(words: readonly string[]): readonly string[] {
  if (
    words.length !== 24 ||
    words.some((word) => word.length === 0 || Buffer.byteLength(word, 'utf8') > 64)
  ) {
    throw new Error('Work Access challenge must contain exactly 24 bounded words');
  }
  return Object.freeze([...words]);
}

function attempt(binding: WorkAccessBinding, state: WorkAccessAttemptState): WorkAccessAttempt {
  return Object.freeze({
    binding: Object.freeze(binding),
    state: Object.freeze(state),
    [validWorkAccessAttempt]: true as const,
  });
}

export function reconstructWorkAccessAttempt(
  bindingInput: WorkAccessBinding,
  stateInput: WorkAccessAttemptState,
  policy: WorkAccessPolicy = workAccessPolicy,
): WorkAccessAttempt {
  const binding: WorkAccessBinding = {
    attemptId: checkedUuid(bindingInput.attemptId, 'attemptId'),
    commandId: checkedUuid(bindingInput.commandId, 'commandId'),
    clientInstanceId: checkedUuid(bindingInput.clientInstanceId, 'clientInstanceId'),
    userAid: checkedIdentifier(bindingInput.userAid, 'userAid'),
    credentialSaid: checkedIdentifier(bindingInput.credentialSaid, 'credentialSaid'),
    issuerRecipientAid: checkedIdentifier(bindingInput.issuerRecipientAid, 'issuerRecipientAid'),
    grantSecretHash: checkedFingerprint(bindingInput.grantSecretHash, 'grantSecretHash'),
    createdAt: checkedInstant(bindingInput.createdAt, 'createdAt'),
    attemptExpiresAt: checkedInstant(bindingInput.attemptExpiresAt, 'attemptExpiresAt'),
  };
  requireExactLifetime(
    binding.createdAt,
    binding.attemptExpiresAt,
    workAccessPolicy.attemptLifetimeSeconds,
    'Attempt',
  );
  let state: WorkAccessAttemptState;
  switch (stateInput.kind) {
    case 'AwaitingProof':
      state = { kind: 'AwaitingProof', challengeWords: checkedWords(stateInput.challengeWords) };
      break;
    case 'VerifyingProof':
      if (stateInput.operationName.length === 0) {
        throw new Error('challenge verification operation name is required');
      }
      state = {
        kind: 'VerifyingProof',
        challengeWords: checkedWords(stateInput.challengeWords),
        responseSaid: checkedIdentifier(stateInput.responseSaid, 'responseSaid'),
        operationName: stateInput.operationName,
      };
      break;
    case 'Granted': {
      const scopes = [...stateInput.scopes];
      const grantedAt = checkedInstant(stateInput.grantedAt, 'grantedAt');
      const expiresAt = checkedInstant(stateInput.expiresAt, 'expiresAt');
      if (
        scopes.length === 0 ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !workAccessScopes.includes(scope))
      ) {
        throw new Error('Work Access Grant scopes are invalid');
      }
      if (stateInput.policyFingerprint !== workAccessPolicyFingerprintFor(policy)) {
        throw new Error('Work Access Grant policy fingerprint is incompatible');
      }
      if (
        stateInput.disposition.kind === 'Active' &&
        (!Number.isSafeInteger(stateInput.disposition.remainingRequests) ||
          stateInput.disposition.remainingRequests < 0)
      ) {
        throw new Error('Work Access Grant request budget is invalid');
      }
      if (stateInput.disposition.kind === 'Released') {
        const releasedAt = checkedInstant(stateInput.disposition.releasedAt, 'releasedAt');
        if (releasedAt < grantedAt || releasedAt >= expiresAt) {
          throw new Error('Work Access Grant release must occur within its active lifetime');
        }
      }
      requireExactLifetime(grantedAt, expiresAt, policy.grantLifetimeSeconds, 'Grant');
      if (grantedAt >= binding.attemptExpiresAt) {
        throw new Error('Work Access Grant must be established before attempt expiry');
      }
      state = {
        kind: 'Granted',
        verifiedResponseSaid: checkedIdentifier(
          stateInput.verifiedResponseSaid,
          'verifiedResponseSaid',
        ),
        scopes: Object.freeze(scopes.sort()),
        policyFingerprint: stateInput.policyFingerprint,
        grantedAt,
        expiresAt,
        disposition: Object.freeze({ ...stateInput.disposition }),
      };
      break;
    }
    case 'Rejected':
      state = {
        kind: 'Rejected',
        ...(stateInput.responseSaid === undefined
          ? {}
          : { responseSaid: checkedIdentifier(stateInput.responseSaid, 'responseSaid') }),
        reason: stateInput.reason,
        rejectedAt: checkedInstant(stateInput.rejectedAt, 'rejectedAt'),
      };
      break;
    case 'Expired':
      state = {
        kind: 'Expired',
        expiredAt: checkedInstant(stateInput.expiredAt, 'expiredAt'),
      };
      break;
  }
  return attempt(binding, state);
}

export function createAwaitingWorkAccessAttempt(
  input: AwaitingWorkAccessAttemptInput,
): WorkAccessAttempt {
  const createdAt = checkedInstant(input.createdAt, 'createdAt');
  const attemptExpiresAt = checkedInstant(input.expiresAt, 'expiresAt');
  if (attemptExpiresAt <= createdAt) {
    throw new Error('Work Access Attempt expiry must be after creation');
  }
  requireExactLifetime(
    createdAt,
    attemptExpiresAt,
    workAccessPolicy.attemptLifetimeSeconds,
    'Attempt',
  );
  const binding: WorkAccessBinding = {
    attemptId: checkedUuid(input.attemptId, 'attemptId'),
    commandId: checkedUuid(input.commandId, 'commandId'),
    clientInstanceId: checkedUuid(input.clientInstanceId, 'clientInstanceId'),
    userAid: checkedIdentifier(input.userAid, 'userAid'),
    credentialSaid: checkedIdentifier(input.credentialSaid, 'credentialSaid'),
    issuerRecipientAid: checkedIdentifier(input.issuerRecipientAid, 'issuerRecipientAid'),
    grantSecretHash: checkedFingerprint(input.grantSecretHash, 'grantSecretHash'),
    createdAt,
    attemptExpiresAt,
  };
  return attempt(binding, {
    kind: 'AwaitingProof',
    challengeWords: checkedWords(input.challengeWords),
  });
}

export function beginWorkAccessVerification(
  current: WorkAccessAttempt,
  responseSaid: string,
  operationName: string,
): WorkAccessVerificationTransition {
  const verifiedResponseSaid = checkedIdentifier(responseSaid, 'responseSaid');
  if (operationName.length === 0) {
    throw new Error('challenge verification operation name is required');
  }
  switch (current.state.kind) {
    case 'AwaitingProof':
      return {
        kind: 'VerificationStarted',
        attempt: attempt(current.binding, {
          kind: 'VerifyingProof',
          challengeWords: current.state.challengeWords,
          responseSaid: verifiedResponseSaid,
          operationName,
        }),
      };
    case 'VerifyingProof':
      return current.state.responseSaid === verifiedResponseSaid
        ? { kind: 'EquivalentVerification', attempt: current }
        : { kind: 'ProofConflict', existingResponseSaid: current.state.responseSaid };
    case 'Granted':
      return {
        kind: 'ProofConflict',
        existingResponseSaid: current.state.verifiedResponseSaid,
      };
    case 'Rejected':
      return {
        kind: 'ProofConflict',
        existingResponseSaid: current.state.responseSaid ?? '',
      };
    case 'Expired':
      return { kind: 'ProofConflict', existingResponseSaid: '' };
  }
}

export function scopesForEligibility(
  claims: readonly CredentialCapability[],
): readonly WorkAccessScope[] {
  const claimSet = new Set<CredentialCapability>(claims);
  const scopes: WorkAccessScope[] = [];
  if (claimSet.has('RunPrivateTask')) {
    scopes.push('evidence:append', 'evidence:seal', 'run:create', 'run:execute');
  }
  if (claimSet.has('CreateAgent') && claimSet.has('RunPrivateTask')) {
    scopes.push('run:prepare');
  }
  if (claimSet.has('ReceiveTaskResults')) {
    scopes.push('run:read');
  }
  if (claimSet.has('CreateTask')) {
    scopes.push('task:create', 'task:read');
  }
  return Object.freeze(scopes.sort());
}

export function grantWorkAccessAttempt(
  current: WorkAccessAttempt,
  claims: readonly CredentialCapability[],
  grantedAtInput: string,
  expiresAtInput: string,
  policy: WorkAccessPolicy,
): WorkAccessAttempt {
  if (current.state.kind !== 'VerifyingProof') {
    throw new Error('Only a verifying Work Access Attempt can be granted');
  }
  const grantedAt = checkedInstant(grantedAtInput, 'grantedAt');
  const expiresAt = checkedInstant(expiresAtInput, 'expiresAt');
  if (expiresAt <= grantedAt) {
    throw new Error('Work Access Grant expiry must be after grant time');
  }
  requireExactLifetime(grantedAt, expiresAt, policy.grantLifetimeSeconds, 'Grant');
  if (grantedAt >= current.binding.attemptExpiresAt) {
    throw new Error('Work Access Grant must be established before attempt expiry');
  }
  const scopes = scopesForEligibility(claims);
  if (scopes.length === 0) {
    throw new Error('Current credential does not yield a Work Access scope');
  }
  return attempt(current.binding, {
    kind: 'Granted',
    verifiedResponseSaid: current.state.responseSaid,
    scopes,
    policyFingerprint: workAccessPolicyFingerprintFor(policy),
    grantedAt,
    expiresAt,
    disposition: { kind: 'Active', remainingRequests: policy.requestsPerGrant },
  });
}

export function rejectWorkAccessAttempt(
  current: WorkAccessAttempt,
  reason: WorkAccessRejectionReason,
  rejectedAtInput: string,
): WorkAccessAttempt {
  const responseSaid =
    current.state.kind === 'VerifyingProof' ? current.state.responseSaid : undefined;
  return attempt(current.binding, {
    kind: 'Rejected',
    ...(responseSaid === undefined ? {} : { responseSaid }),
    reason,
    rejectedAt: checkedInstant(rejectedAtInput, 'rejectedAt'),
  });
}

export function expireWorkAccessAttempt(
  current: WorkAccessAttempt,
  expiredAtInput: string,
): WorkAccessAttempt {
  return attempt(current.binding, {
    kind: 'Expired',
    expiredAt: checkedInstant(expiredAtInput, 'expiredAt'),
  });
}

export type WorkAccessGrantRelease =
  | { readonly kind: 'GrantReleased'; readonly attempt: WorkAccessAttempt }
  | { readonly kind: 'AlreadyInactive' }
  | { readonly kind: 'ReleaseConflict' };

export function releaseWorkAccessGrant(
  current: WorkAccessAttempt,
  releasedAtInput: string,
): WorkAccessGrantRelease {
  const releasedAt = checkedInstant(releasedAtInput, 'releasedAt');
  if (current.state.kind !== 'Granted') return { kind: 'ReleaseConflict' };
  if (current.state.disposition.kind !== 'Active') return { kind: 'AlreadyInactive' };
  return {
    kind: 'GrantReleased',
    attempt: attempt(current.binding, {
      ...current.state,
      disposition:
        releasedAt >= current.state.expiresAt
          ? { kind: 'Expired' }
          : { kind: 'Released', releasedAt },
    }),
  };
}

export function workAccessExpiration(current: WorkAccessAttempt): string {
  return current.state.kind === 'Granted'
    ? current.state.expiresAt
    : current.binding.attemptExpiresAt;
}

export function workAccessResponseSaid(current: WorkAccessAttempt): string | undefined {
  switch (current.state.kind) {
    case 'AwaitingProof':
    case 'Expired':
      return undefined;
    case 'VerifyingProof':
      return current.state.responseSaid;
    case 'Granted':
      return current.state.verifiedResponseSaid;
    case 'Rejected':
      return current.state.responseSaid;
  }
}

export function workAccessCommandFingerprint(command: WorkAccessCommand): string {
  checkedUuid(command.clientInstanceId, 'clientInstanceId');
  checkedUuid(command.commandId, 'commandId');
  checkedIdentifier(command.userAid, 'userAid');
  checkedIdentifier(command.credentialSaid, 'credentialSaid');
  checkedFingerprint(command.grantSecretHash, 'grantSecretHash');
  const canonical = JSON.stringify({
    clientInstanceId: command.clientInstanceId,
    credentialSaid: command.credentialSaid,
    grantSecretHash: command.grantSecretHash,
    userAid: command.userAid,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function workAccessGrantSecretHash(secret: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new Error('Work Access Grant secret must encode exactly 32 bytes');
  }
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== secret) {
    throw new Error('Work Access Grant secret must encode exactly 32 bytes');
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
