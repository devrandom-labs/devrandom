import { authorizeWorkAccessGrant } from '../../access/application/authorize-work-access-grant.js';
import type {
  GrantAuthorization,
  WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import type { RunAccessAuthorization, RunAccessAuthorizer } from '../route/run-routes.js';

export function workAccessRunAuthorizer(attempts: WorkAccessAttempts): RunAccessAuthorizer {
  return {
    async authorize(input): Promise<RunAccessAuthorization> {
      let authorization: GrantAuthorization;
      try {
        authorization = await authorizeWorkAccessGrant(input, attempts);
      } catch {
        return { kind: 'RunAccessUnavailable', dependency: 'HostedMongoDB' };
      }
      switch (authorization.kind) {
        case 'GrantAuthorized':
          return {
            kind: 'RunAccessAuthorized',
            owner: {
              ownerAid: authorization.stored.attempt.binding.userAid,
              credentialSaid: authorization.stored.attempt.binding.credentialSaid,
            },
          };
        case 'GrantNotFound':
          return { kind: 'RunAccessInvalid' };
        case 'GrantExpired':
          return { kind: 'RunAccessExpired' };
        case 'GrantReleased':
          return { kind: 'RunAccessReleased' };
        case 'GrantRevoked':
          return { kind: 'RunAccessRevoked', reason: authorization.reason };
        case 'GrantScopeRejected':
          return { kind: 'RunAccessScopeRejected' };
        case 'GrantAuthorizationConflict':
          return { kind: 'RunAccessConcurrentUpdate' };
        case 'GrantExhausted':
          return { kind: 'RunAccessExhausted' };
      }
    },
  };
}
