export type EvidenceTimelineCursorDecoding =
  | { readonly kind: 'CursorAccepted'; readonly afterSequence: number }
  | { readonly kind: 'CursorRejected' };

export interface EvidenceTimelineCursor {
  encode(input: {
    readonly evidenceStreamId?: string;
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly afterSequence: number;
  }): string;
  decode(input: {
    readonly evidenceStreamId?: string;
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly cursor: string;
  }): EvidenceTimelineCursorDecoding;
}
