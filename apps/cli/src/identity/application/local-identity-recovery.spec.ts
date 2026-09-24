import { describe, expect, it } from 'vitest';

import type { UserProfile } from '../domain/user-profile.js';
import { planLocalIdentityRecovery } from './local-identity-recovery.js';

const custody = { version: 1, bran: '0123456789abcdefghijk' } as const;
const profile = {
  version: 1,
  revision: 0,
  alias: 'devrandom-user',
  controllerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  userAgentOobi:
    'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  witnessPolicy: {
    witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
    threshold: 1,
  },
  receiptEvidence: {
    kelSequence: 0,
    currentEventSaid: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
    receiptIndexes: [0],
  },
  issuer: {
    aid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    oobi: 'http://keria.test/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4/agent/ELSG3CytxWcqG5gYBFcr9_6-cG3j08iC7o21ctXUqSoU',
    registryId: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
    schemaSaid: 'EH0pPEOR9SgXnsMmTJX12mh_H7WMRZxcM9h12GdZRvCQ',
  },
  provenance: { kind: 'live' },
  custodyReference: 'signify-bran-v1',
} satisfies UserProfile;

describe('local identity recovery planning', () => {
  it('requires recovery when a profile has lost custody', () => {
    expect(planLocalIdentityRecovery(undefined, profile)).toEqual({
      kind: 'recovery-required',
      reason: 'CustodyUnavailable',
    });
  });

  it('resumes deterministic provisioning only when custody exists without a profile', () => {
    expect(planLocalIdentityRecovery(custody, undefined)).toEqual({
      kind: 'resume-local-identity',
      custody,
    });
  });

  it('recovers the exact recorded identity when custody and profile coexist', () => {
    expect(planLocalIdentityRecovery(custody, profile)).toEqual({
      kind: 'recover-local-identity',
      custody,
      profile,
    });
  });
});
