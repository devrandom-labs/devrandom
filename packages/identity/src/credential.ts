import {
  devrandomUserEligibilityClaims,
  type DevrandomUserEligibilityClaim,
} from '@devrandom/domain';
import {
  Saider,
  type CredentialResult,
  type IssueCredentialResult,
  type SignifyClient,
} from 'signify-ts';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  credentialSaid,
  type CredentialRegistryId,
  type CredentialSaid,
  type CredentialSchemaId,
  type IssuerAid,
  type UserAid,
} from './keri-identifier.js';
import { completeSignifyOperation } from './signify-operation.js';

const nonEmptyString = Type.String({ minLength: 1 });

const credentialEnvelopeSchema = Type.Object(
  {
    v: nonEmptyString,
    d: nonEmptyString,
    i: nonEmptyString,
    ri: nonEmptyString,
    s: nonEmptyString,
    a: Type.Object(
      {
        d: nonEmptyString,
        i: nonEmptyString,
        dt: nonEmptyString,
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const issuanceEventSchema = Type.Object(
  {
    d: nonEmptyString,
    t: Type.Literal('iss'),
    i: nonEmptyString,
    ri: nonEmptyString,
    s: nonEmptyString,
  },
  { additionalProperties: true },
);

const issuanceSealSchema = Type.Object(
  {
    i: nonEmptyString,
    s: nonEmptyString,
    d: nonEmptyString,
  },
  { additionalProperties: false },
);

const issuanceAnchorSchema = Type.Object(
  {
    d: nonEmptyString,
    t: Type.Literal('ixn'),
    i: nonEmptyString,
    s: nonEmptyString,
    p: nonEmptyString,
    a: Type.Array(issuanceSealSchema),
  },
  { additionalProperties: true },
);

const credentialRecordSchema = Type.Object(
  {
    sad: Type.Unknown(),
    iss: issuanceEventSchema,
    anc: issuanceAnchorSchema,
  },
  { additionalProperties: true },
);

const issuedCredentialStateSchema = Type.Object(
  {
    i: nonEmptyString,
    ri: nonEmptyString,
    s: Type.Literal('0'),
    et: Type.Literal('iss'),
  },
  { additionalProperties: true },
);

const keyEventsSchema = Type.Array(
  Type.Object({ ked: Type.Unknown() }, { additionalProperties: true }),
);

const resolvedSchemaDocument = Type.Object({ $id: nonEmptyString }, { additionalProperties: true });

const credentialEligibilityEvidenceSchema = Type.Object(
  {
    a: Type.Object(
      { capabilities: Type.Array(Type.String({ minLength: 1 })) },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

type CredentialPayloadSchema = TSchema & { readonly $id: string };

export interface CredentialExpectation<PayloadSchema extends CredentialPayloadSchema> {
  readonly issuerAid: IssuerAid;
  readonly issueeAid: UserAid;
  readonly registryId: CredentialRegistryId;
  readonly schemaId: CredentialSchemaId;
  readonly payloadSchema: PayloadSchema;
}

export interface CredentialEvidence {
  readonly expectedCredentialSaid: CredentialSaid;
  readonly credential: unknown;
  readonly credentialState: unknown;
  readonly issuerKeyEvents: unknown;
  readonly resolvedSchema: unknown;
}

export interface VerifiedCredentialEvidence<PayloadSchema extends CredentialPayloadSchema> {
  readonly credentialSaid: CredentialSaid;
  readonly attributeSaid: string;
  readonly issuedAt: string;
  readonly issuerAnchorEventSaid: string;
  readonly payload: Type.Static<PayloadSchema>;
}

export interface VerifiedCredential<
  PayloadSchema extends CredentialPayloadSchema,
> extends VerifiedCredentialEvidence<PayloadSchema> {
  readonly record: CredentialResult;
}

export interface CredentialIssuanceInput<
  Claims extends object,
  PayloadSchema extends CredentialPayloadSchema,
> extends CredentialExpectation<PayloadSchema> {
  readonly issuerAlias: string;
  readonly claims: Claims;
  readonly operationTimeoutMs: number;
}

export interface IssuerCurrentUserCredentialExpectation<
  PayloadSchema extends CredentialPayloadSchema,
> {
  readonly issuerAid: IssuerAid;
  readonly registryId: CredentialRegistryId;
  readonly schemaId: CredentialSchemaId;
  readonly payloadSchema: PayloadSchema;
}

export interface CurrentUserCredentialVerificationInput {
  readonly userAid: UserAid;
  readonly credentialSaid: CredentialSaid;
}

export interface VerifiedCurrentUserCredentialEvidence {
  readonly kind: 'Current';
  readonly userAid: UserAid;
  readonly credentialSaid: CredentialSaid;
  readonly attributeSaid: string;
  readonly issuedAt: string;
  readonly issuerAnchorEventSaid: string;
  readonly eligibilityClaims: readonly DevrandomUserEligibilityClaim[];
}

export interface IssuerCurrentUserCredentialVerification {
  verify(
    input: CurrentUserCredentialVerificationInput,
  ): Promise<VerifiedCurrentUserCredentialEvidence>;
}

function invalidCredential(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'credential-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function verifiedEligibilityClaims(payload: unknown): readonly DevrandomUserEligibilityClaim[] {
  if (!Value.Check(credentialEligibilityEvidenceSchema, payload)) {
    invalidCredential('credential eligibility claims are malformed');
  }
  const claims = new Set<DevrandomUserEligibilityClaim>();
  for (const untrusted of payload.a.capabilities) {
    const claim = devrandomUserEligibilityClaims.find((candidate) => candidate === untrusted);
    if (claim === undefined || claims.has(claim)) {
      invalidCredential('credential eligibility claims do not match expected state');
    }
    claims.add(claim);
  }
  if (
    claims.size !== devrandomUserEligibilityClaims.length ||
    !devrandomUserEligibilityClaims.every((claim) => claims.has(claim))
  ) {
    invalidCredential('credential eligibility claims do not match expected state');
  }
  return devrandomUserEligibilityClaims;
}

function missingCurrentCredentialEvidence<PayloadSchema extends CredentialPayloadSchema>(
  failure: IdentityFailure,
  input: CurrentUserCredentialVerificationInput,
  expected: IssuerCurrentUserCredentialExpectation<PayloadSchema>,
): boolean {
  if (failure.detail.kind !== 'keria-unavailable') {
    return false;
  }
  const reason = failure.detail.reason;
  const missingEvidencePrefixes = [
    `HTTP GET /credentials/${input.credentialSaid} - 404 `,
    `HTTP GET /registries/${expected.registryId}/${input.credentialSaid} - 404 `,
    `HTTP GET /schema/${expected.schemaId} - 404 `,
  ];
  return missingEvidencePrefixes.some((prefix) => reason.startsWith(prefix));
}

function verifySaid(document: object, said: string, purpose: string, label = 'd'): void {
  try {
    if (!new Saider({ qb64: said }).verify(document, true, true, undefined, label)) {
      invalidCredential(`${purpose} is not bound by its SAID`);
    }
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    invalidCredential(`${purpose} has an invalid SAID`, cause);
  }
}

function verifyResolvedSchema(value: unknown, expected: CredentialSchemaId): void {
  if (!Value.Check(resolvedSchemaDocument, value) || value.$id !== expected) {
    invalidCredential('resolved schema does not match expected state');
  }
  verifySaid(value, value.$id, 'resolved schema', '$id');
}

function verifyIssuerKelAnchor(
  keyEvents: Type.Static<typeof keyEventsSchema>,
  anchor: Type.Static<typeof issuanceAnchorSchema>,
  issuer: IssuerAid,
): void {
  for (const event of keyEvents) {
    if (
      Value.Check(issuanceAnchorSchema, event.ked) &&
      event.ked.d === anchor.d &&
      event.ked.i === issuer
    ) {
      verifySaid(event.ked, event.ked.d, 'issuer KEL anchor event');
      return;
    }
  }
  invalidCredential('issuer KEL does not contain the credential anchor');
}

export function verifyCredentialEvidence<PayloadSchema extends CredentialPayloadSchema>(
  evidence: CredentialEvidence,
  expected: CredentialExpectation<PayloadSchema>,
): VerifiedCredentialEvidence<PayloadSchema> {
  if (!Value.Check(credentialRecordSchema, evidence.credential)) {
    invalidCredential('credential record is incomplete');
  }
  if (!Value.Check(expected.payloadSchema, evidence.credential.sad)) {
    invalidCredential('payload does not match the expected credential schema');
  }
  if (!Value.Check(credentialEnvelopeSchema, evidence.credential.sad)) {
    invalidCredential('payload does not contain a complete credential envelope');
  }

  const envelope = evidence.credential.sad;
  verifySaid(envelope, envelope.d, 'credential payload');
  verifySaid(envelope.a, envelope.a.d, 'credential attributes');
  if (envelope.i !== expected.issuerAid) {
    invalidCredential('credential issuer does not match expected state');
  }
  if (envelope.a.i !== expected.issueeAid) {
    invalidCredential('credential issuee does not match expected state');
  }
  if (envelope.ri !== expected.registryId) {
    invalidCredential('credential registry does not match expected state');
  }
  if (envelope.s !== expected.schemaId || expected.payloadSchema.$id !== expected.schemaId) {
    invalidCredential('credential schema does not match expected state');
  }

  const issuance = evidence.credential.iss;
  verifySaid(issuance, issuance.d, 'credential issuance event');
  if (issuance.i !== envelope.d || issuance.ri !== expected.registryId || issuance.s !== '0') {
    invalidCredential('issuance event does not bind the credential and registry');
  }

  if (!Value.Check(issuedCredentialStateSchema, evidence.credentialState)) {
    invalidCredential('credential does not have an issued TEL state');
  }
  if (
    evidence.credentialState.i !== envelope.d ||
    evidence.credentialState.ri !== expected.registryId
  ) {
    invalidCredential('TEL state does not bind the credential and registry');
  }

  const anchor = evidence.credential.anc;
  verifySaid(anchor, anchor.d, 'issuer anchor event');
  if (anchor.i !== expected.issuerAid) {
    invalidCredential('issuer anchor does not match expected state');
  }
  if (
    !anchor.a.some(
      (seal) => seal.i === envelope.d && seal.s === issuance.s && seal.d === issuance.d,
    )
  ) {
    invalidCredential('issuer anchor does not seal the issuance event');
  }

  if (!Value.Check(keyEventsSchema, evidence.issuerKeyEvents)) {
    invalidCredential('issuer KEL response is incomplete');
  }
  verifyIssuerKelAnchor(evidence.issuerKeyEvents, anchor, expected.issuerAid);

  verifyResolvedSchema(evidence.resolvedSchema, expected.schemaId);
  if (envelope.d !== evidence.expectedCredentialSaid) {
    invalidCredential('credential SAID does not match the requested credential');
  }
  const payload = Value.Parse(expected.payloadSchema, envelope);
  return {
    credentialSaid: credentialSaid(envelope.d),
    attributeSaid: envelope.a.d,
    issuedAt: envelope.a.dt,
    issuerAnchorEventSaid: anchor.d,
    payload,
  };
}

export async function verifyCredential<PayloadSchema extends CredentialPayloadSchema>(
  client: SignifyClient,
  said: CredentialSaid,
  expected: CredentialExpectation<PayloadSchema>,
): Promise<VerifiedCredential<PayloadSchema>> {
  let record: CredentialResult;
  let credentialState: unknown;
  let issuerKeyEvents: unknown;
  let resolvedSchema: unknown;
  try {
    [record, credentialState, issuerKeyEvents, resolvedSchema] = await Promise.all([
      client.credentials().get(said),
      client.credentials().state(expected.registryId, said),
      client.keyEvents().get(expected.issuerAid),
      client.schemas().get(expected.schemaId),
    ]);
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'credential verification evidence retrieval',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  const verified = verifyCredentialEvidence(
    {
      expectedCredentialSaid: said,
      credential: record,
      credentialState,
      issuerKeyEvents,
      resolvedSchema,
    },
    expected,
  );
  return { ...verified, record };
}

export function signifyIssuerCurrentUserCredentialVerification<
  PayloadSchema extends CredentialPayloadSchema,
>(
  client: SignifyClient,
  expected: IssuerCurrentUserCredentialExpectation<PayloadSchema>,
): IssuerCurrentUserCredentialVerification {
  return {
    async verify(input) {
      let verified: VerifiedCredential<PayloadSchema>;
      try {
        verified = await verifyCredential(client, input.credentialSaid, {
          ...expected,
          issueeAid: input.userAid,
        });
      } catch (cause) {
        if (
          cause instanceof IdentityFailure &&
          missingCurrentCredentialEvidence(cause, input, expected)
        ) {
          invalidCredential('credential does not have complete current issuance evidence', cause);
        }
        throw cause;
      }
      return {
        kind: 'Current',
        userAid: input.userAid,
        credentialSaid: verified.credentialSaid,
        attributeSaid: verified.attributeSaid,
        issuedAt: verified.issuedAt,
        issuerAnchorEventSaid: verified.issuerAnchorEventSaid,
        eligibilityClaims: verifiedEligibilityClaims(verified.payload),
      };
    },
  };
}

export async function issueCredential<
  Claims extends object,
  PayloadSchema extends CredentialPayloadSchema,
>(
  client: SignifyClient,
  input: CredentialIssuanceInput<Claims, PayloadSchema>,
): Promise<VerifiedCredential<PayloadSchema>> {
  let issuance: IssueCredentialResult;
  try {
    issuance = await client.credentials().issue(input.issuerAlias, {
      ri: input.registryId,
      s: input.schemaId,
      a: { i: input.issueeAid, ...input.claims },
    });
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'credential issuance',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  await completeSignifyOperation(
    client,
    issuance.op,
    'credential issuance',
    input.operationTimeoutMs,
  );
  const said = credentialSaid(issuance.acdc.said);
  return verifyCredential(client, said, input);
}
