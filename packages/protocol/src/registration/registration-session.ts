import Type from 'typebox';

import { credentialCapabilities } from '../credential.js';

const aidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const registrationIdSchema = Type.String({ pattern: '^[a-f0-9]{32}$' });
const expiresAtSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const capabilitySchema = Type.String({
  pattern: '^(cli|browser)_[A-Za-z0-9_-]{32,}$',
});
export const registrationCreationKeySchema = Type.String({
  pattern: '^registration_[A-Za-z0-9_-]{43}$',
});
const oobiSchema = Type.String({ maxLength: 2048, pattern: '^https?://[^#]+$' });
const fixedCapabilitiesSchema = Type.Array(
  Type.Union([
    Type.Literal(credentialCapabilities[0]),
    Type.Literal(credentialCapabilities[1]),
    Type.Literal(credentialCapabilities[2]),
    Type.Literal(credentialCapabilities[3]),
    Type.Literal(credentialCapabilities[4]),
  ]),
  {
    minItems: credentialCapabilities.length,
    maxItems: credentialCapabilities.length,
    uniqueItems: true,
  },
);

export const contactEmailPattern =
  "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";

export const contactEmailSchema = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: contactEmailPattern,
});

export const createRegistrationRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(1),
    userAid: aidSchema,
    userAgentOobi: oobiSchema,
  },
  { additionalProperties: false },
);

export type CreateRegistrationRequest = Type.Static<typeof createRegistrationRequestSchema>;

export const registrationCreationHeadersSchema = Type.Object(
  { 'idempotency-key': registrationCreationKeySchema },
  { additionalProperties: true },
);

export type RegistrationCreationHeaders = Type.Static<typeof registrationCreationHeadersSchema>;

export const createRegistrationResponseSchema = Type.Object(
  {
    registrationId: registrationIdSchema,
    cliCapability: capabilitySchema,
    browserUrl: Type.String({
      maxLength: 4096,
      pattern:
        '^https?://[^#]+#/registration/[a-f0-9]{32}\\?capability=browser_[A-Za-z0-9_-]{32,}$',
    }),
    challengeWords: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 3,
      maxItems: 32,
    }),
    issuerAid: aidSchema,
    issuerOobi: oobiSchema,
    expiresAt: expiresAtSchema,
    pollIntervalMs: Type.Integer({ minimum: 250, maximum: 10_000 }),
  },
  { additionalProperties: false },
);

export type CreateRegistrationResponse = Type.Static<typeof createRegistrationResponseSchema>;

export const submitAidProofRequestSchema = Type.Object(
  { responseSaid: saidSchema },
  { additionalProperties: false },
);

export type SubmitAidProofRequest = Type.Static<typeof submitAidProofRequestSchema>;

export const registrationPathParametersSchema = Type.Object(
  { registrationId: registrationIdSchema },
  { additionalProperties: false },
);

export type RegistrationPathParameters = Type.Static<typeof registrationPathParametersSchema>;

export const registrationCapabilityHeadersSchema = Type.Object(
  { 'x-devrandom-registration-capability': capabilitySchema },
  { additionalProperties: true },
);

export type RegistrationCapabilityHeaders = Type.Static<typeof registrationCapabilityHeadersSchema>;

export const browserMutationHeadersSchema = Type.Object(
  {
    'content-type': Type.String({ pattern: '^application/json(?:;.*)?$' }),
    'x-devrandom-registration-capability': capabilitySchema,
  },
  { additionalProperties: true },
);

export type BrowserMutationHeaders = Type.Static<typeof browserMutationHeadersSchema>;

export const browserApprovalRequestSchema = Type.Object(
  { contactEmail: contactEmailSchema },
  { additionalProperties: false },
);

export type BrowserApprovalRequest = Type.Static<typeof browserApprovalRequestSchema>;

const registrationReference = {
  registrationId: registrationIdSchema,
  userAid: aidSchema,
  expiresAt: expiresAtSchema,
};

const cliPendingProofSchema = Type.Object(
  {
    kind: Type.Literal('pending-proof'),
    ...registrationReference,
    issuerAid: aidSchema,
    issuerOobi: oobiSchema,
    challengeWords: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 3,
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
);

const cliPendingApprovalSchema = Type.Object(
  { kind: Type.Literal('pending-approval'), ...registrationReference },
  { additionalProperties: false },
);

const cliApprovedSchema = Type.Object(
  { kind: Type.Literal('approved'), ...registrationReference },
  { additionalProperties: false },
);

const cliIssuingSchema = Type.Object(
  { kind: Type.Literal('issuing'), ...registrationReference },
  { additionalProperties: false },
);

const cliIssuedSchema = Type.Object(
  {
    kind: Type.Literal('issued'),
    ...registrationReference,
    grantSaid: saidSchema,
    credentialSaid: saidSchema,
  },
  { additionalProperties: false },
);

const cliRejectedSchema = Type.Object(
  {
    kind: Type.Literal('rejected'),
    ...registrationReference,
    reason: Type.Union([
      Type.Literal('aid-proof-rejected'),
      Type.Literal('browser-rejected'),
      Type.Literal('issuance-failed'),
    ]),
  },
  { additionalProperties: false },
);

const cliExpiredSchema = Type.Object(
  { kind: Type.Literal('expired'), ...registrationReference },
  { additionalProperties: false },
);

export const cliRegistrationProjectionSchema = Type.Union([
  cliPendingProofSchema,
  cliPendingApprovalSchema,
  cliApprovedSchema,
  cliIssuingSchema,
  cliIssuedSchema,
  cliRejectedSchema,
  cliExpiredSchema,
]);

export type CliRegistrationProjection = Type.Static<typeof cliRegistrationProjectionSchema>;

const browserReference = {
  ...registrationReference,
  issuerAid: aidSchema,
  abbreviatedUserAid: Type.String({ minLength: 9, maxLength: 32 }),
  comparisonCode: Type.String({ pattern: '^[A-Z0-9]+-[A-Z0-9]+$' }),
  credentialName: Type.Literal('Devrandom User'),
  capabilities: fixedCapabilitiesSchema,
  contactEmailAssurance: Type.Literal('self-asserted-unverified'),
};

function browserProjection<Kind extends string>(kind: Kind) {
  return Type.Object(
    { kind: Type.Literal(kind), ...browserReference },
    { additionalProperties: false },
  );
}

export const browserRegistrationProjectionSchema = Type.Union([
  browserProjection('pending-proof'),
  browserProjection('pending-approval'),
  browserProjection('approved'),
  browserProjection('issuing'),
  browserProjection('issued'),
  browserProjection('rejected'),
  browserProjection('expired'),
]);

export type BrowserRegistrationProjection = Type.Static<typeof browserRegistrationProjectionSchema>;

export const registrationRejectionRequestSchema = Type.Object(
  { action: Type.Literal('reject') },
  { additionalProperties: false },
);
export type RegistrationRejectionRequest = Type.Static<typeof registrationRejectionRequestSchema>;

export const registrationErrorSchema = Type.Object(
  {
    error: Type.Union([
      Type.Literal('registration-unavailable'),
      Type.Literal('registration-conflict'),
      Type.Literal('aid-proof-rejected'),
      Type.Literal('aid-proof-replayed'),
      Type.Literal('registration-expired'),
      Type.Literal('registration-rejected'),
      Type.Literal('request-invalid'),
      Type.Literal('rate-limited'),
    ]),
  },
  { additionalProperties: false },
);

export type RegistrationErrorResponse = Type.Static<typeof registrationErrorSchema>;
