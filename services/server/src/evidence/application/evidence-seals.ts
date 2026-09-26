import type { EvidenceStream, Run } from '@devrandom/domain';
import type { EvidenceSealPayload } from '@devrandom/protocol';

export type EvidenceSealContextInspection =
  | {
      readonly kind: 'EvidenceSealContextFound';
      readonly run: Run;
      readonly stream: EvidenceStream;
    }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceSealContexts {
  inspect(input: {
    readonly ownerAid: string;
    readonly runId: string;
  }): Promise<EvidenceSealContextInspection>;
}

export type EvidenceSealExchangeInspection =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Verified'; readonly exchangeSaid: string }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'SealExchangeMalformed'
        | 'SealExchangeSaidMismatch'
        | 'SealExchangeRouteMismatch'
        | 'SealExchangeSourceMismatch'
        | 'SealExchangeRecipientMismatch'
        | 'SealExchangePayloadMismatch';
    }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

export interface EvidenceSealExchanges {
  inspect(input: {
    readonly exchangeSaid: string;
    readonly sourceAid: string;
    readonly recipientAid: string;
    readonly payload: EvidenceSealPayload;
  }): Promise<EvidenceSealExchangeInspection>;
}

export interface EvidenceSealCommitmentInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly expectedRunVersion: number;
  readonly expectedStreamVersion: number;
  readonly exchangeSaid: string;
  readonly sealedAt: string;
}

export type EvidenceSealCommitment =
  | { readonly kind: 'EvidenceStreamSealed'; readonly stream: EvidenceStream }
  | { readonly kind: 'EvidenceStreamAlreadySealed'; readonly stream: EvidenceStream }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'EvidenceSealConflict' }
  | { readonly kind: 'EvidenceSealCursorIncomplete'; readonly acceptedEventCount: number }
  | { readonly kind: 'EvidenceCursorConcurrentUpdate' }
  | { readonly kind: 'EvidenceSealRejected'; readonly reason: 'CheckpointBindingMismatch' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceSeals {
  commit(input: EvidenceSealCommitmentInput): Promise<EvidenceSealCommitment>;
}
