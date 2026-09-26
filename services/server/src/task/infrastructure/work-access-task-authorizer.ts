import { authorizeWorkAccessGrant } from '../../access/application/authorize-work-access-grant.js';
import type {
  GrantAuthorization,
  WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import type { TaskAccessAuthorization, TaskAccessAuthorizer } from '../route/task-routes.js';

export function workAccessTaskAuthorizer(attempts: WorkAccessAttempts): TaskAccessAuthorizer {
  return {
    async authorize(input): Promise<TaskAccessAuthorization> {
      let authorization: GrantAuthorization;
      try {
        authorization = await authorizeWorkAccessGrant(input, attempts);
      } catch {
        return { kind: 'TaskAccessUnavailable', dependency: 'HostedMongoDB' };
      }
      switch (authorization.kind) {
        case 'GrantAuthorized':
          return {
            kind: 'TaskAccessAuthorized',
            owner: {
              ownerAid: authorization.stored.attempt.binding.userAid,
              credentialSaid: authorization.stored.attempt.binding.credentialSaid,
            },
          };
        case 'GrantNotFound':
          return { kind: 'TaskAccessInvalid' };
        case 'GrantExpired':
          return { kind: 'TaskAccessExpired' };
        case 'GrantReleased':
          return { kind: 'TaskAccessReleased' };
        case 'GrantRevoked':
          return { kind: 'TaskAccessRevoked', reason: authorization.reason };
        case 'GrantScopeRejected':
          return { kind: 'TaskAccessScopeRejected' };
        case 'GrantAuthorizationConflict':
          return { kind: 'TaskAccessConcurrentUpdate' };
        case 'GrantExhausted':
          return { kind: 'TaskAccessExhausted' };
      }
    },
  };
}
