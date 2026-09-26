import type { RunSuccessorSegment } from '@devrandom/protocol';

/** Exact owner-scoped custody of an immutable Run continuation, never admission. */
export interface RunSuccessorSegments {
  read(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly segmentSaid: string;
  }): Promise<
    | { readonly kind: 'Found'; readonly segment: RunSuccessorSegment }
    | { readonly kind: 'NotFound' | 'Unavailable' }
  >;
}
