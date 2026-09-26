import { authorizeWorkAccessGrant } from '../../access/application/authorize-work-access-grant.js';
import type {
  GrantAuthorization,
  WorkAccessAttempts,
} from '../../access/application/work-access-attempts.js';
import type {
  EvidenceAccessAuthorization,
  EvidenceAccessAuthorizer,
} from '../route/evidence-routes.js';

export function workAccessEvidenceAuthorizer(
  attempts: WorkAccessAttempts,
): EvidenceAccessAuthorizer {
  return {
    async authorize(input): Promise<EvidenceAccessAuthorization> {
      let authorization: GrantAuthorization;
      try {
        authorization = await authorizeWorkAccessGrant(input, attempts);
      } catch {
        return { kind: 'EvidenceAccessUnavailable', dependency: 'HostedMongoDB' };
      }
      switch (authorization.kind) {
        case 'GrantAuthorized':
          return {
            kind: 'EvidenceAccessAuthorized',
            ownerAid: authorization.stored.attempt.binding.userAid,
          };
        case 'GrantNotFound':
          return { kind: 'EvidenceAccessInvalid' };
        case 'GrantExpired':
          return { kind: 'EvidenceAccessExpired' };
        case 'GrantReleased':
          return { kind: 'EvidenceAccessReleased' };
        case 'GrantRevoked':
          return { kind: 'EvidenceAccessRevoked', reason: authorization.reason };
        case 'GrantScopeRejected':
          return { kind: 'EvidenceAccessScopeRejected' };
        case 'GrantAuthorizationConflict':
          return { kind: 'EvidenceAccessConcurrentUpdate' };
        case 'GrantExhausted':
          return { kind: 'EvidenceAccessExhausted' };
      }
    },
  };
}
