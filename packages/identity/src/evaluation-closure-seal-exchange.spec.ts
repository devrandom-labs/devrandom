import { exchange as createUnsignedExchange, ready, SignifyClient, Tier } from 'signify-ts';
import Value from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';

import {
  evaluationClosureSealExchangeRoute,
  type EvaluationClosureSealPayload,
} from '@devrandom/protocol';

import {
  evaluationClosureSealExchangeEvidenceSchema,
  signifyIssuerEvaluationClosureSealExchange,
  matchEvaluationClosureSealExchange,
} from './evaluation-closure-seal-exchange.js';
import { issuerAid, personalAgentAid } from './keri-identifier.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const said = (character: string): string => `E${character.repeat(43)}`;
const claim: EvaluationClosureSealPayload['claim'] = {
  evaluationId: 'ea587f9a-410a-4dba-a513-fac592f417b6',
  evidenceStreamId: 'ed39e873-5af1-414b-ae48-3712544921c1',
  originRunId: '97b2da54-a908-4ddc-a7cc-7da0170694a7',
  manifestSaid: said('m'),
  acceptedEventCount: 39,
  acceptedHeadSaid: said('h'),
  observationSaids: Array.from({ length: 18 }, (_, index) => said(String.fromCharCode(65 + index))),
  measurementSaids: Array.from({ length: 15 }, (_, index) => said(String.fromCharCode(97 + index))),
  sharedAuditSaid: said('s'),
  armAuditSaids: {
    H1: said('1'),
    C1: said('2'),
    C2: said('3'),
    C3: said('4'),
    H1TaskSearch: said('5'),
  },
  protectedCustodySaid: said('p'),
};
const payload: EvaluationClosureSealPayload = { version: 1, kind: 'EvaluationClosureSeal', claim };

function evidence() {
  const [message] = createUnsignedExchange(
    evaluationClosureSealExchangeRoute,
    payload,
    personalAgent,
    issuer,
    '2026-09-26T06:00:00.000000+00:00',
  );
  if (!Value.Check(evaluationClosureSealExchangeEvidenceSchema, message.sad))
    throw new Error('Closure exchange fixture rejected');
  return message.sad;
}

const expected = {
  exchangeSaid: evidence().d,
  sourceAid: personalAgent,
  recipientAid: issuer,
  payload,
};

describe('personal-agent Evaluation closure exchange', () => {
  it('binds the exact acyclic claim to sender, recipient, route and native SAID', () => {
    expect(matchEvaluationClosureSealExchange(evidence(), expected)).toEqual({
      kind: 'Verified',
      exchangeSaid: expected.exchangeSaid,
      sourceAid: personalAgent,
      payload,
    });
    expect(
      matchEvaluationClosureSealExchange(
        { ...evidence(), a: { ...evidence().a, claim: { ...claim, acceptedEventCount: 40 } } },
        expected,
      ),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      matchEvaluationClosureSealExchange({ ...evidence(), i: issuer }, expected),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      matchEvaluationClosureSealExchange({ ...evidence(), rp: personalAgent }, expected),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      matchEvaluationClosureSealExchange({ ...evidence(), r: '/ipex/grant' }, expected),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      matchEvaluationClosureSealExchange({ ...evidence(), p: said('x') }, expected),
    ).toMatchObject({ kind: 'Rejected' });
  });

  it('treats only the issuer KERIA exact exchange read as inspected custody', async () => {
    await ready();
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const get = vi.spyOn(client.exchanges(), 'get');
    get.mockResolvedValueOnce({ exn: { ...evidence(), q: {}, e: {} }, pathed: {} });
    const inspector = signifyIssuerEvaluationClosureSealExchange(client);
    await expect(inspector.inspect(expected)).resolves.toMatchObject({ kind: 'Verified' });
    expect(get).toHaveBeenCalledWith(expected.exchangeSaid);
    get.mockRejectedValueOnce(
      new Error(`HTTP GET /exchanges/${expected.exchangeSaid} - 404 Not Found - absent`),
    );
    await expect(inspector.inspect(expected)).resolves.toEqual({ kind: 'Pending' });
  });
});
