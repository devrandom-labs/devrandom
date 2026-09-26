import { exchange as unsignedExchange, ready, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import { activationReceiptExchangeRoute, type ActivationReceiptPayload } from '@devrandom/protocol';

import { issuerAid, personalAgentAid } from './keri-identifier.js';
import {
  matchActivationReceiptExchange,
  signifyIssuerActivationReceiptExchange,
} from './activation-receipt-exchange.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const agent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const payload: ActivationReceiptPayload = {
  version: 1,
  kind: 'ActivationCommitReceipt',
  commandId: '11111111-1111-4111-8111-111111111111',
  commandFingerprint: `sha256:${'a'.repeat(64)}`,
  taskId: '22222222-2222-4222-8222-222222222222',
  taskRevisionSaid: said('t'),
  harnessLineageId: '33333333-3333-4333-8333-333333333333',
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  pointerVersion: 2,
  activeRevisionSaid: said('c'),
  disposition: 'Activated',
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  selectionEvidenceSaid: said('s'),
  exactPromotionMandateSaid: said('a'),
  agentProposalExchangeSaid: said('p'),
  governorDecisionExchangeSaid: said('g'),
};
const [message] = unsignedExchange(
  activationReceiptExchangeRoute,
  payload,
  issuer,
  agent,
  '2026-09-26T06:00:00.000000+00:00',
);
type RetrievedExchange = Awaited<ReturnType<ReturnType<SignifyClient['exchanges']>['get']>>['exn'];
const receiptEvidence = message.sad as unknown as RetrievedExchange;
const expectation = { exchangeSaid: message.said, sourceAid: issuer, recipientAid: agent, payload };

describe('issuer activation receipt exchange', () => {
  it('binds exact payload, issuer source, agent recipient and native SAID', () => {
    expect(matchActivationReceiptExchange(message.sad, expectation)).toMatchObject({
      kind: 'Verified',
    });
    expect(matchActivationReceiptExchange({ ...message.sad, i: agent }, expectation)).toMatchObject(
      { kind: 'Rejected' },
    );
    expect(
      matchActivationReceiptExchange(
        { ...message.sad, a: { i: agent, ...payload, pointerVersion: 3 } },
        expectation,
      ),
    ).toMatchObject({ kind: 'Rejected' });
  });

  it('requires the issuer KERIA exact read; absent and unavailable stay noncommittal', async () => {
    await ready();
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const get = vi.spyOn(client.exchanges(), 'get');
    get.mockResolvedValueOnce({ exn: receiptEvidence, pathed: {} });
    const exchange = signifyIssuerActivationReceiptExchange(client);
    await expect(exchange.inspect(expectation)).resolves.toMatchObject({ kind: 'Verified' });
    get.mockRejectedValueOnce(new Error(`HTTP GET /exchanges/${message.said} - 404 Not Found`));
    await expect(exchange.inspect(expectation)).resolves.toEqual({ kind: 'Pending' });
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(exchange.inspect(expectation)).resolves.toEqual({
      kind: 'Unavailable',
      dependency: 'Keria',
    });
  });
});
