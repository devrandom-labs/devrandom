import Type from 'typebox';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

export const preparedCompatibilityFailureCategorySchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessRevisionSaid: saidSchema,
    currentCommandSaid: saidSchema,
    tamperCommandSaid: saidSchema,
    legacyCommandSaid: saidSchema,
    legacyObservedExitCode: Type.Literal(101),
  },
  { additionalProperties: false },
);

export const calibrationExclusionReasonSchema = Type.Union([
  Type.Literal('IdentityUnavailable'),
  Type.Literal('KERIAUnavailable'),
  Type.Literal('StorageUnavailable'),
  Type.Literal('ProviderUnavailable'),
  Type.Literal('NetworkUnavailable'),
  Type.Literal('ModelCredentialUnavailable'),
  Type.Literal('ModelConfigurationRequired'),
  Type.Literal('ModelUsageUnavailable'),
  Type.Literal('EffectAborted'),
  Type.Literal('BudgetExhausted'),
  Type.Literal('OutboxBackpressure'),
]);

export const calibrationRejectionReasonSchema = Type.Union([
  Type.Literal('H1Passed'),
  Type.Literal('ReceiptPatternMismatch'),
  Type.Literal('FixtureBindingMismatch'),
  Type.Literal('CategoryChanged'),
]);

export const runPurposeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('PreparedCompatibilityCalibration'),
      campaignId: uuidV4Schema,
      ordinal: Type.Union([
        Type.Literal(1),
        Type.Literal(2),
        Type.Literal(3),
        Type.Literal(4),
        Type.Literal(5),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Retained') }, { additionalProperties: false }),
]);

export const runCalibrationDispositionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('Confirmed'), category: preparedCompatibilityFailureCategorySchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Excluded'), reason: calibrationExclusionReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Rejected'), reason: calibrationRejectionReasonSchema },
    { additionalProperties: false },
  ),
]);

export type RunPurposePayload = Type.Static<typeof runPurposeSchema>;
export type RunCalibrationDisposition = Type.Static<typeof runCalibrationDispositionSchema>;
