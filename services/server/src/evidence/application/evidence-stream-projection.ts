import type { EvidenceStream } from '@devrandom/domain';
import type { EvidenceStreamProjection } from '@devrandom/protocol';

export function projectEvidenceStream(stream: EvidenceStream): EvidenceStreamProjection {
  const cursor: EvidenceStreamProjection['cursor'] =
    stream.cursor.kind === 'Genesis'
      ? { kind: 'Empty' }
      : {
          kind: 'Accepted',
          eventCount: stream.cursor.acceptedThrough + 1,
          acceptedThroughSequence: stream.cursor.acceptedThrough,
          chainHeadSaid: stream.cursor.chainHeadSaid,
        };
  const checkpoint: EvidenceStreamProjection['checkpoint'] =
    stream.provisional.kind === 'None'
      ? { kind: 'Absent' }
      : { kind: 'Accepted', checkpointSaid: stream.provisional.checkpointSaid };
  const seal: EvidenceStreamProjection['seal'] =
    stream.seal.kind === 'Open'
      ? { kind: 'Unsealed' }
      : stream.cursor.kind === 'Continued'
        ? {
            kind: 'Sealed',
            sealExchangeSaid: stream.seal.exchangeSaid,
            eventCount: stream.cursor.acceptedThrough + 1,
            finalSequence: stream.cursor.acceptedThrough,
            chainHeadSaid: stream.cursor.chainHeadSaid,
            sealedAt: stream.seal.sealedAt,
          }
        : { kind: 'Unsealed' };
  return {
    version: 1,
    runId: stream.binding.runId,
    evidenceStreamId: stream.binding.streamId,
    cursor,
    checkpoint,
    seal,
  };
}
