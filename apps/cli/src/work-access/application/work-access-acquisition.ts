import { randomBytes, randomUUID } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';

import type { WorkAccessAttemptProjection, WorkAccessProblem } from '@devrandom/protocol';

import type { DevrandomFetch } from '../../infrastructure/devrandom-server-http.js';
import type { HostedWorkIdentityOutcome } from '../../identity/application/user-identity.js';
import {
  ServerWorkAccessHttp,
  WorkAccessHttpFailure,
  type GrantedServerWorkHttp,
  type GrantedWorkAccessProjection,
  type WorkAccessHttpObservation,
} from '../infrastructure/server-work-access-http.js';

const grantSecretByteLength = 32;
const requestRetryLimit = 3;
const pollIntervalMilliseconds = 1_000;
const pollRequestLimit = 300;

type ReadyHostedWorkIdentity = Extract<HostedWorkIdentityOutcome, { readonly kind: 'Ready' }>;

export interface WorkAccessAcquisitionDependencies {
  randomBytes(size: number): Uint8Array;
  randomUUID(): string;
  monotonicNow(): number;
  wait(milliseconds: number): Promise<void>;
  readonly fetch: DevrandomFetch;
}

export const workAccessAcquisitionDefaults: WorkAccessAcquisitionDependencies = {
  randomBytes: (size) => randomBytes(size),
  randomUUID,
  monotonicNow: () => performance.now(),
  wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  fetch: globalThis.fetch,
};

export type WorkAccessAcquisition =
  | {
      readonly kind: 'Granted';
      readonly server: GrantedServerWorkHttp;
      readonly grantDeadline: number;
    }
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'AidProofUnavailable' }
  | { readonly kind: 'AttemptRejected' }
  | { readonly kind: 'AttemptExpired' }
  | {
      readonly kind: 'GrantInactive';
      readonly disposition: 'Expired' | 'Exhausted' | 'Revoked' | 'Released';
    }
  | {
      readonly kind: 'ServerRejected';
      readonly code: WorkAccessProblem['code'];
      readonly correlationId: string;
    }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ServerResponseInvalid' }
  | { readonly kind: 'LocalPreparationFailed' }
  | { readonly kind: 'PollingLimitReached' };

interface AcceptedAttemptBinding {
  readonly attemptId: string;
  readonly commandId: string;
  readonly clientInstanceId: string;
  readonly userAid: string;
  readonly credentialSaid: string;
  readonly issuerRecipientAid: string;
  readonly grantSecretHash: string;
  readonly attemptExpiresAt: string;
  readonly requestStartedAt: number;
  readonly attemptDeadline: number;
}

type ProofReconciliation =
  | { readonly kind: 'Continue' }
  | Exclude<WorkAccessAcquisition, { readonly kind: 'AidProofUnavailable' }>;

export async function acquireWorkAccess(
  serverUrl: string,
  identity: ReadyHostedWorkIdentity,
  dependencies: WorkAccessAcquisitionDependencies = workAccessAcquisitionDefaults,
  signal?: AbortSignal,
): Promise<WorkAccessAcquisition> {
  if (signal?.aborted) return { kind: 'Interrupted' };
  let access: ServerWorkAccessHttp;
  try {
    const secretBytes = dependencies.randomBytes(grantSecretByteLength);
    try {
      access = new ServerWorkAccessHttp(
        serverUrl,
        secretBytes,
        dependencies.fetch,
        identity.protectedCredentials,
      );
    } finally {
      secretBytes.fill(0);
    }
  } catch (cause) {
    return acquisitionFailure(cause, signal);
  }

  let command: {
    readonly version: 1;
    readonly commandId: string;
    readonly clientInstanceId: string;
    readonly userAid: string;
    readonly credentialSaid: string;
    readonly grantSecretHash: string;
  };
  try {
    command = {
      version: 1,
      commandId: dependencies.randomUUID(),
      clientInstanceId: identity.clientInstanceId,
      userAid: identity.user.principal.aid,
      credentialSaid: identity.user.credential.credentialSaid,
      grantSecretHash: access.grantSecretHash,
    };
  } catch {
    return { kind: 'LocalPreparationFailed' };
  }
  const requestStartedAt = dependencies.monotonicNow();
  const attemptDeadline =
    requestStartedAt + taskBudgetCeilings.workAccessAttemptLifetimeSeconds * 1_000;
  let created: WorkAccessAttemptProjection;
  try {
    created = await retryServerRequest(
      () => access.createAttempt(command, signal),
      dependencies,
      signal,
    );
  } catch (cause) {
    return acquisitionFailure(cause, signal);
  }
  if (
    created.kind !== 'AwaitingProof' ||
    !hasInitialBinding(created, command, identity.user.credential.issuerAid) ||
    created.challengeWords.length !== 24
  ) {
    return { kind: 'ServerResponseInvalid' };
  }
  if (dependencies.monotonicNow() >= attemptDeadline) return { kind: 'AttemptExpired' };
  const binding: AcceptedAttemptBinding = {
    attemptId: created.attemptId,
    commandId: created.commandId,
    clientInstanceId: created.clientInstanceId,
    userAid: created.userAid,
    credentialSaid: created.credentialSaid,
    issuerRecipientAid: created.issuerRecipientAid,
    grantSecretHash: created.grantSecretHash,
    attemptExpiresAt: created.attemptExpiresAt,
    requestStartedAt,
    attemptDeadline,
  };
  let responseSaid: string;
  try {
    responseSaid = await identity.userAidProof.respond(created.challengeWords);
  } catch {
    return { kind: signal?.aborted ? 'Interrupted' : 'AidProofUnavailable' };
  }

  if (signal?.aborted) return { kind: 'Interrupted' };

  let observation: WorkAccessHttpObservation;
  try {
    observation = await retryServerRequest(
      () => access.submitProof(binding.attemptId, responseSaid, signal),
      dependencies,
      signal,
    );
  } catch (cause) {
    return acquisitionFailure(cause, signal);
  }

  for (let pollCount = 0; pollCount < pollRequestLimit; pollCount += 1) {
    if (signal?.aborted) return { kind: 'Interrupted' };
    const reconciliation = reconcileProof(
      observation,
      binding,
      responseSaid,
      access,
      dependencies.monotonicNow(),
    );
    if (reconciliation.kind !== 'Continue') {
      return reconciliation;
    }
    if (dependencies.monotonicNow() >= binding.attemptDeadline) {
      return { kind: 'AttemptExpired' };
    }
    try {
      await dependencies.wait(pollIntervalMilliseconds);
    } catch {
      return { kind: signal?.aborted ? 'Interrupted' : 'ServerUnavailable' };
    }
    if (signal?.aborted) return { kind: 'Interrupted' };
    if (dependencies.monotonicNow() >= binding.attemptDeadline) {
      return { kind: 'AttemptExpired' };
    }
    try {
      observation = await retryServerRequest(
        () => access.observeAttempt(binding.attemptId, signal),
        dependencies,
        signal,
      );
    } catch (cause) {
      // The server still owns this proof-ready attempt. A temporary failure
      // cannot justify abandoning its binding, bearer or nonterminal slot.
      if (cause instanceof WorkAccessHttpFailure) {
        if (cause.detail.kind === 'server-unavailable') continue;
        if (cause.detail.kind === 'request-rejected') {
          const code = cause.detail.problem.code;
          if (code === 'WorkAccessConcurrentUpdate' || code === 'WorkAccessUnavailable') continue;
        }
      }
      return acquisitionFailure(cause, signal);
    }
  }
  return { kind: 'PollingLimitReached' };
}

async function retryServerRequest<Value>(
  request: () => Promise<Value>,
  dependencies: WorkAccessAcquisitionDependencies,
  signal?: AbortSignal,
): Promise<Value> {
  let unavailable: WorkAccessHttpFailure | undefined;
  for (let requestCount = 0; requestCount < requestRetryLimit; requestCount += 1) {
    try {
      signal?.throwIfAborted();
      const response = await request();
      signal?.throwIfAborted();
      return response;
    } catch (cause) {
      signal?.throwIfAborted();
      if (!(cause instanceof WorkAccessHttpFailure) || cause.detail.kind !== 'server-unavailable') {
        throw cause;
      }
      unavailable = cause;
    }
    if (requestCount + 1 < requestRetryLimit) {
      await dependencies.wait(pollIntervalMilliseconds);
    }
  }
  throw unavailable ?? new WorkAccessHttpFailure({ kind: 'server-unavailable' });
}

function reconcileProof(
  observation: WorkAccessHttpObservation,
  expected: AcceptedAttemptBinding,
  responseSaid: string,
  access: ServerWorkAccessHttp,
  now: number,
): ProofReconciliation {
  const attempt = observation.attempt;
  if (!hasAcceptedBinding(attempt, expected)) {
    return { kind: 'ServerResponseInvalid' };
  }
  switch (attempt.kind) {
    case 'AwaitingProof':
      return { kind: 'ServerResponseInvalid' };
    case 'VerifyingProof':
      return observation.kind === 'Pending' && attempt.responseSaid === responseSaid
        ? { kind: 'Continue' }
        : { kind: 'ServerResponseInvalid' };
    case 'Granted':
      if (observation.kind !== 'Observed' || attempt.verifiedResponseSaid !== responseSaid) {
        return { kind: 'ServerResponseInvalid' };
      }
      return activeGrant(attempt, access, expected, now);
    case 'Rejected':
      return observation.kind === 'Observed'
        ? { kind: 'AttemptRejected' }
        : { kind: 'ServerResponseInvalid' };
    case 'Expired':
      return observation.kind === 'Observed'
        ? { kind: 'AttemptExpired' }
        : { kind: 'ServerResponseInvalid' };
  }
}

function activeGrant(
  grant: GrantedWorkAccessProjection,
  access: ServerWorkAccessHttp,
  binding: AcceptedAttemptBinding,
  now: number,
): Exclude<WorkAccessAcquisition, { readonly kind: 'AidProofUnavailable' }> {
  switch (grant.disposition.kind) {
    case 'Active': {
      // Both timestamps come from the same server. Starting before attempt
      // creation conservatively includes request transit, retries and proof time.
      const serverInterval =
        Date.parse(grant.disposition.expiresAt) -
        Date.parse(binding.attemptExpiresAt) +
        taskBudgetCeilings.workAccessAttemptLifetimeSeconds * 1_000;
      if (!Number.isSafeInteger(serverInterval) || serverInterval <= 0) {
        return { kind: 'ServerResponseInvalid' };
      }
      const grantDeadline = binding.requestStartedAt + serverInterval;
      return now < grantDeadline
        ? { kind: 'Granted', server: access.authorizedWork(grant), grantDeadline }
        : { kind: 'GrantInactive', disposition: 'Expired' };
    }
    case 'Expired':
    case 'Exhausted':
      return { kind: 'GrantInactive', disposition: grant.disposition.kind };
    case 'Revoked':
      return { kind: 'GrantInactive', disposition: 'Revoked' };
    case 'Released':
      return { kind: 'GrantInactive', disposition: 'Released' };
  }
}

function hasInitialBinding(
  attempt: WorkAccessAttemptProjection,
  command: {
    readonly commandId: string;
    readonly clientInstanceId: string;
    readonly userAid: string;
    readonly credentialSaid: string;
    readonly grantSecretHash: string;
  },
  issuerRecipientAid: string,
): boolean {
  return (
    attempt.commandId === command.commandId &&
    attempt.clientInstanceId === command.clientInstanceId &&
    attempt.userAid === command.userAid &&
    attempt.credentialSaid === command.credentialSaid &&
    attempt.issuerRecipientAid === issuerRecipientAid &&
    attempt.grantSecretHash === command.grantSecretHash
  );
}

function hasAcceptedBinding(
  attempt: WorkAccessAttemptProjection,
  expected: AcceptedAttemptBinding,
): boolean {
  return (
    attempt.attemptId === expected.attemptId &&
    attempt.commandId === expected.commandId &&
    attempt.clientInstanceId === expected.clientInstanceId &&
    attempt.userAid === expected.userAid &&
    attempt.credentialSaid === expected.credentialSaid &&
    attempt.issuerRecipientAid === expected.issuerRecipientAid &&
    attempt.grantSecretHash === expected.grantSecretHash &&
    attempt.attemptExpiresAt === expected.attemptExpiresAt
  );
}

function acquisitionFailure(cause: unknown, signal?: AbortSignal): WorkAccessAcquisition {
  if (signal?.aborted) return { kind: 'Interrupted' };
  if (!(cause instanceof WorkAccessHttpFailure)) {
    return { kind: 'LocalPreparationFailed' };
  }
  switch (cause.detail.kind) {
    case 'server-url-invalid':
    case 'grant-secret-invalid':
    case 'request-invalid':
      return { kind: 'LocalPreparationFailed' };
    case 'server-unavailable':
      return { kind: 'ServerUnavailable' };
    case 'server-response-invalid':
      return { kind: 'ServerResponseInvalid' };
    case 'request-rejected':
      return {
        kind: 'ServerRejected',
        code: cause.detail.problem.code,
        correlationId: cause.detail.problem.correlationId,
      };
  }
}
