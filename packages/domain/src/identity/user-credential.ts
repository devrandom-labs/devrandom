export const devrandomUserEligibilityClaims: readonly [
  'CreateAgent',
  'CreateTask',
  'RunPrivateTask',
  'PublishHarness',
  'ReceiveTaskResults',
] = Object.freeze([
  'CreateAgent',
  'CreateTask',
  'RunPrivateTask',
  'PublishHarness',
  'ReceiveTaskResults',
]);

export type DevrandomUserEligibilityClaim = (typeof devrandomUserEligibilityClaims)[number];

export type CredentialSaidBinding = { readonly kind: 'Verified' } | { readonly kind: 'Mismatch' };

export type UserCredentialTelState =
  | { readonly kind: 'Issued' }
  | { readonly kind: 'Revoked'; readonly revokedAt: string }
  | { readonly kind: 'NotIssued' };

export type UserCredentialIssuerAnchor =
  | { readonly kind: 'Anchored'; readonly eventSaid: string }
  | { readonly kind: 'Missing' }
  | { readonly kind: 'Mismatch'; readonly eventSaid: string };

export interface ResolvedCredentialSchema {
  readonly kind: 'Resolved';
  readonly schemaSaid: string;
}

export interface UserCredentialInspection {
  readonly credentialSaid: string;
  readonly attributeSaid: string;
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaSaid: string;
  readonly issuedAt: string;
  readonly verifiedAt: string;
  readonly credentialSaidBinding: CredentialSaidBinding;
  readonly attributeSaidBinding: CredentialSaidBinding;
  readonly schemaDocument: ResolvedCredentialSchema;
  readonly telState: UserCredentialTelState;
  readonly issuerAnchor: UserCredentialIssuerAnchor;
  readonly eligibilityClaims: readonly string[];
}

export interface DevrandomUserCredentialPolicy {
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaSaid: string;
}

const currentUserCredential = Symbol('CurrentUserCredential');

export interface CurrentUserCredential {
  readonly credentialSaid: string;
  readonly attributeSaid: string;
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaSaid: string;
  readonly issuedAt: string;
  readonly verifiedAt: string;
  readonly issuerAnchorEventSaid: string;
  readonly eligibilityClaims: readonly DevrandomUserEligibilityClaim[];
  readonly [currentUserCredential]: typeof currentUserCredential;
}

export type UserCredentialInvalidity =
  | {
      readonly kind: 'UnexpectedIssuer';
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'UnexpectedIssuee';
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'UnexpectedRegistry';
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'UnexpectedSchema';
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly kind: 'CredentialSaidMismatch' }
  | { readonly kind: 'AttributeSaidMismatch' }
  | {
      readonly kind: 'SchemaDocumentMismatch';
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly kind: 'CredentialRevoked'; readonly revokedAt: string }
  | { readonly kind: 'CredentialNotIssued' }
  | { readonly kind: 'IssuerAnchorMissing' }
  | { readonly kind: 'IssuerAnchorMismatch'; readonly eventSaid: string }
  | { readonly kind: 'MissingEligibilityClaim'; readonly claim: DevrandomUserEligibilityClaim }
  | { readonly kind: 'UnexpectedEligibilityClaim'; readonly claim: string }
  | { readonly kind: 'DuplicateEligibilityClaim'; readonly claim: string };

export type UserCredentialVerification =
  | { readonly kind: 'Current'; readonly credential: CurrentUserCredential }
  | { readonly kind: 'InvalidCredential'; readonly invalidity: UserCredentialInvalidity };

function rejectCredential(invalidity: UserCredentialInvalidity): UserCredentialVerification {
  return { kind: 'InvalidCredential', invalidity };
}

export function verifyDevrandomUserCredential(
  policy: DevrandomUserCredentialPolicy,
  inspection: UserCredentialInspection,
): UserCredentialVerification {
  if (inspection.issuerAid !== policy.issuerAid) {
    return rejectCredential({
      kind: 'UnexpectedIssuer',
      expected: policy.issuerAid,
      actual: inspection.issuerAid,
    });
  }

  if (inspection.issueeAid !== policy.issueeAid) {
    return rejectCredential({
      kind: 'UnexpectedIssuee',
      expected: policy.issueeAid,
      actual: inspection.issueeAid,
    });
  }

  if (inspection.registryId !== policy.registryId) {
    return rejectCredential({
      kind: 'UnexpectedRegistry',
      expected: policy.registryId,
      actual: inspection.registryId,
    });
  }

  if (inspection.schemaSaid !== policy.schemaSaid) {
    return rejectCredential({
      kind: 'UnexpectedSchema',
      expected: policy.schemaSaid,
      actual: inspection.schemaSaid,
    });
  }

  if (inspection.credentialSaidBinding.kind === 'Mismatch') {
    return rejectCredential({ kind: 'CredentialSaidMismatch' });
  }

  if (inspection.attributeSaidBinding.kind === 'Mismatch') {
    return rejectCredential({ kind: 'AttributeSaidMismatch' });
  }

  if (inspection.schemaDocument.schemaSaid !== policy.schemaSaid) {
    return rejectCredential({
      kind: 'SchemaDocumentMismatch',
      expected: policy.schemaSaid,
      actual: inspection.schemaDocument.schemaSaid,
    });
  }

  if (inspection.telState.kind === 'Revoked') {
    return rejectCredential({
      kind: 'CredentialRevoked',
      revokedAt: inspection.telState.revokedAt,
    });
  }

  if (inspection.telState.kind === 'NotIssued') {
    return rejectCredential({ kind: 'CredentialNotIssued' });
  }

  if (inspection.issuerAnchor.kind === 'Missing') {
    return rejectCredential({ kind: 'IssuerAnchorMissing' });
  }

  if (inspection.issuerAnchor.kind === 'Mismatch') {
    return rejectCredential({
      kind: 'IssuerAnchorMismatch',
      eventSaid: inspection.issuerAnchor.eventSaid,
    });
  }

  const claims = new Set<string>();
  for (const claim of inspection.eligibilityClaims) {
    if (claims.has(claim)) {
      return rejectCredential({ kind: 'DuplicateEligibilityClaim', claim });
    }
    claims.add(claim);
  }

  for (const claim of devrandomUserEligibilityClaims) {
    if (!claims.has(claim)) {
      return rejectCredential({ kind: 'MissingEligibilityClaim', claim });
    }
  }

  const requiredClaims = new Set<string>(devrandomUserEligibilityClaims);
  for (const claim of claims) {
    if (!requiredClaims.has(claim)) {
      return rejectCredential({ kind: 'UnexpectedEligibilityClaim', claim });
    }
  }

  const credential: CurrentUserCredential = {
    credentialSaid: inspection.credentialSaid,
    attributeSaid: inspection.attributeSaid,
    issuerAid: inspection.issuerAid,
    issueeAid: inspection.issueeAid,
    registryId: inspection.registryId,
    schemaSaid: inspection.schemaSaid,
    issuedAt: inspection.issuedAt,
    verifiedAt: inspection.verifiedAt,
    issuerAnchorEventSaid: inspection.issuerAnchor.eventSaid,
    eligibilityClaims: devrandomUserEligibilityClaims,
    [currentUserCredential]: currentUserCredential,
  };

  return { kind: 'Current', credential: Object.freeze(credential) };
}
