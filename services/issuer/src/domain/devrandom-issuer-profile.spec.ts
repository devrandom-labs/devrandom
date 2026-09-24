import { describe, expect, it } from 'vitest';

import { IssuerFailure } from './issuer-error.js';
import { profileDocument } from '../../test/issuer-profile-fixture.js';
import { decodeDevrandomIssuerProfile } from './devrandom-issuer-profile.js';

describe('Devrandom issuer profile', () => {
  it('decodes the complete public identity handoff', () => {
    expect(decodeDevrandomIssuerProfile(profileDocument)).toEqual(profileDocument);
  });

  it('rejects unowned fields so secrets cannot enter the public profile', () => {
    let failure: unknown;
    try {
      decodeDevrandomIssuerProfile({
        ...profileDocument,
        bran: 'this-secret-must-never-be-recorded',
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(IssuerFailure);
    if (!(failure instanceof IssuerFailure)) {
      throw new Error('profile decoder did not return the issuer error contract');
    }
    expect(failure.detail.kind).toBe('issuer-profile-invalid');
  });

  it('rejects a witnessed policy whose threshold cannot be satisfied', () => {
    expect(() =>
      decodeDevrandomIssuerProfile({
        ...profileDocument,
        witnessPolicy: {
          kind: 'witnessed',
          witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
          threshold: 2,
        },
      }),
    ).toThrow(IssuerFailure);
  });

  it('rejects an issuer AID that aliases an operational identity', () => {
    expect(() =>
      decodeDevrandomIssuerProfile({
        ...profileDocument,
        issuerAid: profileDocument.agentAid,
      }),
    ).toThrow(IssuerFailure);
  });
});
