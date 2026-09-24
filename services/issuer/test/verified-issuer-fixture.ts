import { VerifiedDevrandomIssuer } from '../src/domain/verified-devrandom-issuer.js';
import { issuerProfileFixture } from './issuer-profile-fixture.js';

export function verifiedIssuerFixture(): VerifiedDevrandomIssuer {
  const profile = issuerProfileFixture();
  return VerifiedDevrandomIssuer.fromLiveIdentity(profile, {
    controllerAid: profile.controllerAid,
    agentAid: profile.agentAid,
    issuerAid: profile.issuerAid,
    registryId: profile.registryId,
    issuerOobi: profile.issuerOobi,
  });
}
