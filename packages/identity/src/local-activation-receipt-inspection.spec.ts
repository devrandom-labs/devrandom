import { ready, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import { agentAid, controllerAid } from './keri-identifier.js';
import { connectLocalActivationReceiptInspection } from './local-activation-receipt-inspection.js';

describe('local activation receipt read custody', () => {
  it('refuses a changed recovered controller or KERIA agent before exposing receipt inspection', async () => {
    await ready();
    const client = new SignifyClient('http://127.0.0.1:3901', '0123456789abcdefghijk', Tier.low);
    const connectController = vi.fn(() =>
      Promise.resolve({
        client,
        controllerAid: controllerAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz'),
        agentAid: agentAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk'),
        connection: 'existing-controller-connected' as const,
      }),
    );
    await expect(
      connectLocalActivationReceiptInspection(
        {
          adminUrl: 'http://127.0.0.1:3901',
          bootUrl: 'http://127.0.0.1:3903',
          bran: '0123456789abcdefghijk',
          securityTier: 'low',
          expectedControllerAid: controllerAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs'),
          expectedAgentAid: agentAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk'),
        },
        connectController,
      ),
    ).rejects.toThrow();
    expect(connectController).toHaveBeenCalledTimes(1);
  });
});
