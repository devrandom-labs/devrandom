import type { PublicVerifierReceipt } from '@devrandom/protocol';

/** Reads one public verifier receipt from a sealed, owner-scoped Run checkpoint. */
export interface RunVerifierReceiptReading {
  read(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly receiptSaid: string;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly runId: string;
        readonly evidenceStreamId: string;
        readonly checkpointSaid: string;
        readonly receipt: PublicVerifierReceipt;
      }
    | { readonly kind: 'NotFound' }
    | { readonly kind: 'Unavailable' }
  >;
}
