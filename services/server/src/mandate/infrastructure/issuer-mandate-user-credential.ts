import {
  IdentityFailure,
  credentialSaid,
  userAid,
  type IssuerCurrentUserCredentialVerification,
} from '@devrandom/identity';

import type { CurrentMandateUserCredential } from '../application/user-credential.js';

export function issuerMandateUserCredential(
  verification: IssuerCurrentUserCredentialVerification,
): CurrentMandateUserCredential {
  return {
    async verify(input) {
      try {
        await verification.verify({
          userAid: userAid(input.ownerAid),
          credentialSaid: credentialSaid(input.credentialSaid),
        });
        return { kind: 'UserCredentialCurrent' };
      } catch (cause) {
        if (cause instanceof IdentityFailure && cause.detail.kind === 'credential-invalid') {
          return { kind: 'UserCredentialNotCurrent' };
        }
        return { kind: 'DependencyUnavailable', dependency: 'Keria' };
      }
    },
  };
}
