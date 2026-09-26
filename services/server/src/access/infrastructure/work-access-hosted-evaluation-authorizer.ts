import type { WorkAccessScope } from '@devrandom/protocol';

import { authorizeWorkAccessGrant } from '../application/authorize-work-access-grant.js';
import type { WorkAccessAttempts } from '../application/work-access-attempts.js';

export function workAccessHostedEvaluationAuthorizer(attempts: WorkAccessAttempts) {
  return {
    async authorize(input: {
      readonly bearerSecret: string;
      readonly scope: WorkAccessScope;
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    > {
      try {
        const authorization = await authorizeWorkAccessGrant(input, attempts);
        if (authorization.kind === 'GrantAuthorized') {
          return {
            kind: 'Authorized',
            ownerAid: authorization.stored.attempt.binding.userAid,
          };
        }
        return authorization.kind === 'GrantAuthorizationConflict'
          ? { kind: 'Unavailable' }
          : { kind: 'Denied' };
      } catch {
        return { kind: 'Unavailable' };
      }
    },
  };
}
