import type { InitialSpecializationAccepted, Run } from '@devrandom/domain';

export interface RunCommitmentInput {
  readonly ownerAid: string;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly run: Run;
  readonly activation: InitialSpecializationAccepted;
}

export type RunCommitment =
  | { readonly kind: 'RunCommitted'; readonly run: Run }
  | { readonly kind: 'ExistingRun'; readonly run: Run }
  | { readonly kind: 'RunCommandConflict' }
  | { readonly kind: 'ExistingRunRequiresLaterResume'; readonly runId: string }
  | { readonly kind: 'RunAlreadyEnded'; readonly runId: string }
  | { readonly kind: 'InitialHarnessIncumbentConflict' }
  | { readonly kind: 'OwnerRunCapacityExceeded' }
  | { readonly kind: 'GlobalRunCapacityExceeded' }
  | { readonly kind: 'ConcurrentRunAdmission' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type RunInspection =
  | { readonly kind: 'RunFound'; readonly run: Run }
  | { readonly kind: 'RunNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface Runs {
  accept(input: RunCommitmentInput): Promise<RunCommitment>;
  findById(ownerAid: string, runId: string): Promise<RunInspection>;
}
