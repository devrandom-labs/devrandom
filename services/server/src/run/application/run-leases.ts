import type { Run } from '@devrandom/domain';

export interface RunLeaseAcquisitionInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly incarnationId: string;
  readonly expectedRunVersion: number;
  readonly serverTime: string;
}

export type RunLeaseRenewalInput = RunLeaseAcquisitionInput;

export type RunLeaseAcquisition =
  | { readonly kind: 'RunLeaseAcquired'; readonly run: Run }
  | { readonly kind: 'RunLeaseReconciled'; readonly run: Run }
  | { readonly kind: 'RunNotFound' }
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
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type RunLeaseRenewal =
  | { readonly kind: 'RunLeaseRenewed'; readonly run: Run }
  | { readonly kind: 'RunLeaseRenewalReconciled'; readonly run: Run }
  | { readonly kind: 'RunNotFound' }
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

export interface RunLeases {
  acquire(input: RunLeaseAcquisitionInput): Promise<RunLeaseAcquisition>;
  renew(input: RunLeaseRenewalInput): Promise<RunLeaseRenewal>;
}
