import { describe, expect, it } from 'vitest';

import { prepareEvaluationEvidenceEvent } from './evidence-event.js';
import { decodeEvaluationEvidenceBatch, prepareEvaluationEvidenceBatch } from './evidence-batch.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
function event(sequence: number, predecessor?: string) {
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: id('1'),
    streamId: id('2'),
    originRunId: id('3'),
    taskId: id('4'),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence,
    previous:
      predecessor === undefined
        ? { kind: 'Genesis' }
        : { kind: 'Previous', eventSaid: predecessor },
    occurredAt: '2026-09-26T03:00:00.000Z',
    detail: { kind: 'ArtifactCaptured', artifactSaid: said('r'), custody: 'Public' },
  });
  if (prepared.kind !== 'Prepared') throw new Error('event rejected');
  return prepared.event;
}

describe('evaluation evidence batch', () => {
  it('accepts exactly one native evaluation chain and verifies its SAID', () => {
    const first = event(0);
    const second = event(1, first.d);
    const prepared = prepareEvaluationEvidenceBatch([first, second]);
    if (prepared.kind !== 'Prepared') throw new Error('batch rejected');
    expect(decodeEvaluationEvidenceBatch(prepared.batch, [first, second])).toEqual({
      kind: 'Accepted',
      batch: prepared.batch,
    });
    expect(prepared.batch).not.toHaveProperty('runId');
  });

  it('rejects gaps and cross-evaluation append before persistence', () => {
    const first = event(0);
    expect(prepareEvaluationEvidenceBatch([first, event(2, first.d)])).toEqual({
      kind: 'Rejected',
      reason: 'CausalChainInvalid',
    });
    expect(
      prepareEvaluationEvidenceBatch([first, { ...event(1, first.d), evaluationId: id('4') }]),
    ).toEqual({
      kind: 'Rejected',
      reason: 'EventInvalid',
    });
  });
});
