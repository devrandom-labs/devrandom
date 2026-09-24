import {
  connectVerifiedIssuerInfrastructure,
  type CredentialPayloadSchema,
  IdentityFailure,
  type IssuerIdentityVerificationInput,
  type VerifiedIssuerInfrastructure,
} from '@devrandom/identity';
import { credentialSchema } from '@devrandom/protocol';

import {
  issuerProfilePolicyConflict,
  type DevrandomIssuerProfile,
} from '../domain/devrandom-issuer-profile.js';
import {
  devrandomIssuerAlias,
  devrandomRegistryName,
  type IssuerBootstrapConfiguration,
  type IssuerProfilePath,
} from '../domain/issuer-configuration.js';
import { IssuerFailure, type IssuerError } from '../domain/issuer-error.js';
import { VerifiedDevrandomIssuer } from '../domain/verified-devrandom-issuer.js';
import { readDevrandomIssuerProfile } from '../infrastructure/issuer-profile-file.js';

export type IssuerStartupResult =
  | {
      readonly kind: 'issuer-startup-verified';
      readonly issuer: VerifiedDevrandomIssuer;
      readonly infrastructure: VerifiedIssuerInfrastructure;
    }
  | {
      readonly kind: 'issuer-startup-rejected';
      readonly error: IssuerError;
    };

export interface IssuerStartupDependencies {
  readonly readIssuerProfile: (
    path: IssuerProfilePath,
  ) => Promise<DevrandomIssuerProfile | undefined>;
  readonly connectIssuerInfrastructure: (
    input: IssuerIdentityVerificationInput,
    credentialPayloadSchema: CredentialPayloadSchema,
  ) => Promise<VerifiedIssuerInfrastructure>;
}

export const issuerStartupDependencies: IssuerStartupDependencies = {
  readIssuerProfile: readDevrandomIssuerProfile,
  connectIssuerInfrastructure: connectVerifiedIssuerInfrastructure,
};

function verificationInput(
  configuration: IssuerBootstrapConfiguration,
): IssuerIdentityVerificationInput {
  return {
    adminUrl: configuration.keriaAdminUrl,
    bootUrl: configuration.keriaBootUrl,
    bran: configuration.bran,
    securityTier: configuration.securityTier,
    issuerAlias: devrandomIssuerAlias,
    registryName: devrandomRegistryName,
    witnessPolicy: configuration.witnessPolicy,
    registryPolicy: configuration.registryPolicy,
    operationTimeoutMs: configuration.operationTimeoutMs,
    oobiAvailabilityTimeoutMs: configuration.oobiAvailabilityTimeoutMs,
  };
}

function rejected(error: IssuerError): IssuerStartupResult {
  return { kind: 'issuer-startup-rejected', error };
}

export async function startDevrandomIssuer(
  configuration: IssuerBootstrapConfiguration,
  dependencies: IssuerStartupDependencies = issuerStartupDependencies,
): Promise<IssuerStartupResult> {
  try {
    const profile = await dependencies.readIssuerProfile(configuration.profilePath);
    if (profile === undefined) {
      return rejected({ kind: 'issuer-not-bootstrapped' });
    }

    const conflictingPolicy = issuerProfilePolicyConflict(
      profile,
      configuration.securityTier,
      configuration.witnessPolicy,
      configuration.registryPolicy,
    );
    if (conflictingPolicy !== undefined) {
      return rejected({ kind: 'issuer-profile-policy-conflict', field: conflictingPolicy });
    }

    const infrastructure = await dependencies.connectIssuerInfrastructure(
      verificationInput(configuration),
      credentialSchema,
    );
    return {
      kind: 'issuer-startup-verified',
      issuer: VerifiedDevrandomIssuer.fromLiveIdentity(profile, infrastructure.identity),
      infrastructure,
    };
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      return rejected(cause.detail);
    }
    if (cause instanceof IdentityFailure) {
      return rejected({ kind: 'issuer-identity-failed', error: cause.detail });
    }
    return rejected({
      kind: 'unexpected-issuer-failure',
      reason: 'unclassified startup dependency failure',
    });
  }
}
