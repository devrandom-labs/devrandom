import { comparisonSlots } from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const allowance = Type.Object(
  {
    providerRequests: Type.Integer({ minimum: 0, maximum: 50 }),
    providerInputTokens: Type.Integer({ minimum: 0, maximum: 500000 }),
    providerOutputTokens: Type.Integer({ minimum: 0, maximum: 100000 }),
    providerSpendMicroUsd: Type.Integer({ minimum: 0, maximum: 5000000 }),
    runWallTimeSeconds: Type.Integer({ minimum: 0, maximum: 3600 }),
    toolProposals: Type.Integer({ minimum: 0, maximum: 500 }),
    aggregateChildCommandTimeSeconds: Type.Integer({ minimum: 0, maximum: 1800 }),
    changedFiles: Type.Integer({ minimum: 0, maximum: 256 }),
    changedWorktreeBytes: Type.Integer({ minimum: 0, maximum: 16777216 }),
    evidencePlusArtifactsPerRunBytes: Type.Integer({ minimum: 0, maximum: 67108864 }),
  },
  { additionalProperties: false },
);

export const evaluationManifestInputSchema = Type.Object(
  {
    evaluationId: uuid,
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    ownerAid: said,
    personalAgentAid: said,
    taskMandateSaid: said,
    retainedCheckpointSaid: said,
    retainedSealSaid: said,
    policySaid: said,
    revisions: Type.Object(
      { H1: said, C1: said, C2: said, C3: said },
      { additionalProperties: false },
    ),
    executionProfileSaid: said,
    sourceInventorySaid: said,
    verifierSaid: said,
    protectedCaseArtifactSaid: said,
    finalCaseArtifactSaid: said,
    publicConditionIds: Type.Array(
      Type.String({ minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9._-]*$' }),
      { minItems: 1, maxItems: 32, uniqueItems: true },
    ),
    heldOutCaseCount: Type.Integer({ minimum: 1, maximum: 32 }),
    allocation: Type.Object(
      { diagnosis: allowance, perEntry: allowance, finalization: allowance },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const slotSchema = Type.Object(
  {
    arm: Type.Union(
      (['H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((arm) => Type.Literal(arm)),
    ),
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    attempt: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
);

export const evaluationManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('ProtectedComparison'),
    ...evaluationManifestInputSchema.properties,
    slots: Type.Array(slotSchema, { minItems: 18, maxItems: 18 }),
  },
  { additionalProperties: false },
);

export type EvaluationManifest = Type.Static<typeof evaluationManifestSchema>;
export type EvaluationManifestInput = Type.Static<typeof evaluationManifestInputSchema>;
export type EvaluationManifestRejection =
  | 'SchemaInvalid'
  | 'RevisionSetInvalid'
  | 'FinalHoldoutReused'
  | 'PrincipalConflict'
  | 'RequiredScheduleInvalid'
  | 'SaidMismatch'
  | 'SaidConstructionFailed';
export type EvaluationManifestDecoding =
  | { readonly kind: 'Accepted'; readonly manifest: EvaluationManifest }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationManifestRejection };
export type EvaluationManifestPreparation =
  | { readonly kind: 'Prepared'; readonly manifest: EvaluationManifest }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationManifestRejection };

function invalidBinding(input: EvaluationManifestInput): EvaluationManifestRejection | undefined {
  if (new Set(Object.values(input.revisions)).size !== 4) return 'RevisionSetInvalid';
  if (input.protectedCaseArtifactSaid === input.finalCaseArtifactSaid) return 'FinalHoldoutReused';
  if (input.ownerAid === input.personalAgentAid) return 'PrincipalConflict';
  return undefined;
}

export function prepareEvaluationManifest(input: unknown): EvaluationManifestPreparation {
  if (!Value.Check(evaluationManifestInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalid = invalidBinding(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'ProtectedComparison',
      ...structuredClone(input),
      slots: comparisonSlots(),
    })[1];
    if (!Value.Check(evaluationManifestSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', manifest: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationManifest(input: unknown): EvaluationManifestDecoding {
  if (!Value.Check(evaluationManifestSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalid = invalidBinding(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  const expected = comparisonSlots();
  if (
    !input.slots.every((slot, index) => {
      const required = expected[index];
      return (
        required !== undefined &&
        slot.arm === required.arm &&
        slot.repetition === required.repetition &&
        slot.attempt === required.attempt
      );
    })
  )
    return { kind: 'Rejected', reason: 'RequiredScheduleInvalid' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', manifest: structuredClone(input) };
}
