import type { EvidenceSealReconciliationBody, EvidenceStreamProjection } from '@devrandom/protocol';

import type { HostedEvidenceFailure } from './evidence-delivery.js';

type PendingEvidenceStream = Omit<EvidenceStreamProjection, 'seal'> & {
  readonly seal: Extract<
    EvidenceStreamProjection['seal'],
    { readonly kind: 'SealExchangePending' }
  >;
};

type SealedEvidenceStream = Omit<EvidenceStreamProjection, 'seal'> & {
  readonly seal: Extract<EvidenceStreamProjection['seal'], { readonly kind: 'Sealed' }>;
};

export type HostedEvidenceSealReconciliation =
  | { readonly kind: 'Pending'; readonly stream: PendingEvidenceStream }
  | { readonly kind: 'Sealed'; readonly stream: SealedEvidenceStream }
  | HostedEvidenceFailure;

export interface HostedEvidenceSeals {
  reconcileSeal(
    runId: string,
    body: EvidenceSealReconciliationBody,
  ): Promise<HostedEvidenceSealReconciliation>;
}
