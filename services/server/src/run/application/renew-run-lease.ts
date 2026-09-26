import type { RunLeaseAcquisitionBody, RunLeaseRenewalReceipt } from '@devrandom/protocol';

import type { RunLeases } from './run-leases.js';

export interface RenewRunLeaseDependencies {
  readonly leases: Pick<RunLeases, 'renew'>;
  now(): string;
}

export interface RenewRunLeaseInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly incarnationId: string;
  readonly command: RunLeaseAcquisitionBody;
}

export type RenewRunLeaseOutcome =
  | { readonly kind: 'RunLeaseRenewed'; readonly receipt: RunLeaseRenewalReceipt }
  | { readonly kind: 'RunLeaseRenewalReconciled'; readonly receipt: RunLeaseRenewalReceipt }
  | { readonly kind: 'RunResourceNotFound'; readonly resource: 'Run' }
  | { readonly kind: 'RunVersionConflict'; readonly currentVersion: number }
  | {
      readonly kind: 'RunLeaseConflict';
      readonly incarnationId: string;
      readonly expiresAt: string;
      readonly currentVersion: number;
    }
  | { readonly kind: 'RunLeaseLaterResumeRequired'; readonly expiredAt: string }
  | { readonly kind: 'RunLeaseNotHeld' }
  | { readonly kind: 'RunNotRenewable' }
  | { readonly kind: 'RunLeaseConcurrentUpdate' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

function receipt(
  serverTime: string,
  outcome: Extract<
    Awaited<ReturnType<RunLeases['renew']>>,
    { readonly kind: 'RunLeaseRenewed' | 'RunLeaseRenewalReconciled' }
  >,
): RunLeaseRenewalReceipt | undefined {
  const lease = outcome.run.lease;
  return lease.kind === 'Held'
    ? {
        version: 1,
        runId: outcome.run.binding.runId,
        incarnationId: lease.incarnationId,
        runVersion: outcome.run.version,
        serverTime,
        expiresAt: lease.expiresAt,
      }
    : undefined;
}

export async function renewHeldRunLease(
  input: RenewRunLeaseInput,
  dependencies: RenewRunLeaseDependencies,
): Promise<RenewRunLeaseOutcome> {
  const serverTime = dependencies.now();
  const renewed = await dependencies.leases.renew({
    ownerAid: input.ownerAid,
    runId: input.runId,
    incarnationId: input.incarnationId,
    expectedRunVersion: input.command.expectedRunVersion,
    serverTime,
  });
  if (renewed.kind === 'RunLeaseRenewed' || renewed.kind === 'RunLeaseRenewalReconciled') {
    const accepted = receipt(serverTime, renewed);
    return accepted === undefined
      ? { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }
      : { kind: renewed.kind, receipt: accepted };
  }
  switch (renewed.kind) {
    case 'RunNotFound':
      return { kind: 'RunResourceNotFound', resource: 'Run' };
    case 'RunVersionConflict':
    case 'RunLeaseConflict':
    case 'RunLeaseLaterResumeRequired':
    case 'RunLeaseNotHeld':
    case 'RunNotRenewable':
    case 'RunLeaseConcurrentUpdate':
    case 'DependencyUnavailable':
      return renewed;
  }
}
