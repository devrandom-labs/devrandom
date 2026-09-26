import type { EvidenceArtifact, EvidenceArtifactAcknowledgement } from '@devrandom/protocol';

export interface EvidenceArtifactAdmissionInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
  readonly receivedAt: string;
}

export type EvidenceArtifactAdmission =
  | {
      readonly kind: 'EvidenceArtifactStored';
      readonly acknowledgement: EvidenceArtifactAcknowledgement;
    }
  | {
      readonly kind: 'EvidenceArtifactAlreadyStored';
      readonly acknowledgement: EvidenceArtifactAcknowledgement;
    }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'EvidenceArtifactConflict' }
  | { readonly kind: 'EvidenceStreamSealed' }
  | { readonly kind: 'RunEvidenceQuotaExceeded' }
  | { readonly kind: 'GlobalEvidenceQuotaExceeded' }
  | { readonly kind: 'EvidenceCursorConcurrentUpdate' }
  | { readonly kind: 'EvidenceArtifactRejected'; readonly reason: 'RunBindingMismatch' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceArtifacts {
  admit(input: EvidenceArtifactAdmissionInput): Promise<EvidenceArtifactAdmission>;
}
