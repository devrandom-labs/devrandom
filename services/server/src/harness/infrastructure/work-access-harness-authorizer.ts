import { authorizeWorkAccessGrant } from '../../access/application/authorize-work-access-grant.js';
import type {
  GrantAuthorization,
  WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import type {
  HarnessAccessAuthorization,
  HarnessAccessAuthorizer,
} from '../route/harness-routes.js';

export function workAccessHarnessAuthorizer(attempts: WorkAccessAttempts): HarnessAccessAuthorizer {
  return {
    async authorize(input): Promise<HarnessAccessAuthorization> {
      let authorization: GrantAuthorization;
      try {
        authorization = await authorizeWorkAccessGrant(input, attempts);
      } catch {
        return { kind: 'HarnessAccessUnavailable', dependency: 'HostedMongoDB' };
      }
      switch (authorization.kind) {
        case 'GrantAuthorized': {
          const attempt = authorization.stored.attempt;
          if (attempt.state.kind !== 'Granted') {
            return { kind: 'HarnessAccessConcurrentUpdate' };
          }
          return {
            kind: 'HarnessAccessAuthorized',
            owner: {
              ownerAid: attempt.binding.userAid,
              credentialSaid: attempt.binding.credentialSaid,
            },
          };
        }
        case 'GrantNotFound':
          return { kind: 'HarnessAccessInvalid' };
        case 'GrantExpired':
          return { kind: 'HarnessAccessExpired' };
        case 'GrantReleased':
          return { kind: 'HarnessAccessReleased' };
        case 'GrantRevoked':
          return { kind: 'HarnessAccessRevoked', reason: authorization.reason };
        case 'GrantScopeRejected':
          return { kind: 'HarnessAccessScopeRejected' };
        case 'GrantAuthorizationConflict':
          return { kind: 'HarnessAccessConcurrentUpdate' };
        case 'GrantExhausted':
          return { kind: 'HarnessAccessExhausted' };
      }
    },
  };
}
