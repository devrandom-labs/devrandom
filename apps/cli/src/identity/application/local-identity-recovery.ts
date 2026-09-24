import type { SignifyCustody, UserProfile } from '../domain/user-profile.js';

export type LocalIdentityRecovery =
  | { readonly kind: 'create-local-identity' }
  | { readonly kind: 'resume-local-identity'; readonly custody: SignifyCustody }
  | {
      readonly kind: 'recover-local-identity';
      readonly custody: SignifyCustody;
      readonly profile: UserProfile;
    }
  | { readonly kind: 'recovery-required'; readonly reason: 'CustodyUnavailable' };

export function planLocalIdentityRecovery(
  custody: SignifyCustody | undefined,
  profile: UserProfile | undefined,
): LocalIdentityRecovery {
  if (profile !== undefined && custody === undefined) {
    return { kind: 'recovery-required', reason: 'CustodyUnavailable' };
  }
  if (profile !== undefined && custody !== undefined) {
    return { kind: 'recover-local-identity', custody, profile };
  }
  if (custody !== undefined) {
    return { kind: 'resume-local-identity', custody };
  }
  return { kind: 'create-local-identity' };
}
