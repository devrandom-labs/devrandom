import { describe, expect, it } from 'vitest';

import { decodeEvaluationClosure, prepareEvaluationClosure } from './closure.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const input = {
  evaluationId: id('1'),
  evidenceStreamId: id('2'),
  originRunId: id('3'),
  manifestSaid: said('m'),
  evidenceIndexSaid: said('i'),
  acceptedEventCount: 42,
  acceptedHeadSaid: said('h'),
  observationSaids: Array.from({ length: 18 }, (_, index) => said(String.fromCharCode(65 + index))),
  measurementSaids: Array.from({ length: 15 }, (_, index) => said(String.fromCharCode(97 + index))),
  sharedAuditSaid: said('u'),
  armAuditSaids: {
    H1: said('v'),
    C1: said('w'),
    C2: said('x'),
    C3: said('y'),
    H1TaskSearch: said('z'),
  },
  protectedCustodySaid: said('c'),
  agentSealSaid: said('s'),
};

describe('evidence-only evaluation closure', () => {
  it('binds the entire required set outside the event chain without selecting a winner', () => {
    const prepared = prepareEvaluationClosure(input);
    if (prepared.kind !== 'Prepared') throw new Error('closure rejected');
    expect(decodeEvaluationClosure(prepared.closure)).toEqual({
      kind: 'Accepted',
      closure: prepared.closure,
    });
    expect(prepared.closure).not.toHaveProperty('winner');
    expect(prepared.closure).not.toHaveProperty('activeRevisionSaid');
  });

  it('rejects missing and duplicated observations, and mutable activation claims', () => {
    expect(
      prepareEvaluationClosure({ ...input, observationSaids: input.observationSaids.slice(1) }),
    ).toEqual({ kind: 'Rejected', reason: 'RequiredSetIncomplete' });
    expect(
      prepareEvaluationClosure({ ...input, measurementSaids: Array(15).fill(said('a')) }),
    ).toEqual({ kind: 'Rejected', reason: 'RequiredSetIncomplete' });
    expect(prepareEvaluationClosure({ ...input, activeRevisionSaid: said('q') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareEvaluationClosure({ ...input, evidenceIndexSaid: undefined })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });
});
