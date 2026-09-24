import { describe, expect, it } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import { userAid } from './keri-identifier.js';
import { verifyResolvedUserOobiEvidence } from './user-oobi.js';

const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const agent = 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs';
const oobi = `http://keria.test/oobi/${user}/agent/${agent}`;

describe('issuer-side user OOBI resolution', () => {
  it('accepts only a completed resolution bound to the OOBI user AID', () => {
    expect(
      verifyResolvedUserOobiEvidence(oobi, user, {
        name: 'oobi.EOperation',
        done: true,
        response: { i: user, d: user, s: '0' },
      }),
    ).toEqual({ userAid: user, agentAid: agent });
  });

  it.each([
    [`http://keria.test/oobi/${agent}/agent/${user}`, { i: user, d: user, s: '0' }],
    [`http://keria.test/oobi/${user}/agent/${agent}?secret=value`, { i: user, d: user, s: '0' }],
    [oobi, { i: agent, d: agent, s: '0' }],
  ])('rejects mismatched OOBI or resolved key state %#', (candidate, response) => {
    try {
      verifyResolvedUserOobiEvidence(candidate, user, {
        name: 'oobi.EOperation',
        done: true,
        response,
      });
      expect.fail('mismatched OOBI evidence was accepted');
    } catch (cause) {
      expect(cause).toBeInstanceOf(IdentityFailure);
      if (cause instanceof IdentityFailure) {
        expect(cause.detail.kind).toBe('user-oobi-invalid');
      }
    }
  });
});
