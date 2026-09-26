import {
  IdentityFailure,
  provisionIssuerIdentity,
  type IssuerIdentityBootstrapInput,
  type IssuerIdentityBootstrapOutcome,
} from '@devrandom/identity';
import {
  verifyMandateSchemaCatalog,
  type MandateSchemaCatalogVerification,
} from '@devrandom/protocol';

import {
  issuerProfilePolicyConflict,
  sameDevrandomIssuerProfile,
  type DevrandomIssuerProfile,
} from '../domain/devrandom-issuer-profile.js';
import {
  devrandomIssuerAlias,
  devrandomRegistryName,
  type IssuerBootstrapConfiguration,
  type IssuerProfilePath,
} from '../domain/issuer-configuration.js';
import { IssuerFailure, type IssuerError } from '../domain/issuer-error.js';
import {
  readDevrandomIssuerProfile,
  recordDevrandomIssuerProfile,
  type IssuerProfileWriteOutcome,
} from '../infrastructure/issuer-profile-file.js';

export type IssuerBootstrapOutcome =
  | {
      readonly kind: 'issuer-provisioned';
      readonly profile: DevrandomIssuerProfile;
    }
  | {
      readonly kind: 'existing-issuer-verified';
      readonly profile: DevrandomIssuerProfile;
    };

export type IssuerBootstrapResult =
  | IssuerBootstrapOutcome
  | {
      readonly kind: 'issuer-bootstrap-rejected';
      readonly error: IssuerError;
    };

export interface IssuerBootstrapDependencies {
  readonly verifyMandateSchemas: () => MandateSchemaCatalogVerification;
  readonly provisionIssuerIdentity: (
    input: IssuerIdentityBootstrapInput,
  ) => Promise<IssuerIdentityBootstrapOutcome>;
  readonly readIssuerProfile: (
    path: IssuerProfilePath,
  ) => Promise<DevrandomIssuerProfile | undefined>;
  readonly recordIssuerProfile: (
    path: IssuerProfilePath,
    profile: DevrandomIssuerProfile,
  ) => Promise<IssuerProfileWriteOutcome>;
}

export const issuerBootstrapDependencies: IssuerBootstrapDependencies = {
  verifyMandateSchemas: verifyMandateSchemaCatalog,
  provisionIssuerIdentity,
  readIssuerProfile: readDevrandomIssuerProfile,
  recordIssuerProfile: recordDevrandomIssuerProfile,
};

function identityInput(configuration: IssuerBootstrapConfiguration): IssuerIdentityBootstrapInput {
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

function issuerProfile(
  configuration: IssuerBootstrapConfiguration,
  identity: IssuerIdentityBootstrapOutcome['identity'],
): DevrandomIssuerProfile {
  return {
    version: 1,
    controllerAid: identity.controllerAid,
    agentAid: identity.agentAid,
    issuerAid: identity.issuerAid,
    issuerAlias: devrandomIssuerAlias,
    registryId: identity.registryId,
    registryName: devrandomRegistryName,
    issuerOobi: identity.issuerOobi,
    securityTier: configuration.securityTier,
    witnessPolicy: configuration.witnessPolicy,
    registryPolicy: configuration.registryPolicy,
  };
}

function rejected(error: IssuerError): IssuerBootstrapResult {
  return { kind: 'issuer-bootstrap-rejected', error };
}

export async function bootstrapDevrandomIssuer(
  configuration: IssuerBootstrapConfiguration,
  dependencies: IssuerBootstrapDependencies = issuerBootstrapDependencies,
): Promise<IssuerBootstrapResult> {
  try {
    const mandateSchemas = dependencies.verifyMandateSchemas();
    if (mandateSchemas.kind === 'Mismatch') {
      return rejected({
        kind: 'mandate-schema-catalog-invalid',
        schema: mandateSchemas.schema,
        expectedSaid: mandateSchemas.expectedSaid,
      });
    }
    const existingProfile = await dependencies.readIssuerProfile(configuration.profilePath);
    if (existingProfile !== undefined) {
      const conflictingPolicy = issuerProfilePolicyConflict(
        existingProfile,
        configuration.securityTier,
        configuration.witnessPolicy,
        configuration.registryPolicy,
      );
      if (conflictingPolicy !== undefined) {
        return rejected({ kind: 'issuer-profile-policy-conflict', field: conflictingPolicy });
      }
    }

    const identity = await dependencies.provisionIssuerIdentity(identityInput(configuration));
    const profile = issuerProfile(configuration, identity.identity);

    if (existingProfile !== undefined && !sameDevrandomIssuerProfile(existingProfile, profile)) {
      return rejected({
        kind: 'issuer-profile-conflict',
        existingIssuerAid: existingProfile.issuerAid,
        actualIssuerAid: profile.issuerAid,
      });
    }

    const write = await dependencies.recordIssuerProfile(configuration.profilePath, profile);
    switch (write.kind) {
      case 'conflicting-issuer-profile':
        return rejected({
          kind: 'issuer-profile-conflict',
          existingIssuerAid: write.existing.issuerAid,
          actualIssuerAid: profile.issuerAid,
        });
      case 'existing-issuer-profile':
        return { kind: 'existing-issuer-verified', profile };
      case 'issuer-profile-recorded':
        return identity.kind === 'issuer-identity-provisioned'
          ? { kind: 'issuer-provisioned', profile }
          : { kind: 'existing-issuer-verified', profile };
    }
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      return rejected(cause.detail);
    }
    if (cause instanceof IdentityFailure) {
      return rejected({ kind: 'issuer-identity-failed', error: cause.detail });
    }
    return rejected({
      kind: 'unexpected-issuer-failure',
      reason: 'unclassified bootstrap dependency failure',
    });
  }
}
