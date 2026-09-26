import { describe, expect, it } from 'vitest';

import { decodeEvaluationExecutionBinding } from './execution-binding.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const binding = {
  kind: 'Evaluation',
  taskId: id('1'),
  taskRevisionSaid: said('t'),
  originRunId: id('2'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  harnessRevisionSaid: said('h'),
  evaluationId: id('3'),
  evaluationLeaseId: id('4'),
  evidenceStreamId: id('5'),
  phase: { kind: 'Trial', manifestSaid: said('e'), arm: 'C2', repetition: 1, attempt: 1 },
};

describe('worker relay execution binding', () => {
  it('decodes only the separate evaluation identity and frozen slot', () => {
    expect(decodeEvaluationExecutionBinding(binding)).toEqual({ kind: 'Accepted', binding });
  });

  it('rejects fake Run fields and a second candidate attempt', () => {
    expect(decodeEvaluationExecutionBinding({ ...binding, runId: id('2') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(
      decodeEvaluationExecutionBinding({ ...binding, phase: { ...binding.phase, attempt: 2 } }),
    ).toEqual({ kind: 'Rejected', reason: 'SlotInvalid' });
  });
});
