import { describe, expect, it } from 'vitest';

import type { RunLifecycle } from '../run/run.js';
import {
  acceptEvidenceBatch,
  admitEvidenceArtifact,
  createEvidenceStream,
  sealEvidenceStream,
  type EvidenceStream,
} from './stream.js';

function said(character: string): string {
  return `E${character.repeat(43)}`;
}

function stream(): EvidenceStream {
  const created = createEvidenceStream({
    streamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('b'),
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: said('c'),
    personalAgentAid: said('d'),
    taskMandateSaid: said('e'),
    combinedByteCeiling: 1_048_576,
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture evidence stream must be created');
  }
  return created.stream;
}

const blocked: RunLifecycle = {
  kind: 'Active',
  phase: {
    kind: 'Blocked',
    reason: 'HarnessCompatibilityFailure',
    checkpointSaid: said('p'),
  },
};

describe('evidence stream', () => {
  it('accepts only a bounded contiguous causal batch and retains its checkpoint provisionally', () => {
    const accepted = acceptEvidenceBatch(stream(), {
      batchSaid: said('f'),
      startingSequence: 0,
      endingSequence: 1,
      predecessor: { kind: 'Genesis' },
      eventSaids: [said('g'), said('h')],
      encodedBytes: 2_048,
      checkpoint: {
        kind: 'Present',
        checkpointSaid: said('p'),
        lifecycle: blocked,
        submissionVerification: { kind: 'NotSubmitted' },
      },
    });

    expect(accepted).toMatchObject({
      kind: 'Accepted',
      stream: {
        version: 1,
        cursor: { kind: 'Continued', acceptedThrough: 1, chainHeadSaid: said('h') },
        acceptedEvidenceBytes: 2_048,
        provisional: {
          kind: 'Checkpointed',
          checkpointSaid: said('p'),
          lifecycle: blocked,
        },
        seal: { kind: 'Open' },
      },
    });
  });

  it('rejects a gap, predecessor conflict, oversized batch, or changed checkpoint without mutation', () => {
    const first = acceptEvidenceBatch(stream(), {
      batchSaid: said('f'),
      startingSequence: 0,
      endingSequence: 0,
      predecessor: { kind: 'Genesis' },
      eventSaids: [said('g')],
      encodedBytes: 1_024,
      checkpoint: {
        kind: 'Present',
        checkpointSaid: said('p'),
        lifecycle: blocked,
        submissionVerification: { kind: 'NotSubmitted' },
      },
    });
    if (first.kind !== 'Accepted') {
      throw new Error('fixture first batch must be accepted');
    }
    expect(
      acceptEvidenceBatch(first.stream, {
        batchSaid: said('i'),
        startingSequence: 2,
        endingSequence: 2,
        predecessor: { kind: 'Previous', eventSaid: said('g') },
        eventSaids: [said('j')],
        encodedBytes: 1_024,
        checkpoint: { kind: 'Absent' },
      }),
    ).toEqual({ kind: 'SequenceGap', expectedSequence: 1 });
    expect(
      acceptEvidenceBatch(first.stream, {
        batchSaid: said('i'),
        startingSequence: 1,
        endingSequence: 1,
        predecessor: { kind: 'Previous', eventSaid: said('x') },
        eventSaids: [said('j')],
        encodedBytes: 1_024,
        checkpoint: { kind: 'Absent' },
      }),
    ).toEqual({ kind: 'PredecessorConflict' });
    expect(
      acceptEvidenceBatch(first.stream, {
        batchSaid: said('i'),
        startingSequence: 1,
        endingSequence: 33,
        predecessor: { kind: 'Previous', eventSaid: said('g') },
        eventSaids: Array.from({ length: 33 }, (_value, index) => said(String(index % 10))),
        encodedBytes: 256 * 1_024,
        checkpoint: { kind: 'Absent' },
      }),
    ).toEqual({ kind: 'BatchLimitExceeded' });
    expect(
      acceptEvidenceBatch(first.stream, {
        batchSaid: said('i'),
        startingSequence: 1,
        endingSequence: 1,
        predecessor: { kind: 'Previous', eventSaid: said('g') },
        eventSaids: [said('j')],
        encodedBytes: 1_024,
        checkpoint: {
          kind: 'Present',
          checkpointSaid: said('q'),
          lifecycle: {
            kind: 'Active',
            phase: {
              kind: 'Blocked',
              reason: 'LeaseLost',
              checkpointSaid: said('q'),
            },
          },
          submissionVerification: { kind: 'NotSubmitted' },
        },
      }),
    ).toEqual({ kind: 'CheckpointConflict' });
  });

  it('accounts artifact bytes before batches and seals only the exact final cursor', () => {
    const artifact = admitEvidenceArtifact(stream(), { byteLength: 4_096 });
    if (artifact.kind !== 'Admitted') {
      throw new Error('fixture artifact must be admitted');
    }
    const batch = acceptEvidenceBatch(artifact.stream, {
      batchSaid: said('f'),
      startingSequence: 0,
      endingSequence: 0,
      predecessor: { kind: 'Genesis' },
      eventSaids: [said('g')],
      encodedBytes: 1_024,
      checkpoint: {
        kind: 'Present',
        checkpointSaid: said('p'),
        lifecycle: blocked,
        submissionVerification: { kind: 'NotSubmitted' },
      },
    });
    if (batch.kind !== 'Accepted') {
      throw new Error('fixture batch must be accepted');
    }
    expect(
      sealEvidenceStream(batch.stream, {
        exchangeSaid: said('s'),
        eventCount: 1,
        finalSequence: 0,
        chainHeadSaid: said('z'),
        sealedAt: '2026-09-24T20:00:10.000Z',
      }),
    ).toEqual({ kind: 'CursorConflict' });
    expect(
      sealEvidenceStream(batch.stream, {
        exchangeSaid: said('s'),
        eventCount: 1,
        finalSequence: 0,
        chainHeadSaid: said('g'),
        sealedAt: '2026-09-24T20:00:10.000Z',
      }),
    ).toMatchObject({
      kind: 'Sealed',
      stream: {
        acceptedArtifactBytes: 4_096,
        acceptedEvidenceBytes: 1_024,
        seal: { kind: 'Sealed', exchangeSaid: said('s') },
      },
    });
  });
});
