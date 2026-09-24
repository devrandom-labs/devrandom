import type {
  CurrentUserCustody,
  UserCustodyRecoveryReason,
  UserPrincipal,
} from './user-principal.js';
import type { CurrentUserCredential, UserCredentialInvalidity } from './user-credential.js';

export type IdentityInfrastructureDependency =
  'Issuer' | 'Keria' | 'Witness' | 'RegistrationRepository' | 'Site';

export type UserCredentialReadiness =
  | { readonly kind: 'Current'; readonly credential: CurrentUserCredential }
  | { readonly kind: 'RegistrationRequired' }
  | { readonly kind: 'InvalidCredential'; readonly invalidity: UserCredentialInvalidity }
  | {
      readonly kind: 'InfrastructureUnavailable';
      readonly dependency: IdentityInfrastructureDependency;
    };

export type UserAdmissionEvidence =
  | {
      readonly kind: 'CurrentCustody';
      readonly custody: CurrentUserCustody;
      readonly credential: UserCredentialReadiness;
    }
  | { readonly kind: 'RecoveryRequired'; readonly reason: UserCustodyRecoveryReason }
  | {
      readonly kind: 'InfrastructureUnavailable';
      readonly dependency: IdentityInfrastructureDependency;
    };

const admittedUser = Symbol('AdmittedUser');

export interface AdmittedUser {
  readonly principal: UserPrincipal;
  readonly custody: CurrentUserCustody;
  readonly credential: CurrentUserCredential;
  readonly [admittedUser]: typeof admittedUser;
}

export type UserAdmission =
  | { readonly kind: 'Ready'; readonly user: AdmittedUser }
  | { readonly kind: 'RegistrationRequired'; readonly principal: UserPrincipal }
  | {
      readonly kind: 'InvalidCredential';
      readonly principal: UserPrincipal;
      readonly invalidity: UserCredentialInvalidity;
    }
  | { readonly kind: 'RecoveryRequired'; readonly reason: UserCustodyRecoveryReason }
  | {
      readonly kind: 'InfrastructureUnavailable';
      readonly dependency: IdentityInfrastructureDependency;
    };

export function decideUserAdmission(evidence: UserAdmissionEvidence): UserAdmission {
  if (evidence.kind === 'RecoveryRequired') {
    return evidence;
  }

  if (evidence.kind === 'InfrastructureUnavailable') {
    return evidence;
  }

  const principal = evidence.custody.user;
  if (evidence.credential.kind === 'RegistrationRequired') {
    return { kind: 'RegistrationRequired', principal };
  }

  if (evidence.credential.kind === 'InvalidCredential') {
    return {
      kind: 'InvalidCredential',
      principal,
      invalidity: evidence.credential.invalidity,
    };
  }

  if (evidence.credential.kind === 'InfrastructureUnavailable') {
    return evidence.credential;
  }

  if (evidence.credential.credential.issueeAid !== principal.aid) {
    return {
      kind: 'InvalidCredential',
      principal,
      invalidity: {
        kind: 'UnexpectedIssuee',
        expected: principal.aid,
        actual: evidence.credential.credential.issueeAid,
      },
    };
  }

  const user: AdmittedUser = {
    principal,
    custody: evidence.custody,
    credential: evidence.credential.credential,
    [admittedUser]: admittedUser,
  };

  return { kind: 'Ready', user: Object.freeze(user) };
}
