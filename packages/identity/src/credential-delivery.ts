import type { DevrandomUserEligibilityClaim } from '@devrandom/domain';
import { Serder, type SignifyClient } from 'signify-ts';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import { verifyCredential } from './credential.js';
import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import { verifyIpexGrantEvidence } from './ipex.js';
import {
  credentialRegistryId,
  credentialSaid,
  credentialSchemaId,
  issuerAid,
  ipexGrantSaid,
  userAid,
} from './keri-identifier.js';

export interface StableCredentialIssuance {
  readonly issuerAlias: string;
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaId: string;
  readonly issuedAt: number;
  readonly claims: readonly DevrandomUserEligibilityClaim[];
  readonly operationTimeoutMs: number;
}

export type CredentialReconciliation =
  | { readonly kind: 'credential-not-found' }
  | {
      readonly kind: 'credential-submitted';
      readonly credentialSaid: string;
      readonly operationName: string;
    };

export interface CredentialVerification extends StableCredentialIssuance {
  readonly credentialSaid: string;
  readonly operationName: string;
}

export interface StableGrantDelivery {
  readonly issuerAlias: string;
  readonly issuerAid: string;
  readonly recipientAid: string;
  readonly credentialSaid: string;
  readonly preparedAt: number;
  readonly operationTimeoutMs: number;
}

export interface GrantPreparation {
  readonly kind: 'grant-prepared';
  readonly grantSaid: string;
}

export type GrantReconciliation =
  | { readonly kind: 'grant-not-found' }
  | { readonly kind: 'grant-submitted'; readonly operationName: string };

export interface GrantSubmission extends StableGrantDelivery {
  readonly grantSaid: string;
}

export interface GrantVerification extends GrantSubmission {
  readonly operationName: string;
}

export interface DevrandomUserCredentialDelivery {
  reconcileCredential(input: StableCredentialIssuance): Promise<CredentialReconciliation>;
  submitCredential(input: StableCredentialIssuance): Promise<CredentialReconciliation>;
  verifyCredential(input: CredentialVerification): Promise<void>;
  prepareGrant(input: StableGrantDelivery): Promise<GrantPreparation>;
  reconcileGrant(input: GrantSubmission): Promise<GrantReconciliation>;
  submitGrant(input: GrantSubmission): Promise<GrantReconciliation>;
  verifyGrant(input: GrantVerification): Promise<void>;
}

const nonEmptyString = Type.String({ minLength: 1 });
const credentialEnvelopeSchema = Type.Object(
  {
    d: nonEmptyString,
    i: nonEmptyString,
    ri: nonEmptyString,
    s: nonEmptyString,
    a: Type.Object(
      {
        i: nonEmptyString,
        dt: nonEmptyString,
        capabilities: Type.Array(nonEmptyString),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const credentialRecordSchema = Type.Object(
  {
    sad: credentialEnvelopeSchema,
    iss: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
    anc: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
    ancatc: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);

const credentialRecordsSchema = Type.Array(credentialRecordSchema);
const credentialSchemaReferences = Type.Array(
  Type.Object(
    { sad: Type.Object({ s: nonEmptyString }, { additionalProperties: true }) },
    { additionalProperties: true },
  ),
);
const credentialOperationsSchema = Type.Array(
  Type.Object(
    {
      name: nonEmptyString,
      done: Type.Boolean(),
      metadata: Type.Optional(Type.Object({ ced: Type.Unknown() }, { additionalProperties: true })),
    },
    { additionalProperties: true },
  ),
);

const exchangeOperationsSchema = Type.Array(
  Type.Object(
    {
      name: nonEmptyString,
      done: Type.Boolean(),
      metadata: Type.Optional(
        Type.Object({ said: nonEmptyString }, { additionalProperties: true }),
      ),
    },
    { additionalProperties: true },
  ),
);

const exchangeOperationSchema = Type.Object(
  {
    name: nonEmptyString,
    metadata: Type.Optional(Type.Object({ said: nonEmptyString }, { additionalProperties: true })),
  },
  { additionalProperties: true },
);

const credentialOperationSchema = Type.Object(
  {
    name: nonEmptyString,
    metadata: Type.Optional(
      Type.Object(
        { ced: Type.Object({ d: nonEmptyString }, { additionalProperties: true }) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export type CredentialPayloadSchema = TSchema & { readonly $id: string };

function invalidDelivery(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'credential-delivery-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function protocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    return invalidDelivery('protocol timestamp is invalid');
  }
  return new Date(instant).toISOString().replace('Z', '000+00:00');
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchingCredential(
  record: Type.Static<typeof credentialRecordSchema>,
  input: StableCredentialIssuance,
): boolean {
  return (
    record.sad.i === input.issuerAid &&
    record.sad.ri === input.registryId &&
    record.sad.s === input.schemaId &&
    record.sad.a.i === input.issueeAid &&
    record.sad.a.dt === protocolDatetime(input.issuedAt) &&
    sameValues(record.sad.a.capabilities, input.claims)
  );
}

function matchingCredentialEnvelope(
  credential: Type.Static<typeof credentialEnvelopeSchema>,
  input: StableCredentialIssuance,
): boolean {
  return (
    credential.i === input.issuerAid &&
    credential.ri === input.registryId &&
    credential.s === input.schemaId &&
    credential.a.i === input.issueeAid &&
    credential.a.dt === protocolDatetime(input.issuedAt) &&
    sameValues(credential.a.capabilities, input.claims)
  );
}

export function reconcileCredentialEvidence(
  credentialEvidence: unknown,
  operationEvidence: unknown,
  input: StableCredentialIssuance,
): CredentialReconciliation {
  if (
    !Value.Check(credentialSchemaReferences, credentialEvidence) ||
    !Value.Check(credentialOperationsSchema, operationEvidence)
  ) {
    return invalidDelivery('credential reconciliation evidence is malformed');
  }
  const relevantEvidence = credentialEvidence.filter((record) => record.sad.s === input.schemaId);
  if (!Value.Check(credentialRecordsSchema, relevantEvidence)) {
    return invalidDelivery('credential reconciliation evidence is malformed');
  }
  const credentials = relevantEvidence.filter((record) => matchingCredential(record, input));
  const operations = operationEvidence.flatMap((operation) => {
    const envelope = operation.metadata?.ced;
    return Value.Check(credentialEnvelopeSchema, envelope) &&
      matchingCredentialEnvelope(envelope, input)
      ? [{ name: operation.name, credentialSaid: envelope.d }]
      : [];
  });
  if (credentials.length > 1) {
    return invalidDelivery('stable issuance inputs identify more than one credential');
  }
  if (operations.length > 1) {
    return invalidDelivery('stable issuance inputs identify more than one credential operation');
  }
  const credential = credentials[0];
  const operation = operations[0];
  if (
    credential !== undefined &&
    operation !== undefined &&
    credential.sad.d !== operation.credentialSaid
  ) {
    return invalidDelivery('credential and issuance operation identify different credentials');
  }
  const credentialIdentity = credential?.sad.d ?? operation?.credentialSaid;
  if (credentialIdentity === undefined) {
    return { kind: 'credential-not-found' };
  }
  return {
    kind: 'credential-submitted',
    credentialSaid: credentialIdentity,
    operationName: operation?.name ?? `credential-reconciled/${credentialIdentity}`,
  };
}

export function reconcileGrantOperationEvidence(
  operationEvidence: unknown,
  grantSaid: string,
): GrantReconciliation {
  if (!Value.Check(exchangeOperationsSchema, operationEvidence)) {
    return invalidDelivery('grant operation reconciliation evidence is malformed');
  }
  const operations = operationEvidence.filter(
    (operation) => operation.metadata?.said === grantSaid,
  );
  if (operations.length > 1) {
    return invalidDelivery('grant has more than one matching exchange operation');
  }
  return operations[0] === undefined
    ? { kind: 'grant-not-found' }
    : { kind: 'grant-submitted', operationName: operations[0].name };
}

export function signifyDevrandomUserCredentialDelivery(
  client: SignifyClient,
  payloadSchema: CredentialPayloadSchema,
): DevrandomUserCredentialDelivery {
  return {
    async reconcileCredential(input) {
      try {
        const [credentials, operations] = await Promise.all([
          listCredentials(client),
          client.operations().list('credential'),
        ]);
        return reconcileCredentialEvidence(credentials, operations, input);
      } catch (cause) {
        if (cause instanceof IdentityFailure) {
          throw cause;
        }
        throw unavailable('credential reconciliation', cause);
      }
    },

    async submitCredential(input) {
      let issuance;
      try {
        issuance = await client.credentials().issue(input.issuerAlias, {
          i: input.issuerAid,
          ri: input.registryId,
          s: input.schemaId,
          a: {
            i: input.issueeAid,
            dt: protocolDatetime(input.issuedAt),
            capabilities: [...input.claims],
          },
        });
      } catch (cause) {
        throw unavailable('credential issuance submission', cause);
      }
      if (
        typeof issuance.acdc.said !== 'string' ||
        issuance.acdc.said.length === 0 ||
        !Value.Check(credentialOperationSchema, issuance.op) ||
        (issuance.op.metadata !== undefined && issuance.op.metadata.ced.d !== issuance.acdc.said)
      ) {
        return invalidDelivery('credential issuance response has inconsistent identity');
      }
      return {
        kind: 'credential-submitted',
        credentialSaid: issuance.acdc.said,
        operationName: issuance.op.name,
      };
    },

    async verifyCredential(input) {
      if (!input.operationName.startsWith('credential-reconciled/')) {
        await waitForCredentialOperation(client, input);
      }
      const verified = await verifyCredential(client, credentialSaid(input.credentialSaid), {
        issuerAid: issuerAid(input.issuerAid),
        issueeAid: userAid(input.issueeAid),
        registryId: credentialRegistryId(input.registryId),
        schemaId: credentialSchemaId(input.schemaId),
        payloadSchema,
      });
      if (verified.issuedAt !== protocolDatetime(input.issuedAt)) {
        return invalidDelivery('credential issuance time does not match durable issuance state');
      }
    },

    async prepareGrant(input) {
      const prepared = await prepareGrant(client, input);
      return { kind: 'grant-prepared', grantSaid: prepared[0].said };
    },

    async reconcileGrant(input) {
      let operations: unknown;
      try {
        operations = await client.operations().list('exchange');
      } catch (cause) {
        throw unavailable('IPEX grant operation reconciliation', cause);
      }
      const operation = reconcileGrantOperationEvidence(operations, input.grantSaid);
      if (operation.kind === 'grant-submitted') {
        return operation;
      }
      try {
        await client.exchanges().get(input.grantSaid);
        return {
          kind: 'grant-submitted',
          operationName: `exchange-reconciled/${input.grantSaid}`,
        };
      } catch (cause) {
        if (exchangeNotFound(cause, input.grantSaid)) {
          return { kind: 'grant-not-found' };
        }
        throw unavailable('IPEX grant exchange reconciliation', cause);
      }
    },

    async submitGrant(input) {
      const [grant, signatures, attachment] = await prepareGrant(client, input);
      if (grant.said !== input.grantSaid) {
        return invalidDelivery('prepared IPEX grant does not match durable grant SAID');
      }
      let operation: unknown;
      try {
        operation = await client
          .ipex()
          .submitGrant(input.issuerAlias, grant, signatures, attachment, [input.recipientAid]);
      } catch (cause) {
        throw unavailable('IPEX grant submission', cause);
      }
      if (
        !Value.Check(exchangeOperationSchema, operation) ||
        (operation.metadata !== undefined && operation.metadata.said !== input.grantSaid)
      ) {
        return invalidDelivery('IPEX grant submission response has inconsistent identity');
      }
      return { kind: 'grant-submitted', operationName: operation.name };
    },

    async verifyGrant(input) {
      if (!input.operationName.startsWith('exchange-reconciled/')) {
        await waitForExchangeOperation(client, input);
      }
      let exchange: unknown;
      try {
        exchange = await client.exchanges().get(input.grantSaid);
      } catch (cause) {
        throw unavailable('IPEX grant evidence retrieval', cause);
      }
      verifyIpexGrantEvidence(exchange, {
        grantSaid: ipexGrantSaid(input.grantSaid),
        issuerAid: issuerAid(input.issuerAid),
        recipientAid: userAid(input.recipientAid),
        credentialSaid: input.credentialSaid,
      });
    },
  };
}

async function listCredentials(client: SignifyClient): Promise<readonly unknown[]> {
  const pageSize = 1_000;
  const credentials: unknown[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page: unknown = await client.credentials().list({ skip, limit: pageSize });
    if (!Value.Check(credentialSchemaReferences, page)) {
      return invalidDelivery('credential reconciliation page is malformed');
    }
    credentials.push(...page);
    if (page.length < pageSize) {
      return credentials;
    }
  }
}

async function waitForCredentialOperation(
  client: SignifyClient,
  input: CredentialVerification,
): Promise<void> {
  let completed: unknown;
  try {
    const operation = await client.operations().get(input.operationName);
    completed = await client.operations().wait(operation, {
      signal: AbortSignal.timeout(input.operationTimeoutMs),
      maxSleep: Math.min(1_000, input.operationTimeoutMs),
    });
  } catch (cause) {
    throw unavailable('credential issuance completion', cause);
  }
  if (
    !Value.Check(credentialOperationSchema, completed) ||
    (completed.metadata !== undefined && completed.metadata.ced.d !== input.credentialSaid)
  ) {
    return invalidDelivery('completed credential operation does not match its credential');
  }
}

async function waitForExchangeOperation(
  client: SignifyClient,
  input: GrantVerification,
): Promise<void> {
  let completed: unknown;
  try {
    const operation = await client.operations().get(input.operationName);
    completed = await client.operations().wait(operation, {
      signal: AbortSignal.timeout(input.operationTimeoutMs),
      maxSleep: Math.min(1_000, input.operationTimeoutMs),
    });
  } catch (cause) {
    throw unavailable('IPEX grant completion', cause);
  }
  if (
    !Value.Check(exchangeOperationSchema, completed) ||
    (completed.metadata !== undefined && completed.metadata.said !== input.grantSaid)
  ) {
    return invalidDelivery('completed grant operation does not match its exchange');
  }
}

async function prepareGrant(
  client: SignifyClient,
  input: StableGrantDelivery,
): Promise<Awaited<ReturnType<ReturnType<SignifyClient['ipex']>['grant']>>> {
  let credential: unknown;
  try {
    credential = await client.credentials().get(input.credentialSaid);
  } catch (cause) {
    throw unavailable('grant credential retrieval', cause);
  }
  if (!Value.Check(credentialRecordSchema, credential)) {
    return invalidDelivery('grant credential record is malformed');
  }
  if (credential.sad.d !== input.credentialSaid) {
    return invalidDelivery('grant credential does not match durable credential identity');
  }
  let prepared;
  try {
    prepared = await client.ipex().grant({
      senderName: input.issuerAlias,
      recipient: input.recipientAid,
      message: '',
      datetime: protocolDatetime(input.preparedAt),
      acdc: new Serder(credential.sad),
      iss: new Serder(credential.iss),
      anc: new Serder(credential.anc),
      ancAttachment: credential.ancatc.join(''),
    });
  } catch (cause) {
    throw unavailable('IPEX grant preparation', cause);
  }
  if (
    typeof prepared[0].said !== 'string' ||
    prepared[0].said.length === 0 ||
    !prepared[1].every((signature) => typeof signature === 'string') ||
    typeof prepared[2] !== 'string'
  ) {
    return invalidDelivery('prepared IPEX grant is malformed');
  }
  return prepared;
}

function exchangeNotFound(cause: unknown, grantSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${grantSaid} - 404 `)
  );
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}
