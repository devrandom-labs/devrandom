import { exchange as unsignedExchange, ready, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import {
  governorPromotionDecisionExchangeRoute,
  promotionProposalExchangeRoute,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
} from '@devrandom/protocol';

import { governorAid, issuerAid, personalAgentAid } from './keri-identifier.js';
import { signifyIssuerPromotionExchanges } from './promotion-exchange-inspection.js';

const agent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const issuer = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');
const said = (character: string): string => `E${character.repeat(43)}`;
const disposition = { kind: 'RetainIncumbent' as const, selectionEvidenceSaid: said('s') };
const common = {
  taskId: '33333333-3333-4333-8333-333333333333',
  taskRevisionSaid: said('t'),
  harnessLineageId: '44444444-4444-4444-8444-444444444444',
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('c'),
  disposition,
};
const proposal: PromotionProposalPayload = {
  version: 1,
  kind: 'PromotionProposal',
  ...common,
  hypothesisSaid: said('i'),
};
const datetime = '2026-09-26T06:00:00.000000+00:00';
const [proposalExn] = unsignedExchange(
  promotionProposalExchangeRoute,
  proposal,
  agent,
  issuer,
  datetime,
);
const decision: GovernorPromotionDecisionPayload = {
  version: 1,
  kind: 'GovernorPromotionDecision',
  ...common,
  exactPromotionMandateSaid: said('a'),
  agentProposalExchangeSaid: proposalExn.said,
};
const [decisionExn] = unsignedExchange(
  governorPromotionDecisionExchangeRoute,
  decision,
  governor,
  issuer,
  datetime,
);
const expected = {
  proposal: {
    exchangeSaid: proposalExn.said,
    sourceAid: agent,
    recipientAid: issuer,
    payload: proposal,
  },
  decision: {
    exchangeSaid: decisionExn.said,
    sourceAid: governor,
    recipientAid: issuer,
    payload: decision,
  },
};

describe('issuer promotion exchange inspection', () => {
  it('requires both native issuer-KERIA reads and distinct exact signed source bindings', async () => {
    await ready();
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const get = vi.spyOn(client.exchanges(), 'get');
    get.mockImplementation((exchangeSaid) =>
      Promise.resolve({
        exn: exchangeSaid === proposalExn.said ? proposalExn.sad : decisionExn.sad,
        pathed: {},
      }),
    );
    const inspection = signifyIssuerPromotionExchanges(client);
    await expect(inspection.inspect(expected)).resolves.toMatchObject({ kind: 'Verified' });
    expect(get).toHaveBeenCalledWith(proposalExn.said);
    expect(get).toHaveBeenCalledWith(decisionExn.said);
    await expect(
      inspection.inspect({ ...expected, decision: { ...expected.decision, sourceAid: agent } }),
    ).resolves.toMatchObject({ kind: 'Rejected' });
    get.mockImplementationOnce(() =>
      Promise.resolve({
        exn: { ...proposalExn.sad, a: { i: issuer, ...proposal, hypothesisSaid: said('x') } },
        pathed: {},
      }),
    );
    await expect(inspection.inspect(expected)).resolves.toMatchObject({ kind: 'Rejected' });
  });

  it('keeps missing or unavailable KERIA custody out of Verified', async () => {
    await ready();
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const get = vi.spyOn(client.exchanges(), 'get');
    get.mockRejectedValueOnce(new Error(`HTTP GET /exchanges/${proposalExn.said} - 404 Not Found`));
    const inspection = signifyIssuerPromotionExchanges(client);
    await expect(inspection.inspect(expected)).resolves.toEqual({ kind: 'Pending' });
    get.mockRejectedValueOnce(new Error('connection unavailable'));
    await expect(inspection.inspect(expected)).resolves.toEqual({
      kind: 'Unavailable',
      dependency: 'Keria',
    });
  });
});
