import { Matter, MtrDex, type EventResult, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import { completeSignifyOperation } from './signify-operation.js';

declare const identityValueBrand: unique symbol;

type IdentityValue<Name extends string> = string & {
  readonly [identityValueBrand]: Name;
};

export type ControllerAid = IdentityValue<'ControllerAid'>;
export type AgentAid = IdentityValue<'AgentAid'>;
export type IssuerAid = IdentityValue<'IssuerAid'>;
export type UserAid = IdentityValue<'UserAid'>;
export type WitnessAid = IdentityValue<'WitnessAid'>;
export type BackerAid = IdentityValue<'BackerAid'>;
export type CredentialRegistryId = IdentityValue<'CredentialRegistryId'>;
export type CredentialSchemaId = IdentityValue<'CredentialSchemaId'>;
export type CredentialSaid = IdentityValue<'CredentialSaid'>;
export type ChallengeResponseSaid = IdentityValue<'ChallengeResponseSaid'>;
export type IpexGrantSaid = IdentityValue<'IpexGrantSaid'>;
export type KeyEventSaid = IdentityValue<'KeyEventSaid'>;
export type IssuerOobi = IdentityValue<'IssuerOobi'>;

export type IdentifierWitnessPolicy =
  | { readonly kind: 'unwitnessed' }
  | {
      readonly kind: 'witnessed';
      readonly witnessAids: readonly WitnessAid[];
      readonly threshold: number;
    };

export interface NamedKeriIdentifier {
  readonly alias: string;
  readonly aid: IssuerAid;
}

export type NamedKeriIdentifierOutcome =
  | {
      readonly kind: 'identifier-provisioned';
      readonly identifier: NamedKeriIdentifier;
    }
  | {
      readonly kind: 'existing-identifier-verified';
      readonly identifier: NamedKeriIdentifier;
    };

const aidCodes: ReadonlySet<string> = new Set([
  MtrDex.Ed25519N,
  MtrDex.Ed25519,
  MtrDex.Blake3_256,
  MtrDex.SHA3_256,
  MtrDex.SHA2_256,
  MtrDex.ECDSA_256k1N,
  MtrDex.ECDSA_256k1,
  MtrDex.ECDSA_256r1N,
  MtrDex.ECDSA_256r1,
]);

function keriAid(value: string, purpose: string): string {
  try {
    const material = new Matter({ qb64: value });
    if (material.qb64 !== value || !aidCodes.has(material.code)) {
      throw new Error('value is not an allowed KERI identifier prefix');
    }
    return material.qb64;
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-response-invalid',
        stage: purpose,
        reason: 'value is not a valid KERI AID',
      },
      cause,
    );
  }
}

function contentIdentifier(value: string, purpose: string): string {
  try {
    const material = new Matter({ qb64: value });
    if (material.qb64 !== value || !material.digestive) {
      throw new Error('registry identifier is not self-addressing');
    }
    return material.qb64;
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-response-invalid',
        stage: purpose,
        reason: `${purpose} is not valid self-addressing material`,
      },
      cause,
    );
  }
}

export function controllerAid(value: string): ControllerAid {
  return keriAid(value, 'controller AID') as ControllerAid;
}

export function agentAid(value: string): AgentAid {
  return keriAid(value, 'agent AID') as AgentAid;
}

export function issuerAid(value: string): IssuerAid {
  return keriAid(value, 'issuer AID') as IssuerAid;
}

export function userAid(value: string): UserAid {
  return keriAid(value, 'user AID') as UserAid;
}

export function witnessAid(value: string): WitnessAid {
  return keriAid(value, 'witness AID') as WitnessAid;
}

export function backerAid(value: string): BackerAid {
  return keriAid(value, 'backer AID') as BackerAid;
}

export function credentialRegistryId(value: string): CredentialRegistryId {
  return contentIdentifier(value, 'credential registry identifier') as CredentialRegistryId;
}

export function credentialSchemaId(value: string): CredentialSchemaId {
  return contentIdentifier(value, 'credential schema identifier') as CredentialSchemaId;
}

export function credentialSaid(value: string): CredentialSaid {
  return contentIdentifier(value, 'credential SAID') as CredentialSaid;
}

export function challengeResponseSaid(value: string): ChallengeResponseSaid {
  return contentIdentifier(value, 'challenge response SAID') as ChallengeResponseSaid;
}

export function ipexGrantSaid(value: string): IpexGrantSaid {
  return contentIdentifier(value, 'IPEX grant SAID') as IpexGrantSaid;
}

export function keyEventSaid(value: string): KeyEventSaid {
  return contentIdentifier(value, 'key event SAID') as KeyEventSaid;
}

export function issuerOobi(value: string): IssuerOobi {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('OOBI must be an HTTP URL without credentials');
    }
    return value as IssuerOobi;
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'issuer-oobi-invalid',
        reason: 'value is not an HTTP OOBI URL without credentials, query, or fragment',
      },
      cause,
    );
  }
}

const managedIdentifierSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  prefix: Type.String({ minLength: 1 }),
  state: Type.Object({
    i: Type.String({ minLength: 1 }),
    bt: Type.String({ minLength: 1 }),
    b: Type.Array(Type.String({ minLength: 1 })),
  }),
  windexes: Type.Array(Type.Union([Type.String(), Type.Integer()])),
});

type ManagedIdentifier = Type.Static<typeof managedIdentifierSchema>;

function expectedWitnesses(policy: IdentifierWitnessPolicy): readonly WitnessAid[] {
  switch (policy.kind) {
    case 'unwitnessed':
      return [];
    case 'witnessed':
      return policy.witnessAids;
  }
}

function expectedWitnessThreshold(policy: IdentifierWitnessPolicy): number {
  switch (policy.kind) {
    case 'unwitnessed':
      return 0;
    case 'witnessed':
      return policy.threshold;
  }
}

function verifiedIdentifier(
  candidate: ManagedIdentifier,
  alias: string,
  policy: IdentifierWitnessPolicy,
): NamedKeriIdentifier {
  if (candidate.name !== alias) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: `KERIA returned alias ${candidate.name}`,
    });
  }

  const aid = issuerAid(candidate.prefix);
  if (candidate.state.i !== aid) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: 'identifier state belongs to another AID',
    });
  }

  const witnesses = expectedWitnesses(policy);
  if (
    candidate.state.b.length !== witnesses.length ||
    candidate.state.b.some((value, index) => value !== witnesses[index])
  ) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: 'witness AIDs do not match the configured policy',
    });
  }

  const threshold = Number.parseInt(candidate.state.bt, 16);
  if (threshold !== expectedWitnessThreshold(policy)) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: 'witness threshold does not match the configured policy',
    });
  }

  if (candidate.windexes.length !== witnesses.length) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: 'witness receipts do not match the configured policy',
    });
  }

  return { alias, aid };
}

function namedIdentifierNotFound(cause: unknown, alias: string): boolean {
  const path = `/identifiers/${encodeURIComponent(alias)}`;
  return cause instanceof Error && cause.message.startsWith(`HTTP GET ${path} - 404 `);
}

async function namedIdentifier(
  client: SignifyClient,
  alias: string,
  policy: IdentifierWitnessPolicy,
): Promise<NamedKeriIdentifier | undefined> {
  let untrusted: unknown;
  try {
    untrusted = await client.identifiers().get(alias);
  } catch (cause) {
    if (namedIdentifierNotFound(cause, alias)) {
      return undefined;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'named identifier lookup',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  if (!Value.Check(managedIdentifierSchema, untrusted)) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'named identifier lookup',
      reason: 'response does not contain a valid managed identifier',
    });
  }
  return verifiedIdentifier(untrusted, alias, policy);
}

export async function verifyNamedKeriIdentifier(
  client: SignifyClient,
  alias: string,
  policy: IdentifierWitnessPolicy,
): Promise<NamedKeriIdentifier> {
  const existing = await namedIdentifier(client, alias, policy);
  if (existing === undefined) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias,
      reason: 'named identifier does not exist',
    });
  }
  return existing;
}

export async function provisionNamedKeriIdentifier(
  client: SignifyClient,
  alias: string,
  policy: IdentifierWitnessPolicy,
  operationTimeoutMs: number,
): Promise<NamedKeriIdentifierOutcome> {
  const existing = await namedIdentifier(client, alias, policy);
  if (existing !== undefined) {
    return { kind: 'existing-identifier-verified', identifier: existing };
  }

  let inception: EventResult;
  try {
    inception = await client.identifiers().create(alias, {
      toad: expectedWitnessThreshold(policy),
      wits: [...expectedWitnesses(policy)],
    });
  } catch (cause) {
    const reconciled = await namedIdentifier(client, alias, policy);
    if (reconciled !== undefined) {
      return { kind: 'identifier-provisioned', identifier: reconciled };
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: `identifier ${alias} inception`,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  if (inception.sigs.length === 0) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: `identifier ${alias} inception`,
      reason: 'Signify did not produce an edge signature',
    });
  }

  try {
    await completeSignifyOperation(
      client,
      await inception.op(),
      `identifier ${alias} inception`,
      operationTimeoutMs,
    );
  } catch (cause) {
    const reconciled = await namedIdentifier(client, alias, policy);
    if (reconciled !== undefined) {
      return { kind: 'identifier-provisioned', identifier: reconciled };
    }
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: `identifier ${alias} operation submission`,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  return {
    kind: 'identifier-provisioned',
    identifier: await verifyNamedKeriIdentifier(client, alias, policy),
  };
}
