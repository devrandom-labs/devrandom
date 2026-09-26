import type { EvidenceArtifact } from '@devrandom/protocol';

/** Exact owner-scoped Run custody, distinct from analogy-source drill-down. */
export interface RunArtifactReading {
  read(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' }
    | { readonly kind: 'Unavailable' }
  >;
}
