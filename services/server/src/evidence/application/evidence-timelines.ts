import type { EvidenceStream } from '@devrandom/domain';
import type { AcceptedEvidenceEventProjection } from '@devrandom/protocol';

export type EvidenceTimelineReading =
  | {
      readonly kind: 'EvidenceTimelineRead';
      readonly stream: EvidenceStream;
      readonly events: readonly AcceptedEvidenceEventProjection[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'EvidenceTimelineNotStarted';
      readonly runId: string;
      readonly evidenceStreamId: string;
    }
  | { readonly kind: 'EvidenceRunNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceTimelines {
  read(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly evidenceStreamId?: string;
    readonly afterSequence: number | null;
  }): Promise<EvidenceTimelineReading>;
}
