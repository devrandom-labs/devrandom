import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
export const evaluationClosureInputSchema = Type.Object(
  {
    evaluationId: uuid,
    evidenceStreamId: uuid,
    originRunId: uuid,
    manifestSaid: said,
    evidenceIndexSaid: said,
    acceptedEventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    acceptedHeadSaid: said,
    observationSaids: Type.Array(said, { minItems: 18, maxItems: 18, uniqueItems: true }),
    measurementSaids: Type.Array(said, { minItems: 15, maxItems: 15, uniqueItems: true }),
    sharedAuditSaid: said,
    armAuditSaids: Type.Object(
      { H1: said, C1: said, C2: said, C3: said, H1TaskSearch: said },
      { additionalProperties: false },
    ),
    protectedCustodySaid: said,
    agentSealSaid: said,
  },
  { additionalProperties: false },
);
export const evaluationClosureSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('EvidenceOnly'),
    ...evaluationClosureInputSchema.properties,
  },
  { additionalProperties: false },
);
export type EvaluationClosure = Type.Static<typeof evaluationClosureSchema>;
export type EvaluationClosureRejection =
  'SchemaInvalid' | 'RequiredSetIncomplete' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvaluationClosurePreparation =
  | { readonly kind: 'Prepared'; readonly closure: EvaluationClosure }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationClosureRejection };
export type EvaluationClosureDecoding =
  | { readonly kind: 'Accepted'; readonly closure: EvaluationClosure }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationClosureRejection };

function incomplete(input: Type.Static<typeof evaluationClosureInputSchema>): boolean {
  return (
    new Set(input.observationSaids).size !== 18 ||
    new Set(input.measurementSaids).size !== 15 ||
    input.evaluationId === input.originRunId ||
    input.evidenceStreamId === input.originRunId ||
    input.evidenceStreamId === input.evaluationId
  );
}

export function prepareEvaluationClosure(input: unknown): EvaluationClosurePreparation {
  if (!Value.Check(evaluationClosureInputSchema, input)) {
    if (
      typeof input === 'object' &&
      input !== null &&
      !('activeRevisionSaid' in input) &&
      (('observationSaids' in input &&
        Array.isArray(input.observationSaids) &&
        (input.observationSaids.length !== 18 || new Set(input.observationSaids).size !== 18)) ||
        ('measurementSaids' in input &&
          Array.isArray(input.measurementSaids) &&
          (input.measurementSaids.length !== 15 || new Set(input.measurementSaids).size !== 15)))
    )
      return { kind: 'Rejected', reason: 'RequiredSetIncomplete' };
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (incomplete(input)) return { kind: 'Rejected', reason: 'RequiredSetIncomplete' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'EvidenceOnly',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(evaluationClosureSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', closure: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationClosure(input: unknown): EvaluationClosureDecoding {
  if (!Value.Check(evaluationClosureSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (incomplete(input)) return { kind: 'Rejected', reason: 'RequiredSetIncomplete' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', closure: structuredClone(input) };
}
