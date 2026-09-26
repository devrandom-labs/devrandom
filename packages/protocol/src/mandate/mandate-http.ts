import Type from 'typebox';

import {
  workAccessCapabilityInvalidProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '../work-access.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const mandateKindSchema = Type.Union([
  Type.Literal('TaskMandate'),
  Type.Literal('PromotionMandate'),
]);

export type MandateKind = Type.Static<typeof mandateKindSchema>;

export const mandatePresentationParametersSchema = Type.Object(
  { credentialSaid: keriIdentifierSchema },
  { additionalProperties: false },
);

export type MandatePresentationParameters = Type.Static<typeof mandatePresentationParametersSchema>;

export const presentMandateBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    mandateKind: mandateKindSchema,
    grantSaid: keriIdentifierSchema,
  },
  { additionalProperties: false },
);

export type PresentMandateBody = Type.Static<typeof presentMandateBodySchema>;

export const mandatePresentationRejectionReasonSchema = Type.Union([
  Type.Literal('GrantEvidenceInvalid'),
  Type.Literal('CredentialBindingInvalid'),
  Type.Literal('ResourceBindingInvalid'),
  Type.Literal('AuthorityCeilingInvalid'),
  Type.Literal('IncompatibleCredentialState'),
]);

export type MandatePresentationRejectionReason = Type.Static<
  typeof mandatePresentationRejectionReasonSchema
>;

const presentationBindingProperties = {
  version: Type.Literal(1),
  mandateKind: mandateKindSchema,
  credentialSaid: keriIdentifierSchema,
  grantSaid: keriIdentifierSchema,
  presentationExpiresAt: timestampSchema,
};

export const mandatePresentationProjectionSchema = Type.Union([
  Type.Object(
    { ...presentationBindingProperties, kind: Type.Literal('AwaitingGrant') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...presentationBindingProperties,
      kind: Type.Literal('Admitting'),
      operationName: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...presentationBindingProperties,
      kind: Type.Literal('Admitted'),
      admittedAt: timestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...presentationBindingProperties,
      kind: Type.Literal('Rejected'),
      reason: mandatePresentationRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...presentationBindingProperties, kind: Type.Literal('Expired') },
    { additionalProperties: false },
  ),
]);

export type MandatePresentationProjection = Type.Static<typeof mandatePresentationProjectionSchema>;

const correlationIdSchema = uuidV4Schema;

function problem<
  Code extends string,
  Status extends number,
  Title extends string,
  Path extends string,
>(code: Code, status: Status, title: Title, path: Path) {
  return {
    type: Type.Literal(`https://devrandom.example/problems/${path}`),
    title: Type.Literal(title),
    status: Type.Literal(status),
    code: Type.Literal(code),
    correlationId: correlationIdSchema,
  };
}

export const mandatePresentationRequestInvalidProblemSchema = Type.Object(
  problem(
    'MandatePresentationRequestInvalid',
    400,
    'Mandate presentation request is invalid',
    'mandate-presentation-request-invalid',
  ),
  { additionalProperties: false },
);

export const mandatePresentationForbiddenReasonSchema = Type.Union([
  Type.Literal('UserCredentialNotCurrent'),
  Type.Literal('MandateNotYetValid'),
  Type.Literal('MandateExpired'),
  Type.Literal('MandateRevoked'),
]);

export const mandatePresentationForbiddenProblemSchema = Type.Object(
  {
    ...problem(
      'MandatePresentationForbidden',
      403,
      'Mandate presentation is not permitted',
      'mandate-presentation-forbidden',
    ),
    reason: mandatePresentationForbiddenReasonSchema,
  },
  { additionalProperties: false },
);

export const mandatePresentationConflictProblemSchema = Type.Object(
  problem(
    'MandatePresentationConflict',
    409,
    'Mandate presentation conflicts with its prior use',
    'mandate-presentation-conflict',
  ),
  { additionalProperties: false },
);

export const mandatePresentationExpiredProblemSchema = Type.Object(
  problem(
    'MandatePresentationExpired',
    410,
    'Mandate presentation expired',
    'mandate-presentation-expired',
  ),
  { additionalProperties: false },
);

export const mandatePresentationBodyTooLargeProblemSchema = Type.Object(
  problem(
    'MandatePresentationBodyTooLarge',
    413,
    'Mandate presentation request body is too large',
    'mandate-presentation-body-too-large',
  ),
  { additionalProperties: false },
);

export const mandatePresentationRejectedProblemSchema = Type.Object(
  {
    ...problem(
      'MandatePresentationRejected',
      422,
      'Mandate presentation was rejected',
      'mandate-presentation-rejected',
    ),
    reason: mandatePresentationRejectionReasonSchema,
  },
  { additionalProperties: false },
);

export const mandatePresentationUnavailableProblemSchema = Type.Object(
  {
    ...problem(
      'MandatePresentationUnavailable',
      503,
      'Mandate presentation dependency is unavailable',
      'mandate-presentation-unavailable',
    ),
    dependency: Type.Union([
      Type.Literal('Keria'),
      Type.Literal('Witness'),
      Type.Literal('HostedMongoDB'),
    ]),
  },
  { additionalProperties: false },
);

export const mandatePresentationProblemSchema = Type.Union([
  mandatePresentationRequestInvalidProblemSchema,
  workAccessCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  mandatePresentationForbiddenProblemSchema,
  mandatePresentationConflictProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  mandatePresentationExpiredProblemSchema,
  mandatePresentationBodyTooLargeProblemSchema,
  mandatePresentationRejectedProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  mandatePresentationUnavailableProblemSchema,
]);

export type MandatePresentationProblem = Type.Static<typeof mandatePresentationProblemSchema>;
