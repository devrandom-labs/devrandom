import type { Run } from '@devrandom/domain';

export type EvidenceRunContextInspection =
  | {
      readonly kind: 'EvidenceRunContextFound';
      readonly run: Run;
      readonly completionConditionIds: readonly string[];
    }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceRunContexts {
  inspect(input: {
    readonly ownerAid: string;
    readonly runId: string;
  }): Promise<EvidenceRunContextInspection>;
}
