import { describe, expect, it } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import { verifyIssuerKeyStateEvidence } from './issuer-identity.js';
import { issuerAid } from './keri-identifier.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');

describe('verified issuer readiness', () => {
  it('accepts only one current key state for the exact issuer', () => {
    expect(() => {
      verifyIssuerKeyStateEvidence([{ i: issuer, s: '0' }], issuer);
    }).not.toThrow();
  });

  it.each([
    ['missing', []],
    ['different', [{ i: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs' }]],
    ['ambiguous', [{ i: issuer }, { i: issuer }]],
    ['malformed', { i: issuer }],
  ])('rejects %s issuer key-state evidence', (_label, evidence) => {
    expect(() => {
      verifyIssuerKeyStateEvidence(evidence, issuer);
    }).toThrow(IdentityFailure);
  });
});
