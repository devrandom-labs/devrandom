import type { WorkAccessScope } from '@devrandom/protocol';

import { workAccessGrantSecretHash } from '../domain/work-access.js';
import type { GrantAuthorization, WorkAccessAttempts } from './work-access-attempts.js';

export async function authorizeWorkAccessGrant(
  input: {
    readonly bearerSecret: string;
    readonly scope: WorkAccessScope;
    readonly observedAt: string;
  },
  attempts: WorkAccessAttempts,
): Promise<GrantAuthorization> {
  let grantSecretHash: string;
  try {
    grantSecretHash = workAccessGrantSecretHash(input.bearerSecret);
  } catch {
    return { kind: 'GrantNotFound' };
  }
  return attempts.authorizeGrant({
    grantSecretHash,
    scope: input.scope,
    observedAt: input.observedAt,
  });
}
