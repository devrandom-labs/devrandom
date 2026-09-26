import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { prepareEvaluationEvidenceEvent, prepareEvidenceArtifact } from '@devrandom/protocol';

import { HostedEvaluationEvidenceReading } from './hosted-evaluation-evidence-reading.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture() {
  const binding = {
    kind: 'Evaluation' as const,
    evaluationId: randomUUID(),
    evaluationLeaseId: randomUUID(),
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const first = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: binding.phase,
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T10:00:00.000Z',
    detail: { kind: 'TrialStopped', reason: 'Completed' },
  });
  if (first.kind !== 'Prepared') throw new Error(first.reason);
  return { binding, first: first.event };
}

describe('hosted accepted Evaluation evidence reading', () => {
  it('does not accept a claimed page whose event SAID or requested head differs', async () => {
    const { binding, first } = fixture();
    const readEvidencePage = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: binding.evaluationId,
          streamId: binding.evidenceStreamId,
          afterSequence: -1,
          throughSequence: 0,
          throughHeadSaid: first.d,
          events: [
            { ...first, detail: { kind: 'TrialStopped' as const, reason: 'Invalid' as const } },
          ],
        },
      }),
    );
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage,
      readPublicArtifact: vi.fn(),
    });
    expect(await reading.openPrefix({ binding, throughSequence: 0, headSaid: first.d })).toEqual({
      kind: 'Missing',
    });
    expect(readEvidencePage).toHaveBeenCalledOnce();
  });

  it('accepts only a complete exact accepted chain through the requested head', async () => {
    const { binding, first } = fixture();
    const readEvidencePage = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: binding.evaluationId,
          streamId: binding.evidenceStreamId,
          afterSequence: -1,
          throughSequence: 0,
          throughHeadSaid: first.d,
          events: [first],
        },
      }),
    );
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage,
      readPublicArtifact: vi.fn(),
    });
    expect(await reading.openPrefix({ binding, throughSequence: 0, headSaid: first.d })).toEqual({
      kind: 'Acknowledged',
      events: [first],
      throughSequence: 0,
      headSaid: first.d,
    });
  });

  it('rejects substituted public raw bytes even when the host claims they were read', async () => {
    const { binding } = fixture();
    const prepared = prepareEvidenceArtifact(
      new TextEncoder().encode('actual'),
      'application/json',
    );
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage: vi.fn(),
      readPublicArtifact: vi.fn(() =>
        Promise.resolve({
          kind: 'Read' as const,
          artifact: prepared.artifact,
          bytes: new TextEncoder().encode('substituted'),
        }),
      ),
    });
    expect(
      await reading.openPublic({
        evaluationId: binding.evaluationId,
        artifactSaid: prepared.artifact.d,
      }),
    ).toEqual({ kind: 'Missing' });
  });
});
