import type { VerifiedIssuerIdentity } from '@devrandom/identity';

import type { DevrandomIssuerProfile } from './devrandom-issuer-profile.js';
import { IssuerFailure } from './issuer-error.js';

export class VerifiedDevrandomIssuer {
  readonly profile: DevrandomIssuerProfile;
  readonly identity: VerifiedIssuerIdentity;

  private constructor(profile: DevrandomIssuerProfile, identity: VerifiedIssuerIdentity) {
    this.profile = profile;
    this.identity = identity;
  }

  static fromLiveIdentity(
    profile: DevrandomIssuerProfile,
    identity: VerifiedIssuerIdentity,
  ): VerifiedDevrandomIssuer {
    if (profile.controllerAid !== identity.controllerAid) {
      throw new IssuerFailure({
        kind: 'controller-mismatch',
        expectedControllerAid: profile.controllerAid,
        actualControllerAid: identity.controllerAid,
      });
    }
    if (profile.agentAid !== identity.agentAid) {
      throw new IssuerFailure({
        kind: 'agent-mismatch',
        expectedAgentAid: profile.agentAid,
        actualAgentAid: identity.agentAid,
      });
    }
    if (profile.issuerAid !== identity.issuerAid) {
      throw new IssuerFailure({
        kind: 'issuer-mismatch',
        expectedIssuerAid: profile.issuerAid,
        actualIssuerAid: identity.issuerAid,
      });
    }
    if (profile.registryId !== identity.registryId) {
      throw new IssuerFailure({
        kind: 'registry-mismatch',
        expectedRegistryId: profile.registryId,
        actualRegistryId: identity.registryId,
      });
    }
    if (profile.issuerOobi !== identity.issuerOobi) {
      throw new IssuerFailure({
        kind: 'issuer-oobi-invalid',
        expectedIssuerOobi: profile.issuerOobi,
        actualIssuerOobi: identity.issuerOobi,
      });
    }

    return new VerifiedDevrandomIssuer(profile, identity);
  }
}
