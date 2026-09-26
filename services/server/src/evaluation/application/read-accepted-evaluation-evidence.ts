import type { EvidenceArtifact, EvaluationEvidenceEvent } from '@devrandom/protocol';

/** Owner-scoped exact read of the hosted accepted Evaluation stream and its public raw custody. */
export interface AcceptedEvaluationEvidenceReading {
  readPage(input: {
    readonly ownerAid: string;
    readonly evaluationId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly throughHeadSaid: string;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly page: {
          readonly version: 1;
          readonly evaluationId: string;
          readonly streamId: string;
          readonly afterSequence: number;
          readonly throughSequence: number;
          readonly throughHeadSaid: string;
          readonly events: readonly EvaluationEvidenceEvent[];
        };
      }
    | { readonly kind: 'Denied' | 'Conflict' | 'Unavailable' }
  >;
  readPublicArtifact(input: {
    readonly ownerAid: string;
    readonly evaluationId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Denied' | 'Missing' | 'Conflict' | 'Unavailable' }
  >;
}
