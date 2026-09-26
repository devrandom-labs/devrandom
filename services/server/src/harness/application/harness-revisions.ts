import type { BaselineHarnessProjection } from '@devrandom/protocol';
import type { InitialSpecializationActivation } from '@devrandom/domain';

export type HarnessRevisionReconciliation =
  | { readonly kind: 'NoHarnessRevision' }
  | {
      readonly kind: 'ExistingHarnessRevision';
      readonly projection: BaselineHarnessProjection;
    }
  | { readonly kind: 'HarnessCommandConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type HarnessRevisionCreation =
  | { readonly kind: 'HarnessRevisionCreated' }
  | {
      readonly kind: 'ExistingHarnessRevision';
      readonly projection: BaselineHarnessProjection;
    }
  | { readonly kind: 'HarnessCommandConflict' }
  | { readonly kind: 'HarnessLineageConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type HarnessRevisionInspection =
  | {
      readonly kind: 'AcceptedHarnessFound';
      readonly projection: BaselineHarnessProjection;
      readonly activation: InitialSpecializationActivation;
    }
  | { readonly kind: 'HarnessNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface HarnessRevisions {
  reconcile(
    ownerAid: string,
    commandId: string,
    commandFingerprint: string,
  ): Promise<HarnessRevisionReconciliation>;
  create(input: {
    readonly projection: BaselineHarnessProjection;
    readonly commandFingerprint: string;
  }): Promise<HarnessRevisionCreation>;
  findAccepted(ownerAid: string, harnessRevisionSaid: string): Promise<HarnessRevisionInspection>;
}
