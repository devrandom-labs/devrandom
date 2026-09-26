/** The trusted parent reads one immutable candidate treatment, never Task source or worker state. */
export interface CandidateTreatmentCustody {
  read(input: {
    readonly repositoryDirectory: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly parentCommit: string;
    readonly parentTree: string;
    readonly arm: 'C1';
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: 'Read'; readonly bytes: Uint8Array }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}
