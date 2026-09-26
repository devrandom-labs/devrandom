import {
  IdentityFailure,
  credentialSaid,
  userAid,
  type IssuerCurrentUserCredentialVerification,
} from '@devrandom/identity';

import type { CurrentTaskCreationEligibility } from '../application/task-eligibility.js';

export function issuerTaskCreationEligibility(
  issuerVerification: IssuerCurrentUserCredentialVerification,
): CurrentTaskCreationEligibility {
  return {
    async authorize(input) {
      try {
        const current = await issuerVerification.verify({
          userAid: userAid(input.ownerAid),
          credentialSaid: credentialSaid(input.credentialSaid),
        });
        return current.eligibilityClaims.includes('CreateTask')
          ? { kind: 'Eligible' }
          : { kind: 'EligibilityMissing' };
      } catch (cause) {
        if (cause instanceof IdentityFailure && cause.detail.kind === 'credential-invalid') {
          return { kind: 'CredentialNotCurrent' };
        }
        return { kind: 'DependencyUnavailable', dependency: 'Keria' };
      }
    },
  };
}
