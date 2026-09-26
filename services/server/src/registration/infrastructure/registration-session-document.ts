import Type from 'typebox';
import Value from 'typebox/value';

import { contactEmailSchema } from '@devrandom/protocol';

import {
  reconstructRegistrationSession,
  RegistrationSessionFailure,
  type RegistrationSession,
} from '../domain/registration-session.js';

const nonEmptyString = Type.String({ minLength: 1 });
const instant = Type.Integer({ minimum: 0 });
const aid = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const registrationId = Type.String({ pattern: '^[a-f0-9]{32}$' });
const oobi = Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^#]+$' });
const capabilityHash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const challengeWords = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
  minItems: 3,
  maxItems: 32,
});

const bindingSchema = Type.Object(
  {
    registrationId,
    protocolVersion: Type.Literal('1'),
    userAid: aid,
    userAgentOobi: oobi,
    issuerAid: aid,
    challengeWords,
    cliCapabilityHash: capabilityHash,
    browserCapabilityHash: capabilityHash,
    createdAt: instant,
    expiresAt: instant,
  },
  { additionalProperties: false },
);

const proofSchema = Type.Object(
  {
    registrationId,
    sourceAid: aid,
    recipientAid: aid,
    challengeWords,
    responseSaid: said,
    acceptedAt: instant,
  },
  { additionalProperties: false },
);

const awaitingApprovalSchema = Type.Object(
  { kind: Type.Literal('awaiting-approval') },
  { additionalProperties: false },
);

const acceptedApprovalSchema = Type.Object(
  { contactEmail: contactEmailSchema, approvedAt: instant },
  { additionalProperties: false },
);

const approvalRecordedSchema = Type.Object(
  {
    kind: Type.Literal('approval-recorded'),
    contactEmail: contactEmailSchema,
    approvedAt: instant,
  },
  { additionalProperties: false },
);

const preparedIssuanceSchema = Type.Object(
  { kind: Type.Literal('prepared'), issuedAt: instant },
  { additionalProperties: false },
);

const credentialSubmittedIssuanceSchema = Type.Object(
  {
    kind: Type.Literal('credential-submitted'),
    issuedAt: instant,
    credentialSaid: said,
    operationName: nonEmptyString,
    recordedAt: instant,
  },
  { additionalProperties: false },
);

const credentialVerifiedIssuanceSchema = Type.Object(
  {
    kind: Type.Literal('credential-verified'),
    issuedAt: instant,
    credentialSaid: said,
    credentialOperationName: nonEmptyString,
    credentialSubmissionRecordedAt: instant,
    verifiedAt: instant,
  },
  { additionalProperties: false },
);

const grantPreparedIssuanceSchema = Type.Object(
  {
    kind: Type.Literal('grant-prepared'),
    issuedAt: instant,
    credentialSaid: said,
    credentialOperationName: nonEmptyString,
    credentialSubmissionRecordedAt: instant,
    credentialVerifiedAt: instant,
    grantSaid: said,
    preparedAt: instant,
  },
  { additionalProperties: false },
);

const grantSubmittedIssuanceSchema = Type.Object(
  {
    kind: Type.Literal('grant-submitted'),
    issuedAt: instant,
    credentialSaid: said,
    credentialOperationName: nonEmptyString,
    credentialSubmissionRecordedAt: instant,
    credentialVerifiedAt: instant,
    grantSaid: said,
    grantPreparedAt: instant,
    grantOperationName: nonEmptyString,
    recordedAt: instant,
  },
  { additionalProperties: false },
);

const rejectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('browser-declined') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('proof-rejected'), reason: nonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('issuance-failed'), reason: nonEmptyString },
    { additionalProperties: false },
  ),
]);

const registrationSessionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('pending-proof'),
      binding: bindingSchema,
      approval: Type.Union([awaitingApprovalSchema, approvalRecordedSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('pending-approval'),
      binding: bindingSchema,
      proof: proofSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('approved'),
      binding: bindingSchema,
      proof: proofSchema,
      approval: acceptedApprovalSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('issuing'),
      binding: bindingSchema,
      proof: proofSchema,
      approval: acceptedApprovalSchema,
      progress: Type.Union([
        preparedIssuanceSchema,
        credentialSubmittedIssuanceSchema,
        credentialVerifiedIssuanceSchema,
        grantPreparedIssuanceSchema,
        grantSubmittedIssuanceSchema,
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('issued'),
      binding: bindingSchema,
      proof: proofSchema,
      approval: acceptedApprovalSchema,
      issuedAt: instant,
      credentialSaid: said,
      credentialOperationName: nonEmptyString,
      credentialSubmissionRecordedAt: instant,
      credentialVerifiedAt: instant,
      grantSaid: said,
      grantPreparedAt: instant,
      grantOperationName: nonEmptyString,
      grantSubmissionRecordedAt: instant,
      completedAt: instant,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('rejected'),
      binding: bindingSchema,
      rejection: rejectionSchema,
      rejectedAt: instant,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('expired'),
      binding: bindingSchema,
      expiredAt: instant,
    },
    { additionalProperties: false },
  ),
]);

export class RegistrationSessionDocumentFailure extends Error {
  constructor(reason: string, cause?: unknown) {
    super(
      `Registration Session document is invalid: ${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'RegistrationSessionDocumentFailure';
  }
}

export function decodeRegistrationSessionDocument(source: string): RegistrationSession {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch {
    throw new RegistrationSessionDocumentFailure('session is not JSON');
  }

  if (!Value.Check(registrationSessionSchema, candidate)) {
    throw new RegistrationSessionDocumentFailure('session does not match the current schema');
  }

  try {
    return reconstructRegistrationSession(candidate);
  } catch (cause) {
    if (cause instanceof RegistrationSessionFailure) {
      throw new RegistrationSessionDocumentFailure('session violates domain invariants', cause);
    }
    throw cause;
  }
}

export function encodeRegistrationSessionDocument(session: RegistrationSession): string {
  if (!Value.Check(registrationSessionSchema, session)) {
    throw new RegistrationSessionDocumentFailure('domain state does not match the current schema');
  }

  try {
    return JSON.stringify(reconstructRegistrationSession(session));
  } catch (cause) {
    if (cause instanceof RegistrationSessionFailure) {
      throw new RegistrationSessionDocumentFailure('domain state violates its invariants', cause);
    }
    throw cause;
  }
}
