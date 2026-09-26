import { Saider } from 'signify-ts';
import { assessComparisonAllocation, type EvaluationAllowance } from '@devrandom/domain';
import Type from 'typebox';
import Value from 'typebox/value';

import { evaluationManifestInputSchema } from './manifest.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const evaluationPolicyInputSchema = Type.Object(
  {
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    expectedActiveRevisionSaid: said,
    executionProfileSaid: said,
    sourceInventorySaid: said,
    comparisonLaw: Type.Literal('ThreeRepetitionsTwoAttemptsPublicSearch'),
    allocation: evaluationManifestInputSchema.properties.allocation,
  },
  { additionalProperties: false },
);

export const evaluationPolicySchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('ProtectedComparisonPolicy'),
    ...evaluationPolicyInputSchema.properties,
  },
  { additionalProperties: false },
);

export type EvaluationPolicy = Type.Static<typeof evaluationPolicySchema>;
export type EvaluationPolicyRejection =
  'SchemaInvalid' | 'AllocationInvalid' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvaluationPolicyPreparation =
  | { readonly kind: 'Prepared'; readonly policy: EvaluationPolicy }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationPolicyRejection };
export type EvaluationPolicyDecoding =
  | { readonly kind: 'Accepted'; readonly policy: EvaluationPolicy }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationPolicyRejection };

// Policy validity uses the comparison law; hosted admission checks actual residual rights.
const arithmeticCeiling: EvaluationAllowance = {
  providerRequests: Number.MAX_SAFE_INTEGER,
  providerInputTokens: Number.MAX_SAFE_INTEGER,
  providerOutputTokens: Number.MAX_SAFE_INTEGER,
  providerSpendMicroUsd: Number.MAX_SAFE_INTEGER,
  runWallTimeSeconds: Number.MAX_SAFE_INTEGER,
  toolProposals: Number.MAX_SAFE_INTEGER,
  aggregateChildCommandTimeSeconds: Number.MAX_SAFE_INTEGER,
  changedFiles: Number.MAX_SAFE_INTEGER,
  changedWorktreeBytes: Number.MAX_SAFE_INTEGER,
  evidencePlusArtifactsPerRunBytes: Number.MAX_SAFE_INTEGER,
};

function allocationInvalid(input: Type.Static<typeof evaluationPolicyInputSchema>): boolean {
  return assessComparisonAllocation(input.allocation, arithmeticCeiling).kind !== 'Fits';
}

export function prepareEvaluationPolicy(input: unknown): EvaluationPolicyPreparation {
  if (!Value.Check(evaluationPolicyInputSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (allocationInvalid(input)) return { kind: 'Rejected', reason: 'AllocationInvalid' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'ProtectedComparisonPolicy',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(evaluationPolicySchema, document)) {
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    }
    return { kind: 'Prepared', policy: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationPolicy(input: unknown): EvaluationPolicyDecoding {
  if (!Value.Check(evaluationPolicySchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (allocationInvalid(input)) return { kind: 'Rejected', reason: 'AllocationInvalid' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false)) {
      return { kind: 'Rejected', reason: 'SaidMismatch' };
    }
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', policy: structuredClone(input) };
}
