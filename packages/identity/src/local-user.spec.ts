import { describe, expect, it } from 'vitest';

import { agentAid, userAid } from './keri-identifier.js';
import { verifyUserAgentOobiEvidence } from './local-user.js';

const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const agent = agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');

describe('local user agent OOBI', () => {
  it('accepts the one OOBI binding the exact user and KERIA agent', () => {
    expect(
      verifyUserAgentOobiEvidence(
        { role: 'agent', oobis: [`http://keria.test/oobi/${user}/agent/${agent}`] },
        user,
        agent,
      ),
    ).toBe(`http://keria.test/oobi/${user}/agent/${agent}`);
  });

  it('rejects an OOBI for another endpoint', () => {
    expect(() =>
      verifyUserAgentOobiEvidence(
        { role: 'agent', oobis: [`http://keria.test/oobi/${user}/agent/${user}`] },
        user,
        agent,
      ),
    ).toThrow('expected user and agent');
  });
});
