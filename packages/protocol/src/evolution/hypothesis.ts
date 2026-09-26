import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const claim = Type.String({ minLength: 1, maxLength: 2_048 });

export const evolutionHypothesisInputSchema = Type.Object(
  {
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    retainedCheckpointSaid: said,
    retainedSealSaid: said,
    parentRevisionSaid: said,
    personalAgentAid: said,
    sourceInventorySaid: said,
    retrievalReceiptSaid: said,
    failure: Type.Object(
      { eventSaid: said, rawEvidenceSaid: said },
      { additionalProperties: false },
    ),
    source: Type.Object(
      { episodeSaid: said, rawEvidenceSaid: said },
      { additionalProperties: false },
    ),
    implicatedComponent: Type.Union([
      Type.Literal('Instruction'),
      Type.Literal('Workflow'),
      Type.Literal('ContextSelection'),
    ]),
    predictedCorrection: claim,
    publicReplayAssertion: claim,
    falsifier: claim,
    regressionRisks: Type.Array(claim, { minItems: 1, maxItems: 8 }),
    rejectedExplanations: Type.Array(claim, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);

export const evolutionHypothesisSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('EvolutionHypothesis'),
    ...evolutionHypothesisInputSchema.properties,
  },
  { additionalProperties: false },
);

export type EvolutionHypothesis = Type.Static<typeof evolutionHypothesisSchema>;
export type EvolutionHypothesisRejection =
  'SchemaInvalid' | 'EvidenceIdentityConflict' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvolutionHypothesisPreparation =
  | { readonly kind: 'Prepared'; readonly hypothesis: EvolutionHypothesis }
  | { readonly kind: 'Rejected'; readonly reason: EvolutionHypothesisRejection };
export type EvolutionHypothesisDecoding =
  | { readonly kind: 'Accepted'; readonly hypothesis: EvolutionHypothesis }
  | { readonly kind: 'Rejected'; readonly reason: EvolutionHypothesisRejection };

type EvolutionHypothesisInput = Type.Static<typeof evolutionHypothesisInputSchema>;

function evidenceConflict(input: EvolutionHypothesisInput): boolean {
  return (
    input.failure.eventSaid === input.source.episodeSaid ||
    input.failure.rawEvidenceSaid === input.source.rawEvidenceSaid
  );
}

function emptyClaim(input: EvolutionHypothesisInput): boolean {
  return [
    input.predictedCorrection,
    input.publicReplayAssertion,
    input.falsifier,
    ...input.regressionRisks,
    ...input.rejectedExplanations,
  ].some((value) => value.trim().length === 0);
}

export function prepareEvolutionHypothesis(input: unknown): EvolutionHypothesisPreparation {
  if (!Value.Check(evolutionHypothesisInputSchema, input) || emptyClaim(input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (evidenceConflict(input)) return { kind: 'Rejected', reason: 'EvidenceIdentityConflict' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'EvolutionHypothesis',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(evolutionHypothesisSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', hypothesis: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvolutionHypothesis(input: unknown): EvolutionHypothesisDecoding {
  if (!Value.Check(evolutionHypothesisSchema, input) || emptyClaim(input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (evidenceConflict(input)) return { kind: 'Rejected', reason: 'EvidenceIdentityConflict' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', hypothesis: structuredClone(input) };
}
