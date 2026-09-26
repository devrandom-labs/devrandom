import { describe, expect, it } from 'vitest';

import { prepareEvaluationClosure } from './closure.js';
import {
  decodeEvaluationClosureSealPayload,
  evaluationClosureSealExchangeRoute,
  evaluationClosureSealPayload,
  type EvaluationClosureSealPayload,
} from './closure-seal.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

const claim = {
  evaluationId: id('1'),
  evidenceStreamId: id('2'),
  originRunId: id('3'),
  manifestSaid: said('m'),
  acceptedEventCount: 40,
  acceptedHeadSaid: said('h'),
  observationSaids: Array.from({ length: 18 }, (_, index) => said(String.fromCharCode(97 + index))),
  measurementSaids: Array.from({ length: 15 }, (_, index) => said(String.fromCharCode(65 + index))),
  sharedAuditSaid: said('s'),
  armAuditSaids: {
    H1: said('a'),
    C1: said('b'),
    C2: said('c'),
    C3: said('d'),
    H1TaskSearch: said('e'),
  },
  protectedCustodySaid: said('p'),
};

describe('Evaluation closure agent seal', () => {
  it('binds the full evidence claim before the exchange SAID enters the final closure', () => {
    expect(evaluationClosureSealExchangeRoute).toBe('/devrandom/evaluation/closure/1');
    const payload: EvaluationClosureSealPayload = {
      version: 1,
      kind: 'EvaluationClosureSeal',
      claim,
    };
    expect(decodeEvaluationClosureSealPayload(payload)).toEqual({ kind: 'Accepted', payload });
    const closure = prepareEvaluationClosure({ ...claim, agentSealSaid: said('x') });
    expect(closure.kind).toBe('Prepared');
    if (closure.kind !== 'Prepared') return;
    expect(evaluationClosureSealPayload(closure.closure)).toEqual(payload);
    expect(
      decodeEvaluationClosureSealPayload({
        ...payload,
        claim: { ...claim, agentSealSaid: said('x') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('rejects an incomplete set before the agent can seal it', () => {
    const payload = {
      version: 1,
      kind: 'EvaluationClosureSeal',
      claim: { ...claim, observationSaids: [...claim.observationSaids.slice(1), said('b')] },
    };
    expect(decodeEvaluationClosureSealPayload(payload)).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });
});
