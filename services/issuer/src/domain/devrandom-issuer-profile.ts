import {
  agentAid,
  backerAid,
  controllerAid,
  credentialRegistryId,
  issuerAid,
  issuerOobi,
  witnessAid,
  type AgentAid,
  type BackerAid,
  type ControllerAid,
  type CredentialRegistryId,
  type CredentialRegistryPolicy,
  type IssuerAid,
  type IssuerOobi,
  type IssuerWitnessPolicy,
  type SignifySecurityTier,
  type WitnessAid,
} from '@devrandom/identity';
import Type from 'typebox';
import Value from 'typebox/value';

import { devrandomIssuerAlias, devrandomRegistryName } from './issuer-configuration.js';
import { IssuerFailure, type IssuerProfilePolicyField } from './issuer-error.js';

const aidString = Type.String({ minLength: 1 });

const issuerWitnessPolicySchema = Type.Union([
  Type.Object({ kind: Type.Literal('unwitnessed') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('witnessed'),
      witnessAids: Type.Array(aidString, { minItems: 1, uniqueItems: true }),
      threshold: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const credentialRegistryPolicySchema = Type.Union([
  Type.Object({ kind: Type.Literal('backerless') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('backed'),
      backerAids: Type.Array(aidString, { minItems: 1, uniqueItems: true }),
      threshold: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const securityTierSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('med'),
  Type.Literal('high'),
]);

export const devrandomIssuerProfileSchema = Type.Object(
  {
    version: Type.Literal(1),
    controllerAid: aidString,
    agentAid: aidString,
    issuerAid: aidString,
    issuerAlias: Type.Literal(devrandomIssuerAlias),
    registryId: aidString,
    registryName: Type.Literal(devrandomRegistryName),
    issuerOobi: Type.String({ minLength: 1 }),
    securityTier: securityTierSchema,
    witnessPolicy: issuerWitnessPolicySchema,
    registryPolicy: credentialRegistryPolicySchema,
  },
  { additionalProperties: false },
);

type IssuerProfileDocument = Type.Static<typeof devrandomIssuerProfileSchema>;

export interface DevrandomIssuerProfile {
  readonly version: 1;
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly issuerAid: IssuerAid;
  readonly issuerAlias: typeof devrandomIssuerAlias;
  readonly registryId: CredentialRegistryId;
  readonly registryName: typeof devrandomRegistryName;
  readonly issuerOobi: IssuerOobi;
  readonly securityTier: SignifySecurityTier;
  readonly witnessPolicy: IssuerWitnessPolicy;
  readonly registryPolicy: CredentialRegistryPolicy;
}

function decodeWitnessPolicy(policy: IssuerProfileDocument['witnessPolicy']): IssuerWitnessPolicy {
  switch (policy.kind) {
    case 'unwitnessed':
      return { kind: 'unwitnessed' };
    case 'witnessed': {
      if (policy.threshold > policy.witnessAids.length) {
        throw new IssuerFailure({
          kind: 'issuer-profile-invalid',
          reason: 'witness threshold exceeds the number of witness AIDs',
        });
      }
      const witnessAids: WitnessAid[] = policy.witnessAids.map(witnessAid);
      return { kind: 'witnessed', witnessAids, threshold: policy.threshold };
    }
  }
}

function decodeRegistryPolicy(
  policy: IssuerProfileDocument['registryPolicy'],
): CredentialRegistryPolicy {
  switch (policy.kind) {
    case 'backerless':
      return { kind: 'backerless' };
    case 'backed': {
      if (policy.threshold > policy.backerAids.length) {
        throw new IssuerFailure({
          kind: 'issuer-profile-invalid',
          reason: 'backer threshold exceeds the number of backer AIDs',
        });
      }
      const backerAids: BackerAid[] = policy.backerAids.map(backerAid);
      return { kind: 'backed', backerAids, threshold: policy.threshold };
    }
  }
}

export function decodeDevrandomIssuerProfile(value: unknown): DevrandomIssuerProfile {
  if (!Value.Check(devrandomIssuerProfileSchema, value)) {
    throw new IssuerFailure({
      kind: 'issuer-profile-invalid',
      reason: 'document does not match issuer profile version 1',
    });
  }

  if (
    value.controllerAid === value.agentAid ||
    value.controllerAid === value.issuerAid ||
    value.agentAid === value.issuerAid
  ) {
    throw new IssuerFailure({
      kind: 'issuer-profile-invalid',
      reason: 'controller, agent, and issuer AIDs must be distinct',
    });
  }

  return {
    version: 1,
    controllerAid: controllerAid(value.controllerAid),
    agentAid: agentAid(value.agentAid),
    issuerAid: issuerAid(value.issuerAid),
    issuerAlias: value.issuerAlias,
    registryId: credentialRegistryId(value.registryId),
    registryName: value.registryName,
    issuerOobi: issuerOobi(value.issuerOobi),
    securityTier: value.securityTier,
    witnessPolicy: decodeWitnessPolicy(value.witnessPolicy),
    registryPolicy: decodeRegistryPolicy(value.registryPolicy),
  };
}

export function serializeDevrandomIssuerProfile(profile: DevrandomIssuerProfile): string {
  return `${JSON.stringify(profile, undefined, 2)}\n`;
}

export function sameDevrandomIssuerProfile(
  left: DevrandomIssuerProfile,
  right: DevrandomIssuerProfile,
): boolean {
  return serializeDevrandomIssuerProfile(left) === serializeDevrandomIssuerProfile(right);
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function issuerProfilePolicyConflict(
  profile: DevrandomIssuerProfile,
  securityTier: SignifySecurityTier,
  witnessPolicy: IssuerWitnessPolicy,
  registryPolicy: CredentialRegistryPolicy,
): IssuerProfilePolicyField | undefined {
  if (profile.securityTier !== securityTier) {
    return 'securityTier';
  }

  if (profile.witnessPolicy.kind !== witnessPolicy.kind) {
    return 'witnessPolicy';
  }
  if (
    profile.witnessPolicy.kind === 'witnessed' &&
    witnessPolicy.kind === 'witnessed' &&
    (profile.witnessPolicy.threshold !== witnessPolicy.threshold ||
      !sameOrderedValues(profile.witnessPolicy.witnessAids, witnessPolicy.witnessAids))
  ) {
    return 'witnessPolicy';
  }

  if (profile.registryPolicy.kind !== registryPolicy.kind) {
    return 'registryPolicy';
  }
  if (
    profile.registryPolicy.kind === 'backed' &&
    registryPolicy.kind === 'backed' &&
    (profile.registryPolicy.threshold !== registryPolicy.threshold ||
      !sameOrderedValues(profile.registryPolicy.backerAids, registryPolicy.backerAids))
  ) {
    return 'registryPolicy';
  }

  return undefined;
}
