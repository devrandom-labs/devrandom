import type { Run } from './run.js';

export const runLeasePolicy = Object.freeze({
  leaseSeconds: 45,
  renewalSeconds: 15,
  clientSafetyMarginSeconds: 5,
});

export interface FirstRunLeaseInput {
  readonly incarnationId: string;
  readonly expectedRunVersion: number;
  readonly serverTime: string;
}

export type RunLeaseRenewalInput = FirstRunLeaseInput;

export type FirstRunLeaseAcquisition =
  | { readonly kind: 'Acquired'; readonly run: Run }
  | { readonly kind: 'Equivalent'; readonly run: Run }
  | { readonly kind: 'VersionConflict'; readonly currentVersion: number }
  | {
      readonly kind: 'LeaseConflict';
      readonly incarnationId: string;
      readonly expiresAt: string;
      readonly currentVersion: number;
    }
  | { readonly kind: 'LaterResumeRequired'; readonly expiredAt: string }
  | { readonly kind: 'RunNotPreparing' }
  | { readonly kind: 'ServerTimeInvalid' };

export type RunLeaseRenewal =
  | { readonly kind: 'Renewed'; readonly run: Run }
  | { readonly kind: 'Equivalent'; readonly run: Run }
  | { readonly kind: 'VersionConflict'; readonly currentVersion: number }
  | {
      readonly kind: 'LeaseConflict';
      readonly incarnationId: string;
      readonly expiresAt: string;
      readonly currentVersion: number;
    }
  | { readonly kind: 'LeaseExpired'; readonly expiredAt: string }
  | { readonly kind: 'LeaseNotHeld' }
  | { readonly kind: 'RunNotRenewable' }
  | { readonly kind: 'ServerTimeInvalid' };

function timestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function acquireFirstRunLease(
  run: Run,
  input: FirstRunLeaseInput,
): FirstRunLeaseAcquisition {
  const serverTime = timestamp(input.serverTime);
  if (serverTime === undefined) {
    return { kind: 'ServerTimeInvalid' };
  }
  if (run.lifecycle.kind !== 'Active' || run.lifecycle.phase.kind !== 'Preparing') {
    return { kind: 'RunNotPreparing' };
  }
  if (run.lease.kind === 'Held') {
    const expiry = timestamp(run.lease.expiresAt);
    if (expiry === undefined || expiry <= serverTime) {
      return { kind: 'LaterResumeRequired', expiredAt: run.lease.expiresAt };
    }
    if (
      run.lease.incarnationId === input.incarnationId &&
      run.lease.lastChange.kind === 'Acquired' &&
      run.lease.lastChange.fromRunVersion === input.expectedRunVersion
    ) {
      return { kind: 'Equivalent', run };
    }
    return {
      kind: 'LeaseConflict',
      incarnationId: run.lease.incarnationId,
      expiresAt: run.lease.expiresAt,
      currentVersion: run.version,
    };
  }
  if (run.version !== input.expectedRunVersion) {
    return { kind: 'VersionConflict', currentVersion: run.version };
  }
  const acquiredAt = new Date(serverTime).toISOString();
  const expiresAt = new Date(serverTime + runLeasePolicy.leaseSeconds * 1_000).toISOString();
  return {
    kind: 'Acquired',
    run: {
      ...run,
      version: run.version + 1,
      lease: {
        kind: 'Held',
        incarnationId: input.incarnationId,
        acquiredAt,
        expiresAt,
        lastChange: { kind: 'Acquired', fromRunVersion: input.expectedRunVersion },
      },
    },
  };
}

export function renewRunLease(run: Run, input: RunLeaseRenewalInput): RunLeaseRenewal {
  const serverTime = timestamp(input.serverTime);
  if (serverTime === undefined) {
    return { kind: 'ServerTimeInvalid' };
  }
  if (
    run.lifecycle.kind !== 'Active' ||
    (run.lifecycle.phase.kind !== 'Preparing' && run.lifecycle.phase.kind !== 'Running')
  ) {
    return { kind: 'RunNotRenewable' };
  }
  if (run.lease.kind === 'Unassigned') {
    return { kind: 'LeaseNotHeld' };
  }
  const expiry = timestamp(run.lease.expiresAt);
  if (expiry === undefined || expiry <= serverTime) {
    return { kind: 'LeaseExpired', expiredAt: run.lease.expiresAt };
  }
  if (run.lease.incarnationId !== input.incarnationId) {
    return {
      kind: 'LeaseConflict',
      incarnationId: run.lease.incarnationId,
      expiresAt: run.lease.expiresAt,
      currentVersion: run.version,
    };
  }
  if (
    run.lease.lastChange.kind === 'Renewed' &&
    run.lease.lastChange.fromRunVersion === input.expectedRunVersion
  ) {
    return { kind: 'Equivalent', run };
  }
  if (run.version !== input.expectedRunVersion) {
    return { kind: 'VersionConflict', currentVersion: run.version };
  }
  return {
    kind: 'Renewed',
    run: {
      ...run,
      version: run.version + 1,
      lease: {
        ...run.lease,
        expiresAt: new Date(serverTime + runLeasePolicy.leaseSeconds * 1_000).toISOString(),
        lastChange: { kind: 'Renewed', fromRunVersion: input.expectedRunVersion },
      },
    },
  };
}
