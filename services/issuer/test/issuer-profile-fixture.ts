import {
  decodeDevrandomIssuerProfile,
  type DevrandomIssuerProfile,
} from '../src/domain/devrandom-issuer-profile.js';

export const profileDocument = {
  version: 1,
  controllerAid: 'EIFG_uqfr1yN560LoHYHfvPAhxQ5sN6xZZT_E3h7d2tL',
  agentAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  issuerAlias: 'devrandom-issuer',
  registryId: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
  registryName: 'devrandom-credentials',
  issuerOobi:
    'http://keria:3902/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  securityTier: 'low',
  witnessPolicy: { kind: 'unwitnessed' },
  registryPolicy: { kind: 'backerless' },
} as const;

export function issuerProfileFixture(): DevrandomIssuerProfile {
  return decodeDevrandomIssuerProfile(profileDocument);
}
