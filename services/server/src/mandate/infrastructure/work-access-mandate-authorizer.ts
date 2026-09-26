import { authorizeWorkAccessGrant } from '../../access/application/authorize-work-access-grant.js';
import type {
  GrantAuthorization,
  WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import type {
  MandateAccessAuthorization,
  MandateAccessAuthorizer,
} from '../route/mandate-routes.js';

export function workAccessMandateAuthorizer(attempts: WorkAccessAttempts): MandateAccessAuthorizer {
  return {
    async authorize(input): Promise<MandateAccessAuthorization> {
      let authorization: GrantAuthorization;
      try {
        authorization = await authorizeWorkAccessGrant(input, attempts);
      } catch {
        return { kind: 'MandateAccessUnavailable', dependency: 'HostedMongoDB' };
      }
      switch (authorization.kind) {
        case 'GrantAuthorized': {
          const attempt = authorization.stored.attempt;
          if (attempt.state.kind !== 'Granted') {
            return { kind: 'MandateAccessConcurrentUpdate' };
          }
          return {
            kind: 'MandateAccessAuthorized',
            authority: {
              ownerAid: attempt.binding.userAid,
              userCredentialSaid: attempt.binding.credentialSaid,
              grantExpiresAt: attempt.state.expiresAt,
            },
          };
        }
        case 'GrantNotFound':
          return { kind: 'MandateAccessInvalid' };
        case 'GrantExpired':
          return { kind: 'MandateAccessExpired' };
        case 'GrantReleased':
          return { kind: 'MandateAccessReleased' };
        case 'GrantRevoked':
          return { kind: 'MandateAccessRevoked', reason: authorization.reason };
        case 'GrantScopeRejected':
          return { kind: 'MandateAccessScopeRejected' };
        case 'GrantAuthorizationConflict':
          return { kind: 'MandateAccessConcurrentUpdate' };
        case 'GrantExhausted':
          return { kind: 'MandateAccessExhausted' };
      }
    },
  };
}
