import type { EvidenceArtifact } from '@devrandom/protocol';

/** Parent-only exact read of a sibling C2 Git commit; Task source is unrelated. */
export interface C2WorkflowTreatmentCustody {
  read(input: {
    readonly repositoryDirectory: string;
    readonly parentCommit: string;
    readonly parentTree: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly configuration: EvidenceArtifact;
    readonly implementation: EvidenceArtifact;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly configurationBytes: Uint8Array;
        readonly implementationBytes: Uint8Array;
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}
