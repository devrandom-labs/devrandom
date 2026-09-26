/** A scoped vector hit is a lead to an exact raw observation, never authority or provenance. */
export interface ExperienceRetrieval {
  retrieve(input: {
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly sourceInventorySaid: string;
    readonly corpusSaid: string;
    readonly failureQuery: string;
    readonly maximumResults: 3;
  }): Promise<
    | {
        readonly kind: 'Retrieved';
        readonly sources: readonly {
          readonly episodeSaid: string;
          readonly rawEvidenceSaid: string;
          readonly score: number;
        }[];
        readonly queryReceiptSaid: string;
        readonly chargedMicroUsd: number;
      }
    | { readonly kind: 'Denied' | 'Unavailable' | 'IndexNotReady' }
  >;
}

/** Nested exact reads repeat owner, resource and disclosure checks. */
export interface EvidenceReading {
  read(input: {
    readonly taskId: string;
    readonly sourceInventorySaid: string;
    readonly evidenceSaid: string;
    readonly offset: number;
    readonly maximumBytes: number;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly bytes: Uint8Array;
        readonly totalBytes: number;
        readonly sourceSaid: string;
        readonly readReceiptSaid: string;
      }
    | { readonly kind: 'Denied' | 'NotFound' | 'Unavailable' }
  >;
}
