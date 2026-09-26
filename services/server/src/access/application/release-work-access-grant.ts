import { releaseWorkAccessGrant, workAccessGrantSecretHash } from '../domain/work-access.js';
import type { CreateWorkAccessAttemptDependencies } from './create-work-access-attempt.js';
import type { WorkAccessDependency } from './work-access-dependency.js';

export interface ReleaseWorkAccessGrantInput {
  readonly attemptId: string;
  readonly bearerSecret: string;
}

export type ReleaseWorkAccessGrantOutcome =
  | { readonly kind: 'GrantReleased' }
  | { readonly kind: 'CapabilityInvalid' }
  | { readonly kind: 'GrantReleaseConflict' }
  | { readonly kind: 'ConcurrentUpdate' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: WorkAccessDependency };

export async function releaseWorkAccessGrantCapability(
  input: ReleaseWorkAccessGrantInput,
  dependencies: CreateWorkAccessAttemptDependencies,
): Promise<ReleaseWorkAccessGrantOutcome> {
  let grantSecretHash: string;
  try {
    grantSecretHash = workAccessGrantSecretHash(input.bearerSecret);
  } catch {
    return { kind: 'CapabilityInvalid' };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lookup = await dependencies.attempts.retrieveAuthorized(input.attemptId, grantSecretHash);
    if (lookup.kind === 'AttemptNotFound') return { kind: 'CapabilityInvalid' };
    const release = releaseWorkAccessGrant(lookup.stored.attempt, dependencies.now());
    if (release.kind === 'AlreadyInactive') return { kind: 'GrantReleased' };
    if (release.kind === 'ReleaseConflict') return { kind: 'GrantReleaseConflict' };
    const committed = await dependencies.attempts.commit(lookup.stored, release.attempt);
    if (committed.kind === 'AttemptCommitted') return { kind: 'GrantReleased' };
    if (committed.kind !== 'ConcurrentlyModified') return { kind: 'GrantReleaseConflict' };
  }
  return { kind: 'ConcurrentUpdate' };
}
