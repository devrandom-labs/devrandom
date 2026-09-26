import type { AppendEvidenceBatchBody, EvidenceBatchAcknowledgement } from '@devrandom/protocol';

export interface EvidenceBatchCommitmentInput {
  readonly ownerAid: string;
  readonly expectedRunVersion: number;
  readonly commandFingerprint: string;
  readonly body: AppendEvidenceBatchBody;
  readonly receivedAt: string;
}

export type EvidenceBatchCommitment =
  | {
      readonly kind: 'EvidenceBatchAccepted';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
    }
  | {
      readonly kind: 'EvidenceBatchAlreadyAccepted';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
    }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'EvidenceBatchConflict' }
  | { readonly kind: 'EvidenceCheckpointConflict' }
  | {
      readonly kind: 'EvidenceSequenceGap';
      readonly expectedStartingSequence: number;
      readonly receivedStartingSequence: number;
    }
  | { readonly kind: 'EvidenceCursorConcurrentUpdate' }
  | { readonly kind: 'EvidenceStreamSealed' }
  | { readonly kind: 'RunEvidenceQuotaExceeded' }
  | { readonly kind: 'GlobalEvidenceQuotaExceeded' }
  | {
      readonly kind: 'EvidenceBatchRejected';
      readonly reason:
        | 'RunBindingMismatch'
        | 'EventBindingMismatch'
        | 'PredecessorMismatch'
        | 'CheckpointInvalid'
        | 'CheckpointBindingMismatch';
    }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceBatches {
  accept(input: EvidenceBatchCommitmentInput): Promise<EvidenceBatchCommitment>;
}
