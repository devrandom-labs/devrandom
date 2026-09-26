import {
  IdentityFailure,
  credentialSaid,
  userAid,
  type IssuerCurrentUserCredentialVerification,
} from '@devrandom/identity';

import type { WorkAccessCredentialVerification } from '../application/work-access-identity.js';

export function issuerWorkAccessCredentialVerification(
  issuerVerification: IssuerCurrentUserCredentialVerification,
): WorkAccessCredentialVerification {
  return {
    async verify(input) {
      try {
        const current = await issuerVerification.verify({
          userAid: userAid(input.userAid),
          credentialSaid: credentialSaid(input.credentialSaid),
        });
        return {
          kind: 'CurrentCredential',
          claims: [...current.eligibilityClaims],
        };
      } catch (cause) {
        if (cause instanceof IdentityFailure && cause.detail.kind === 'credential-invalid') {
          return { kind: 'CredentialRejected' };
        }
        return { kind: 'CredentialUnavailable', dependency: 'KERIA' };
      }
    },
  };
}
