import { identityErrorMessage, type IdentityError } from '@devrandom/identity';

export type IssuerConfigurationField =
  | 'DEVRANDOM_ISSUER_BRAN'
  | 'DEVRANDOM_ISSUER_PROFILE_PATH'
  | 'DEVRANDOM_ISSUER_REGISTRY_POLICY'
  | 'DEVRANDOM_ISSUER_WITNESS_POLICY'
  | 'DEVRANDOM_KERIA_ADMIN_URL'
  | 'DEVRANDOM_KERIA_BOOT_URL'
  | 'DEVRANDOM_SIGNIFY_TIER'
  | 'DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS'
  | 'DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS'
  | 'DEVRANDOM_MONGODB_URI'
  | 'DEVRANDOM_REGISTRATION_SITE_URL'
  | 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL'
  | 'HOST'
  | 'PORT';

export type IssuerProfilePolicyField = 'securityTier' | 'witnessPolicy' | 'registryPolicy';

export type IssuerError =
  | {
      readonly kind: 'issuer-configuration-invalid';
      readonly field: IssuerConfigurationField;
      readonly reason: 'missing' | 'invalid';
    }
  | {
      readonly kind: 'issuer-profile-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'issuer-profile-conflict';
      readonly existingIssuerAid: string;
      readonly actualIssuerAid: string;
    }
  | {
      readonly kind: 'issuer-profile-policy-conflict';
      readonly field: IssuerProfilePolicyField;
    }
  | {
      readonly kind: 'issuer-profile-persistence-failed';
      readonly reason: string;
    }
  | {
      readonly kind: 'issuer-server-failed';
      readonly reason: string;
    }
  | { readonly kind: 'issuer-not-bootstrapped' }
  | {
      readonly kind: 'controller-mismatch';
      readonly expectedControllerAid: string;
      readonly actualControllerAid: string;
    }
  | {
      readonly kind: 'agent-mismatch';
      readonly expectedAgentAid: string;
      readonly actualAgentAid: string;
    }
  | {
      readonly kind: 'issuer-mismatch';
      readonly expectedIssuerAid: string;
      readonly actualIssuerAid: string;
    }
  | {
      readonly kind: 'registry-mismatch';
      readonly expectedRegistryId: string;
      readonly actualRegistryId: string;
    }
  | {
      readonly kind: 'issuer-oobi-invalid';
      readonly expectedIssuerOobi: string;
      readonly actualIssuerOobi: string;
    }
  | {
      readonly kind: 'issuer-identity-failed';
      readonly error: IdentityError;
    }
  | {
      readonly kind: 'unexpected-issuer-failure';
      readonly reason: string;
    };

export class IssuerFailure extends Error {
  readonly detail: IssuerError;

  constructor(detail: IssuerError, cause?: unknown) {
    super(issuerErrorMessage(detail), cause === undefined ? undefined : { cause });
    this.name = 'IssuerFailure';
    this.detail = detail;
  }
}

export function issuerErrorMessage(error: IssuerError): string {
  switch (error.kind) {
    case 'issuer-configuration-invalid':
      return `${error.field} is ${error.reason}`;
    case 'issuer-profile-invalid':
      return `issuer profile is invalid: ${error.reason}`;
    case 'issuer-profile-conflict':
      return `issuer profile identifies ${error.existingIssuerAid}, but KERIA identifies ${error.actualIssuerAid}`;
    case 'issuer-profile-policy-conflict':
      return `issuer profile ${error.field} does not match the configured bootstrap policy`;
    case 'issuer-profile-persistence-failed':
      return `issuer profile could not be recorded: ${error.reason}`;
    case 'issuer-server-failed':
      return `issuer server failed: ${error.reason}`;
    case 'issuer-not-bootstrapped':
      return 'Devrandom issuer has not been bootstrapped';
    case 'controller-mismatch':
      return `issuer profile identifies controller ${error.expectedControllerAid}, but KERIA identifies ${error.actualControllerAid}`;
    case 'agent-mismatch':
      return `issuer profile identifies agent ${error.expectedAgentAid}, but KERIA identifies ${error.actualAgentAid}`;
    case 'issuer-mismatch':
      return `issuer profile identifies issuer ${error.expectedIssuerAid}, but KERIA identifies ${error.actualIssuerAid}`;
    case 'registry-mismatch':
      return `issuer profile identifies registry ${error.expectedRegistryId}, but KERIA identifies ${error.actualRegistryId}`;
    case 'issuer-oobi-invalid':
      return `issuer profile identifies OOBI ${error.expectedIssuerOobi}, but KERIA identifies ${error.actualIssuerOobi}`;
    case 'issuer-identity-failed':
      return identityErrorMessage(error.error);
    case 'unexpected-issuer-failure':
      return `issuer lifecycle failed unexpectedly: ${error.reason}`;
  }
}

export function issuerErrorExitCode(error: IssuerError): 2 | 3 | 4 | 5 {
  switch (error.kind) {
    case 'issuer-configuration-invalid':
    case 'issuer-profile-invalid':
      return 2;
    case 'issuer-profile-conflict':
    case 'issuer-profile-policy-conflict':
    case 'issuer-not-bootstrapped':
    case 'controller-mismatch':
    case 'agent-mismatch':
    case 'issuer-mismatch':
    case 'registry-mismatch':
    case 'issuer-oobi-invalid':
      return 3;
    case 'issuer-profile-persistence-failed':
      return 5;
    case 'issuer-server-failed':
    case 'unexpected-issuer-failure':
      return 4;
    case 'issuer-identity-failed':
      switch (error.error.kind) {
        case 'identifier-conflict':
        case 'registry-conflict':
        case 'end-role-conflict':
        case 'controller-state-invalid':
        case 'issuer-oobi-invalid':
        case 'credential-invalid':
        case 'credential-delivery-invalid':
        case 'challenge-response-invalid':
        case 'ipex-evidence-invalid':
        case 'user-identifier-invalid':
        case 'user-oobi-invalid':
          return 3;
        case 'signify-initialization-failed':
        case 'keria-unavailable':
        case 'controller-boot-rejected':
        case 'keria-response-invalid':
        case 'issuer-oobi-unavailable':
        case 'keria-operation-failed':
        case 'keria-operation-timeout':
          return 4;
      }
  }
}
