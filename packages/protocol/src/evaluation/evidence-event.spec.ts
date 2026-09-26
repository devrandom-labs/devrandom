import { describe, expect, it } from 'vitest';

import { decodeEvaluationEvidenceEvent, prepareEvaluationEvidenceEvent } from './evidence-event.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

const trial = {
  kind: 'Trial',
  manifestSaid: said('m'),
  arm: 'C2',
  repetition: 1,
  attempt: 1,
};
const event = {
  evaluationId: id('1'),
  streamId: id('2'),
  originRunId: id('3'),
  taskId: id('4'),
  taskRevisionSaid: said('t'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('q'),
  harnessRevisionSaid: said('h'),
  phase: trial,
  sequence: 0,
  previous: { kind: 'Genesis' },
  occurredAt: '2026-09-26T03:00:00.000Z',
  detail: { kind: 'ArtifactCaptured', artifactSaid: said('c'), custody: 'Public' },
};

describe('native evaluation evidence stream', () => {
  it('binds an immutable event to a distinct evaluation and exact trial slot', () => {
    const prepared = prepareEvaluationEvidenceEvent(event);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvaluationEvidenceEvent(prepared.event)).toEqual({
      kind: 'Accepted',
      event: prepared.event,
    });
  });

  it('rejects a Run-shaped alias and a hidden answer in an event', () => {
    expect(prepareEvaluationEvidenceEvent({ ...event, runId: id('4') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(
      prepareEvaluationEvidenceEvent({ ...event, detail: { ...event.detail, answer: 'secret' } }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('rejects a broken chain and a slot not in the frozen schedule', () => {
    expect(prepareEvaluationEvidenceEvent({ ...event, sequence: 1 })).toEqual({
      kind: 'Rejected',
      reason: 'ChainInvalid',
    });
    expect(
      prepareEvaluationEvidenceEvent({ ...event, phase: { ...trial, arm: 'C2', attempt: 2 } }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SlotInvalid',
    });
  });

  it('rejects substitution after SAID creation', () => {
    const prepared = prepareEvaluationEvidenceEvent(event);
    if (prepared.kind !== 'Prepared') throw new Error('event rejected');
    expect(
      decodeEvaluationEvidenceEvent({ ...prepared.event, harnessRevisionSaid: said('z') }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SaidMismatch',
    });
  });
});
