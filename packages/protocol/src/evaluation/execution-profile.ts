import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const digest = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const gitSha1 = Type.String({ pattern: '^[a-f0-9]{40}$' });
export const evaluationExecutionProfileInputSchema = Type.Object(
  {
    os: Type.Literal('linux'),
    architecture: Type.Union([Type.Literal('aarch64'), Type.Literal('x86_64')]),
    imageDigest: digest,
    runtimeDigest: digest,
    toolchainDigest: digest,
    sourceGitCommit: gitSha1,
    sourceGitTree: gitSha1,
    h1InstructionSaid: said,
    h1RuntimePromptDigest: digest,
    effectiveLimitsReceiptSaid: said,
    parentDeathCleanupReceiptSaid: said,
    modelProvider: Type.String({ minLength: 1, maxLength: 64 }),
    modelId: Type.String({ minLength: 1, maxLength: 160 }),
    thinkingLevel: Type.String({ minLength: 1, maxLength: 32 }),
    maximumOutputTokens: Type.Integer({ minimum: 1, maximum: 100000 }),
    limits: Type.Object(
      {
        cpuCount: Type.Integer({ minimum: 1, maximum: 4 }),
        memoryBytes: Type.Integer({ minimum: 64 * 1024 * 1024, maximum: 4 * 1024 * 1024 * 1024 }),
        processCount: Type.Integer({ minimum: 1, maximum: 128 }),
        scratchBytes: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
        outputBytes: Type.Integer({ minimum: 1, maximum: 512 * 1024 }),
        wallTimeSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
      },
      { additionalProperties: false },
    ),
    containment: Type.Object(
      {
        nonRoot: Type.Boolean(),
        readOnlyRuntime: Type.Boolean(),
        networkDisabled: Type.Boolean(),
        privilegesDropped: Type.Boolean(),
        restrictedIpc: Type.Boolean(),
        parentDeathCleanup: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const evaluationExecutionProfileSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('EvaluationExecutionProfile'),
    ...evaluationExecutionProfileInputSchema.properties,
  },
  { additionalProperties: false },
);
export type EvaluationExecutionProfile = Type.Static<typeof evaluationExecutionProfileSchema>;
export type EvaluationExecutionProfileRejection =
  'SchemaInvalid' | 'ContainmentMissing' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvaluationExecutionProfilePreparation =
  | { readonly kind: 'Prepared'; readonly profile: EvaluationExecutionProfile }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationExecutionProfileRejection };
export type EvaluationExecutionProfileDecoding =
  | { readonly kind: 'Accepted'; readonly profile: EvaluationExecutionProfile }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationExecutionProfileRejection };

function containmentMissing(
  input: Type.Static<typeof evaluationExecutionProfileInputSchema>,
): boolean {
  return Object.values(input.containment).some((required) => !required);
}

export function prepareEvaluationExecutionProfile(
  input: unknown,
): EvaluationExecutionProfilePreparation {
  if (!Value.Check(evaluationExecutionProfileInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (containmentMissing(input)) return { kind: 'Rejected', reason: 'ContainmentMissing' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'EvaluationExecutionProfile',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(evaluationExecutionProfileSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', profile: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationExecutionProfile(
  input: unknown,
): EvaluationExecutionProfileDecoding {
  if (!Value.Check(evaluationExecutionProfileSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (containmentMissing(input)) return { kind: 'Rejected', reason: 'ContainmentMissing' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', profile: structuredClone(input) };
}
