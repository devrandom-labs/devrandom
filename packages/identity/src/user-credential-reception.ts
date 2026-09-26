import { type SignifyClient } from 'signify-ts';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import { verifyCredential, type VerifiedCredentialEvidence } from './credential.js';
import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  correlateIpexGrantNotification,
  mergeIpexGrantCorrelations,
  verifyIpexAdmitEvidence,
  verifyIpexGrantEvidence,
  type IpexGrantCorrelation,
} from './ipex.js';
import type {
  CredentialRegistryId,
  CredentialSaid,
  CredentialSchemaId,
  IpexGrantSaid,
  IssuerAid,
  UserAid,
} from './keri-identifier.js';
import { completeSignifyOperation } from './signify-operation.js';

const notificationPageSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    notes: Type.Array(
      Type.Object(
        {
          i: Type.String({ minLength: 1 }),
          r: Type.Boolean(),
          a: Type.Object(
            { r: Type.String({ minLength: 1 }), d: Type.String({ minLength: 1 }) },
            { additionalProperties: true },
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const exchangeOperationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    metadata: Type.Optional(
      Type.Object({ said: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

type UserCredentialPayloadSchema = TSchema & { readonly $id: string };

export interface UserCredentialExpectation<PayloadSchema extends UserCredentialPayloadSchema> {
  readonly issuerAid: IssuerAid;
  readonly issueeAid: UserAid;
  readonly registryId: CredentialRegistryId;
  readonly schemaId: CredentialSchemaId;
  readonly credentialSaid: CredentialSaid;
  readonly payloadSchema: PayloadSchema;
}

export interface UserCredentialAdmission<
  PayloadSchema extends UserCredentialPayloadSchema,
> extends UserCredentialExpectation<PayloadSchema> {
  readonly userAlias: string;
  readonly grantSaid: IpexGrantSaid;
  readonly admitPreparedAt: number;
  readonly operationTimeoutMs: number;
  readonly materializationTimeoutMs: number;
}

export interface UserCredentialReception {
  verify<PayloadSchema extends UserCredentialPayloadSchema>(
    input: UserCredentialExpectation<PayloadSchema>,
  ): Promise<VerifiedCredentialEvidence<PayloadSchema>>;
  admitAndVerify<PayloadSchema extends UserCredentialPayloadSchema>(
    input: UserCredentialAdmission<PayloadSchema>,
  ): Promise<VerifiedCredentialEvidence<PayloadSchema>>;
}

export function signifyUserCredentialReception(client: SignifyClient): UserCredentialReception {
  return {
    async verify(input) {
      const verified = await verifyCredential(client, input.credentialSaid, input);
      return verified;
    },

    async admitAndVerify(input) {
      const notification = await waitForGrantNotification(client, input);
      const grant = await retrieveGrant(client, input.grantSaid);
      verifyIpexGrantEvidence(grant, {
        grantSaid: input.grantSaid,
        issuerAid: input.issuerAid,
        recipientAid: input.issueeAid,
        credentialSaid: input.credentialSaid,
      });

      const [admit, signatures, attachment] = await prepareAdmit(client, input);
      if (!(await exactAdmitExists(client, admit.said, input))) {
        let operation: unknown;
        try {
          operation = await client
            .ipex()
            .submitAdmit(input.userAlias, admit, signatures, attachment, [input.issuerAid]);
        } catch (cause) {
          if (!(await exactAdmitExists(client, admit.said, input))) {
            throw unavailable('IPEX admit submission', cause);
          }
        }
        if (operation !== undefined) {
          if (
            !Value.Check(exchangeOperationSchema, operation) ||
            (operation.metadata !== undefined && operation.metadata.said !== admit.said)
          ) {
            invalidReception('IPEX admit operation does not match the prepared exchange');
          }
          await completeSignifyOperation(
            client,
            operation,
            'IPEX admit completion',
            input.operationTimeoutMs,
          );
        }
      }

      if (notification.kind === 'expected-grant-available') {
        for (const notificationId of notification.notificationIds) {
          try {
            await client.notifications().mark(notificationId);
          } catch (cause) {
            throw unavailable('IPEX grant notification acknowledgement', cause);
          }
        }
      }
      return waitForCredential(client, input);
    },
  };
}

async function waitForGrantNotification(
  client: SignifyClient,
  input: UserCredentialAdmission<UserCredentialPayloadSchema>,
): Promise<Exclude<IpexGrantCorrelation, { readonly kind: 'expected-grant-pending' }>> {
  const deadline = Date.now() + input.materializationTimeoutMs;
  do {
    const correlation = await exactGrantNotification(client, input.grantSaid);
    if (correlation.kind !== 'expected-grant-pending') {
      return correlation;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new IdentityFailure({
    kind: 'keria-operation-timeout',
    operationName: input.grantSaid,
    stage: 'exact IPEX grant notification',
  });
}

async function exactGrantNotification(
  client: SignifyClient,
  grantSaid: IpexGrantSaid,
): Promise<IpexGrantCorrelation> {
  let start = 0;
  let matched: IpexGrantCorrelation = { kind: 'expected-grant-pending' };
  for (;;) {
    let page: unknown;
    try {
      page = await client.notifications().list(start, start + 24);
    } catch (cause) {
      throw unavailable('IPEX notification retrieval', cause);
    }
    if (!Value.Check(notificationPageSchema, page)) {
      return invalidReception('IPEX notification page does not contain valid range evidence');
    }
    const correlation = correlateIpexGrantNotification({ notes: page.notes }, grantSaid);
    matched = mergeIpexGrantCorrelations(matched, correlation);
    if (page.total === 0 || page.end + 1 >= page.total) {
      return matched;
    }
    if (page.end < start) {
      return invalidReception('IPEX notification range did not advance');
    }
    start = page.end + 1;
  }
}

async function prepareAdmit(
  client: SignifyClient,
  input: UserCredentialAdmission<UserCredentialPayloadSchema>,
) {
  try {
    const prepared = await client.ipex().admit({
      senderName: input.userAlias,
      recipient: input.issuerAid,
      message: '',
      grantSaid: input.grantSaid,
      datetime: protocolDatetime(input.admitPreparedAt),
    });
    verifyIpexAdmitEvidence(prepared[0].sad, {
      admitSaid: prepared[0].said,
      grantSaid: input.grantSaid,
      sourceAid: input.issueeAid,
      recipientAid: input.issuerAid,
    });
    return prepared;
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw unavailable('IPEX admit preparation', cause);
  }
}

async function retrieveGrant(client: SignifyClient, grantSaid: IpexGrantSaid): Promise<unknown> {
  try {
    return await client.exchanges().get(grantSaid);
  } catch (cause) {
    throw unavailable('IPEX grant retrieval', cause);
  }
}

async function exactAdmitExists(
  client: SignifyClient,
  said: string,
  input: UserCredentialAdmission<UserCredentialPayloadSchema>,
): Promise<boolean> {
  try {
    const evidence: unknown = await client.exchanges().get(said);
    if (typeof evidence !== 'object' || evidence === null || !('exn' in evidence)) {
      return invalidReception('IPEX admit exchange is malformed');
    }
    verifyIpexAdmitEvidence(evidence.exn, {
      admitSaid: said,
      grantSaid: input.grantSaid,
      sourceAid: input.issueeAid,
      recipientAid: input.issuerAid,
    });
    return true;
  } catch (cause) {
    if (notFound(cause, `/exchanges/${said}`)) {
      return false;
    }
    throw unavailable('IPEX exchange reconciliation', cause);
  }
}

async function existingCredential<PayloadSchema extends UserCredentialPayloadSchema>(
  client: SignifyClient,
  input: UserCredentialExpectation<PayloadSchema>,
): Promise<VerifiedCredentialEvidence<PayloadSchema> | undefined> {
  try {
    await client.credentials().get(input.credentialSaid);
  } catch (cause) {
    if (notFound(cause, `/credentials/${input.credentialSaid}`)) {
      return undefined;
    }
    throw unavailable('credential materialization lookup', cause);
  }
  const verified = await verifyCredential(client, input.credentialSaid, input);
  return verified;
}

async function waitForCredential<PayloadSchema extends UserCredentialPayloadSchema>(
  client: SignifyClient,
  input: UserCredentialAdmission<PayloadSchema>,
): Promise<VerifiedCredentialEvidence<PayloadSchema>> {
  const deadline = Date.now() + input.materializationTimeoutMs;
  do {
    const existing = await existingCredential(client, input);
    if (existing !== undefined) {
      return existing;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new IdentityFailure({
    kind: 'keria-operation-timeout',
    operationName: input.credentialSaid,
    stage: 'exact credential materialization',
  });
}

function notFound(cause: unknown, path: string): boolean {
  return cause instanceof Error && cause.message.startsWith(`HTTP GET ${path} - 404 `);
}

function protocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    return invalidReception('IPEX admit timestamp is invalid');
  }
  return new Date(instant).toISOString().replace('Z', '000+00:00');
}

function invalidReception(reason: string): never {
  throw new IdentityFailure({ kind: 'ipex-evidence-invalid', reason });
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}
