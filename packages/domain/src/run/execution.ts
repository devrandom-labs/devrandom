import type { Run, RunRepository } from './run.js';

export type RunEvidenceReadiness =
  | { readonly kind: 'Genesis'; readonly streamId: string }
  | {
      readonly kind: 'Continued';
      readonly streamId: string;
      readonly nextSequence: number;
      readonly previousEventSaid: string;
    };

export interface RunExecutionReadiness {
  readonly incarnationId: string;
  readonly leaseObservedAt: string;
  readonly worktree: { readonly repository: RunRepository };
  readonly evidence: RunEvidenceReadiness;
}

export type RunExecutionStart =
  | { readonly kind: 'Started'; readonly run: Run }
  | { readonly kind: 'RunNotPreparing' }
  | { readonly kind: 'LeaseNotHeld' }
  | { readonly kind: 'LeaseBindingConflict' }
  | { readonly kind: 'LeaseObservationInvalid' }
  | { readonly kind: 'LeaseExpired'; readonly expiredAt: string }
  | { readonly kind: 'WorktreeBindingConflict' }
  | { readonly kind: 'EvidenceStreamConflict' }
  | { readonly kind: 'EvidenceNotGenesis' };

function repositoryMatches(left: RunRepository, right: RunRepository): boolean {
  return (
    left.objectFormat === right.objectFormat &&
    left.commit === right.commit &&
    left.tree === right.tree
  );
}

export function startRunExecution(run: Run, readiness: RunExecutionReadiness): RunExecutionStart {
  if (run.lifecycle.kind !== 'Active' || run.lifecycle.phase.kind !== 'Preparing') {
    return { kind: 'RunNotPreparing' };
  }
  if (run.lease.kind !== 'Held') {
    return { kind: 'LeaseNotHeld' };
  }
  if (run.lease.incarnationId !== readiness.incarnationId) {
    return { kind: 'LeaseBindingConflict' };
  }
  const observedAt = Date.parse(readiness.leaseObservedAt);
  const expiresAt = Date.parse(run.lease.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)) {
    return { kind: 'LeaseObservationInvalid' };
  }
  if (expiresAt <= observedAt) {
    return { kind: 'LeaseExpired', expiredAt: run.lease.expiresAt };
  }
  if (!repositoryMatches(run.binding.repository, readiness.worktree.repository)) {
    return { kind: 'WorktreeBindingConflict' };
  }
  if (run.binding.evidenceStreamId !== readiness.evidence.streamId) {
    return { kind: 'EvidenceStreamConflict' };
  }
  if (readiness.evidence.kind !== 'Genesis') {
    return { kind: 'EvidenceNotGenesis' };
  }
  return {
    kind: 'Started',
    run: {
      ...run,
      version: run.version + 1,
      lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
    },
  };
}
