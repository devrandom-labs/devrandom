import { ready, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import { governorAid, issuerAid, personalAgentAid } from './keri-identifier.js';
import { signifyLocalPromotionExchanges } from './local-promotion-exchanges.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const agent = said('A');
const governor = `E${'A'.repeat(42)}B`;

describe('local promotion signing custody', () => {
  it('rejects a personal-agent proposal sent from the Governor alias before any EXN is signed', async () => {
    await ready();
    const client = new SignifyClient('http://127.0.0.1:3901', '0123456789abcdefghijk', Tier.low);
    const get = vi
      .spyOn(client.identifiers(), 'get')
      .mockResolvedValue({ prefix: governor } as Awaited<
        ReturnType<ReturnType<SignifyClient['identifiers']>['get']>
      >);
    const create = vi.spyOn(client.exchanges(), 'createExchangeMessage');
    const sourceAid = personalAgentAid(agent);
    await expect(
      signifyLocalPromotionExchanges(client).prepare({
        kind: 'Proposal',
        senderAlias: 'devrandom-personal-agent',
        sourceAid,
        recipientAid: issuerAid(`E${'A'.repeat(42)}C`),
        preparedAt: 1_790_000_000_000,
        payload: {
          version: 1,
          kind: 'PromotionProposal',
          taskId: '11111111-1111-4111-8111-111111111111',
          taskRevisionSaid: said('t'),
          harnessLineageId: '22222222-2222-4222-8222-222222222222',
          expectedIncumbentRevisionSaid: said('h'),
          expectedPointerVersion: 1,
          hypothesisSaid: said('y'),
          evaluationManifestSaid: said('m'),
          evaluationClosureSaid: said('e'),
          disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: said('s') },
        },
      }),
    ).rejects.toThrow();
    expect(get).toHaveBeenCalledWith('devrandom-personal-agent');
    expect(create).not.toHaveBeenCalled();
    expect(governorAid(governor)).not.toBe(sourceAid);
  });
});
