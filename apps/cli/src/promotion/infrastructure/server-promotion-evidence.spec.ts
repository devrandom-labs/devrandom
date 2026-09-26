import { prepareEvaluationEvidenceEvent } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ServerPromotionEvidence } from './server-promotion-evidence.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const binding = {
  kind: 'Evaluation' as const,
  taskId: id('4'),
  taskRevisionSaid: said('t'),
  originRunId: id('3'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('q'),
  harnessRevisionSaid: said('h'),
  evaluationId: id('1'),
  evaluationLeaseId: id('5'),
  evidenceStreamId: id('2'),
  phase: {
    kind: 'Trial' as const,
    manifestSaid: said('m'),
    arm: 'H1TaskSearch' as const,
    repetition: 3 as const,
    attempt: 2 as const,
  },
};

function prefix() {
  const events = [];
  for (let sequence = 0; sequence < 33; sequence += 1) {
    const previous = events.at(-1);
    const prepared = prepareEvaluationEvidenceEvent({
      evaluationId: binding.evaluationId,
      streamId: binding.evidenceStreamId,
      originRunId: binding.originRunId,
      taskId: binding.taskId,
      taskRevisionSaid: binding.taskRevisionSaid,
      personalAgentAid: binding.personalAgentAid,
      taskMandateSaid: binding.taskMandateSaid,
      harnessRevisionSaid: binding.harnessRevisionSaid,
      phase: binding.phase,
      sequence,
      previous:
        previous === undefined
          ? { kind: 'Genesis' as const }
          : { kind: 'Previous' as const, eventSaid: previous.d },
      occurredAt: '2026-09-26T12:00:00.000Z',
      detail: {
        kind: 'ArtifactCaptured' as const,
        artifactSaid: said('x'),
        custody: 'Public' as const,
      },
    });
    if (prepared.kind !== 'Prepared') throw new Error('event fixture');
    events.push(prepared.event);
  }
  return events;
}

describe('hosted accepted Evaluation prefix for local promotion', () => {
  it('reopens every page and rejects a substituted cross-page predecessor before selection', async () => {
    const events = prefix();
    const head = events.at(-1)?.d;
    if (head === undefined) throw new Error('head');
    const readEvidencePage = vi.fn((input: { afterSequence: number }) =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: binding.evaluationId,
          streamId: binding.evidenceStreamId,
          afterSequence: input.afterSequence,
          throughSequence: 32,
          throughHeadSaid: head,
          events: input.afterSequence === -1 ? events.slice(0, 32) : events.slice(32),
        },
      }),
    );
    const server = new ServerPromotionEvidence({
      readEvidencePage,
      readPublicArtifact: () => Promise.resolve({ kind: 'Missing' as const }),
    });
    expect(await server.openPrefix({ binding, throughSequence: 32, headSaid: head })).toEqual({
      kind: 'Acknowledged',
      events,
    });
    expect(readEvidencePage).toHaveBeenCalledTimes(2);
    const missing = new ServerPromotionEvidence({
      readEvidencePage: (input) =>
        readEvidencePage(input).then((result) =>
          input.afterSequence === 31
            ? {
                ...result,
                page: {
                  ...result.page,
                  events: [
                    {
                      ...events[32],
                      previous: { kind: 'Previous' as const, eventSaid: said('z') },
                    },
                  ],
                },
              }
            : result,
        ),
      readPublicArtifact: () => Promise.resolve({ kind: 'Missing' as const }),
    });
    expect(await missing.openPrefix({ binding, throughSequence: 32, headSaid: head })).toEqual({
      kind: 'Missing',
    });
  });
});
