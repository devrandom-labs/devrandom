import type { RunLeaseAcquisitionBody, RunLeaseProjection } from '@devrandom/protocol';

import type { CurrentMandateUserCredential } from '../../mandate/application/user-credential.js';
import type { AuthenticatedTaskOwner } from '../../task/application/tasks.js';
import type { RunLeases } from './run-leases.js';

export interface AcquireRunLeaseDependencies {
  readonly currentUserCredential: CurrentMandateUserCredential;
  readonly leases: Pick<RunLeases, 'acquire'>;
  now(): string;
}

export interface AcquireRunLeaseInput {
  readonly owner: AuthenticatedTaskOwner;
  readonly runId: string;
  readonly incarnationId: string;
  readonly command: RunLeaseAcquisitionBody;
}

export type AcquireRunLeaseOutcome =
  | { readonly kind: 'RunLeaseAcquired'; readonly projection: RunLeaseProjection }
  | { readonly kind: 'RunLeaseReconciled'; readonly projection: RunLeaseProjection }
  | { readonly kind: 'RunResourceNotFound'; readonly resource: 'Run' }
  | { readonly kind: 'RunVersionConflict'; readonly currentVersion: number }
  | {
      readonly kind: 'RunLeaseConflict';
      readonly incarnationId: string;
      readonly expiresAt: string;
      readonly currentVersion: number;
    }
  | { readonly kind: 'RunLeaseLaterResumeRequired'; readonly expiredAt: string }
  | { readonly kind: 'RunNotPreparing' }
  | { readonly kind: 'RunLeaseConcurrentUpdate' }
  | { readonly kind: 'RunLeaseForbidden'; readonly reason: 'UserCredentialNotCurrent' }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function leaseProjection(
  disposition: 'Acquired' | 'Reconciled',
  serverTime: string,
  outcome: Extract<
    Awaited<ReturnType<RunLeases['acquire']>>,
    { readonly kind: 'RunLeaseAcquired' | 'RunLeaseReconciled' }
  >,
): RunLeaseProjection | undefined {
  return outcome.run.lease.kind === 'Held'
    ? {
        version: 1,
        disposition,
        runId: outcome.run.binding.runId,
        incarnationId: outcome.run.lease.incarnationId,
        runVersion: outcome.run.version,
        serverTime,
        expiresAt: outcome.run.lease.expiresAt,
      }
    : undefined;
}

export async function acquireRunLease(
  input: AcquireRunLeaseInput,
  dependencies: AcquireRunLeaseDependencies,
): Promise<AcquireRunLeaseOutcome> {
  const credential = await dependencies.currentUserCredential.verify(input.owner);
  if (credential.kind === 'DependencyUnavailable') {
    return credential;
  }
  if (credential.kind === 'UserCredentialNotCurrent') {
    return { kind: 'RunLeaseForbidden', reason: 'UserCredentialNotCurrent' };
  }
  const serverTime = dependencies.now();
  const acquired = await dependencies.leases.acquire({
    ownerAid: input.owner.ownerAid,
    runId: input.runId,
    incarnationId: input.incarnationId,
    expectedRunVersion: input.command.expectedRunVersion,
    serverTime,
  });
  if (acquired.kind === 'RunLeaseAcquired' || acquired.kind === 'RunLeaseReconciled') {
    const projection = leaseProjection(
      acquired.kind === 'RunLeaseAcquired' ? 'Acquired' : 'Reconciled',
      serverTime,
      acquired,
    );
    return projection === undefined
      ? { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }
      : { kind: acquired.kind, projection };
  }
  switch (acquired.kind) {
    case 'RunNotFound':
      return { kind: 'RunResourceNotFound', resource: 'Run' };
    case 'RunVersionConflict':
    case 'RunLeaseConflict':
    case 'RunLeaseLaterResumeRequired':
    case 'RunNotPreparing':
    case 'RunLeaseConcurrentUpdate':
    case 'DependencyUnavailable':
      return acquired;
  }
}
