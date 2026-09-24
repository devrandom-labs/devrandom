import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { verifyChallengeResponseEvidence } from './challenge.js';
import { issuerAid, userAid } from './keri-identifier.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const anotherUser = userAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');
const words = ['alpha', 'bravo', 'charlie'];

function challengeExchange() {
  const exchange = {
    v: 'KERI10JSON000000_',
    t: 'exn',
    d: '',
    i: user,
    rp: issuer,
    p: '',
    dt: '2026-09-24T16:00:00.000000+00:00',
    r: '/challenge/response',
    q: {},
    a: { i: issuer, words },
    e: {},
  };
  const untrusted: unknown = Saider.saidify(exchange)[1];
  if (
    typeof untrusted !== 'object' ||
    untrusted === null ||
    !('d' in untrusted) ||
    typeof untrusted.d !== 'string' ||
    !('v' in untrusted) ||
    typeof untrusted.v !== 'string'
  ) {
    throw new Error('challenge exchange SAID was not produced');
  }
  return { ...exchange, d: untrusted.d, v: untrusted.v };
}

describe('Signify challenge response evidence', () => {
  it('accepts the exact source, recipient, challenge, route, and response SAID', () => {
    const exchange = challengeExchange();

    expect(
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
      }),
    ).toEqual({ responseSaid: exchange.d });
  });

  it.each([
    ['source AID', { sourceAid: anotherUser }],
    ['issuer recipient', { recipientAid: issuerAid(anotherUser) }],
    ['challenge words', { challengeWords: ['different', 'challenge', 'words'] }],
    ['response SAID', { responseSaid: issuer }],
  ])('rejects a mismatched %s', (_label, mismatch) => {
    const exchange = challengeExchange();

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
        ...mismatch,
      }),
    ).toThrow('challenge response');
  });

  it('rejects a different exchange route even when every other value matches', () => {
    const exchange = { ...challengeExchange(), r: '/ipex/grant' };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
      }),
    ).toThrow('challenge response route');
  });

  it('rejects a payload recipient different from the Devrandom issuer', () => {
    const valid = challengeExchange();
    const exchange = { ...valid, a: { ...valid.a, i: anotherUser } };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: valid.d,
      }),
    ).toThrow('challenge response payload recipient');
  });

  it('rejects a response whose content no longer matches its SAID', () => {
    const valid = challengeExchange();
    const exchange = {
      ...valid,
      a: { ...valid.a, words: ['tampered', 'bravo', 'charlie'] },
    };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: exchange.a.words,
        responseSaid: valid.d,
      }),
    ).toThrow('challenge response is not bound by its SAID');
  });
});
