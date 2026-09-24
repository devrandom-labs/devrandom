import { TraitDex, type RegistryResult, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  backerAid,
  credentialRegistryId,
  type BackerAid,
  type CredentialRegistryId,
  type IssuerAid,
} from './keri-identifier.js';
import { completeSignifyOperation } from './signify-operation.js';

export type CredentialRegistryPolicy =
  | { readonly kind: 'backerless' }
  | {
      readonly kind: 'backed';
      readonly backerAids: readonly BackerAid[];
      readonly threshold: number;
    };

export interface NamedCredentialRegistry {
  readonly name: string;
  readonly id: CredentialRegistryId;
  readonly issuerAid: IssuerAid;
}

export type CredentialRegistryOutcome =
  | {
      readonly kind: 'credential-registry-provisioned';
      readonly registry: NamedCredentialRegistry;
    }
  | {
      readonly kind: 'existing-credential-registry-verified';
      readonly registry: NamedCredentialRegistry;
    };

const registryStateSchema = Type.Object({
  i: Type.String({ minLength: 1 }),
  ii: Type.String({ minLength: 1 }),
  c: Type.Array(Type.String()),
  bt: Type.String({ minLength: 1 }),
  b: Type.Array(Type.String({ minLength: 1 })),
});

const listedRegistrySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  regk: Type.String({ minLength: 1 }),
  pre: Type.String({ minLength: 1 }),
  state: registryStateSchema,
});

const registryListSchema = Type.Array(listedRegistrySchema);

const registryInceptionSchema = Type.Object({
  t: Type.Literal('vcp'),
  d: Type.String({ minLength: 1 }),
  i: Type.String({ minLength: 1 }),
  ii: Type.String({ minLength: 1 }),
  c: Type.Array(Type.String()),
  bt: Type.String({ minLength: 1 }),
  b: Type.Array(Type.String({ minLength: 1 })),
});

const registrySerderSchema = Type.Object({ sad: registryInceptionSchema });

type ListedRegistry = Type.Static<typeof listedRegistrySchema>;
type RegistryState = Type.Static<typeof registryStateSchema>;

function expectedBackers(policy: CredentialRegistryPolicy): readonly BackerAid[] {
  switch (policy.kind) {
    case 'backerless':
      return [];
    case 'backed':
      return policy.backerAids;
  }
}

function expectedBackerThreshold(policy: CredentialRegistryPolicy): number {
  switch (policy.kind) {
    case 'backerless':
      return 0;
    case 'backed':
      return policy.threshold;
  }
}

function verifyRegistryPolicy(
  state: RegistryState,
  name: string,
  issuer: IssuerAid,
  policy: CredentialRegistryPolicy,
): CredentialRegistryId {
  const id = credentialRegistryId(state.i);
  if (state.ii !== issuer) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry is not bound to the expected issuer',
    });
  }

  const backers = expectedBackers(policy);
  const actualBackers = state.b.map(backerAid);
  if (
    actualBackers.length !== backers.length ||
    actualBackers.some((value, index) => value !== backers[index])
  ) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry backers do not match the configured policy',
    });
  }

  if (Number.parseInt(state.bt, 16) !== expectedBackerThreshold(policy)) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry backer threshold does not match the configured policy',
    });
  }

  const noBackers = state.c.includes(TraitDex.NoBackers);
  if ((policy.kind === 'backerless') !== noBackers) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry backer trait does not match the configured policy',
    });
  }

  return id;
}

function verifiedRegistry(
  candidate: ListedRegistry,
  name: string,
  issuer: IssuerAid,
  policy: CredentialRegistryPolicy,
): NamedCredentialRegistry {
  if (candidate.name !== name || candidate.pre !== issuer || candidate.state.i !== candidate.regk) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry name, owner, and identifier are inconsistent',
    });
  }

  const id = verifyRegistryPolicy(candidate.state, name, issuer, policy);
  if (id !== candidate.regk) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry record does not match its inception state',
    });
  }

  return { name, id, issuerAid: issuer };
}

async function registries(
  client: SignifyClient,
  issuerAlias: string,
): Promise<readonly ListedRegistry[]> {
  let untrusted: unknown;
  try {
    untrusted = await client.registries().list(issuerAlias);
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'credential registry listing',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  if (!Value.Check(registryListSchema, untrusted)) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'credential registry listing',
      reason: 'response does not contain complete registry state',
    });
  }
  return untrusted;
}

async function namedRegistry(
  client: SignifyClient,
  issuerAlias: string,
  issuer: IssuerAid,
  name: string,
  policy: CredentialRegistryPolicy,
): Promise<NamedCredentialRegistry | undefined> {
  const matches = (await registries(client, issuerAlias)).filter(
    (candidate) => candidate.name === name,
  );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'more than one registry uses this name',
    });
  }
  const match = matches[0];
  if (match === undefined) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'credential registry listing',
      reason: 'registry match disappeared during validation',
    });
  }
  return verifiedRegistry(match, name, issuer, policy);
}

export async function verifyNamedCredentialRegistry(
  client: SignifyClient,
  issuerAlias: string,
  issuer: IssuerAid,
  name: string,
  policy: CredentialRegistryPolicy,
): Promise<NamedCredentialRegistry> {
  const existing = await namedRegistry(client, issuerAlias, issuer, name, policy);
  if (existing === undefined) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'named registry does not exist',
    });
  }
  return existing;
}

export async function provisionNamedCredentialRegistry(
  client: SignifyClient,
  issuerAlias: string,
  issuer: IssuerAid,
  name: string,
  policy: CredentialRegistryPolicy,
  operationTimeoutMs: number,
): Promise<CredentialRegistryOutcome> {
  const existing = await namedRegistry(client, issuerAlias, issuer, name, policy);
  if (existing !== undefined) {
    return { kind: 'existing-credential-registry-verified', registry: existing };
  }

  let creation: RegistryResult;
  try {
    creation = await client.registries().create({
      name: issuerAlias,
      registryName: name,
      noBackers: policy.kind === 'backerless',
      toad: expectedBackerThreshold(policy),
      baks: [...expectedBackers(policy)],
    });
  } catch (cause) {
    const reconciled = await namedRegistry(client, issuerAlias, issuer, name, policy);
    if (reconciled !== undefined) {
      return { kind: 'credential-registry-provisioned', registry: reconciled };
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: `credential registry ${name} creation`,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  const untrustedSerder: unknown = creation.regser;
  if (!Value.Check(registrySerderSchema, untrustedSerder)) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: `credential registry ${name} creation`,
      reason: 'Signify did not return a complete registry inception event',
    });
  }
  if (untrustedSerder.sad.d !== untrustedSerder.sad.i) {
    throw new IdentityFailure({
      kind: 'registry-conflict',
      name,
      reason: 'registry inception digest does not match its identifier',
    });
  }
  verifyRegistryPolicy(untrustedSerder.sad, name, issuer, policy);

  try {
    await completeSignifyOperation(
      client,
      await creation.op(),
      `credential registry ${name} creation`,
      operationTimeoutMs,
    );
  } catch (cause) {
    const reconciled = await namedRegistry(client, issuerAlias, issuer, name, policy);
    if (reconciled !== undefined) {
      return { kind: 'credential-registry-provisioned', registry: reconciled };
    }
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: `credential registry ${name} operation submission`,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  return {
    kind: 'credential-registry-provisioned',
    registry: await verifyNamedCredentialRegistry(client, issuerAlias, issuer, name, policy),
  };
}
