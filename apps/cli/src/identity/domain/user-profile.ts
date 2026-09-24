export interface UserIssuerExpectation {
  readonly aid: string;
  readonly oobi: string;
  readonly registryId: string;
  readonly schemaSaid: string;
}

export interface UserWitnessPolicy {
  readonly witnessAids: readonly string[];
  readonly threshold: number;
}

export interface UserReceiptEvidence {
  readonly kelSequence: number;
  readonly currentEventSaid: string;
  readonly receiptIndexes: readonly number[];
}

export interface PendingRegistrationReference {
  readonly kind: 'registration-pending';
  readonly registrationId: string;
  readonly expiresAt: string;
}

export interface IssuedRegistrationReference {
  readonly kind: 'registration-issued';
  readonly registrationId: string;
  readonly expiresAt: string;
  readonly grantSaid: string;
  readonly credentialSaid: string;
  readonly admitPreparedAt: number;
}

export type RegistrationReference = PendingRegistrationReference | IssuedRegistrationReference;

export interface UserCredentialReference {
  readonly credentialSaid: string;
  readonly attributeSaid: string;
  readonly issuerAnchorEventSaid: string;
  readonly issuedAt: string;
}

export interface PendingUserRotation {
  readonly kind: 'rotation-pending';
  readonly priorKelSequence: number;
  readonly priorEventSaid: string;
}

export interface UserProfile {
  readonly version: 1;
  readonly revision: number;
  readonly alias: string;
  readonly controllerAid: string;
  readonly keriaAgentAid: string;
  readonly userAid: string;
  readonly userAgentOobi: string;
  readonly witnessPolicy: UserWitnessPolicy;
  readonly receiptEvidence: UserReceiptEvidence;
  readonly issuer: UserIssuerExpectation;
  readonly credential?: UserCredentialReference;
  readonly registration?: RegistrationReference;
  readonly rotation?: PendingUserRotation;
  readonly provenance: { readonly kind: 'live' };
  readonly custodyReference: 'signify-bran-v1';
}

export interface PendingRegistrationCreation {
  readonly version: 1;
  readonly kind: 'registration-create-pending';
  readonly creationKey: string;
}

export interface ActiveRegistrationSecrets {
  readonly version: 1;
  readonly kind: 'registration-active';
  readonly registrationId: string;
  readonly cliCapability: string;
  readonly browserUrl: string;
  readonly challengeWords: readonly string[];
  readonly issuerAid: string;
  readonly issuerOobi: string;
  readonly expiresAt: string;
  readonly pollIntervalMs: number;
  readonly proof?: PreparedChallengeResponse;
}

export interface PreparedChallengeResponse {
  readonly kind: 'challenge-response-prepared';
  readonly responseSaid: string;
  readonly preparedAt: number;
}

export type RegistrationSecrets = PendingRegistrationCreation | ActiveRegistrationSecrets;

export interface SignifyCustody {
  readonly version: 1;
  readonly bran: string;
}
