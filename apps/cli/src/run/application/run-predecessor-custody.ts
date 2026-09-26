import type { Run } from '@devrandom/domain';
import type {
  EvidenceArtifact,
  EvidenceEvent,
  EvidenceStreamProjection,
  VerifiedCheckpoint,
} from '@devrandom/protocol';

export interface RunPredecessorCustody {
  readonly checkpoint: VerifiedCheckpoint;
  readonly events: readonly EvidenceEvent[];
  readonly artifacts: readonly {
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }[];
  readonly stream: EvidenceStreamProjection;
}

export interface RunPredecessorReading {
  readPredecessor(input: {
    readonly run: Run;
    readonly stateRoot: string;
    readonly stream: EvidenceStreamProjection;
    readonly events: readonly EvidenceEvent[];
  }):
    | { readonly kind: 'Read'; readonly custody: RunPredecessorCustody }
    | { readonly kind: 'Rejected' | 'Unavailable' };
}
