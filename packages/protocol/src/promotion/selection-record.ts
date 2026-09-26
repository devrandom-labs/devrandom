import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const promotionSelectionRecordInputSchema = Type.Object(
  {
    taskId: uuid,
    taskRevisionSaid: said,
    harnessLineageId: uuid,
    expectedIncumbentRevisionSaid: said,
    expectedPointerVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    evaluationManifestSaid: said,
    evaluationClosureSaid: said,
    hypothesisSaid: said,
    selection: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('Activate'),
          candidateRevisionSaid: said,
          artifactSaids: Type.Array(said, { minItems: 3, maxItems: 3 }),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal('RetainIncumbent') }, { additionalProperties: false }),
    ]),
  },
  { additionalProperties: false },
);

export const promotionSelectionRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('PromotionSelection'),
    ...promotionSelectionRecordInputSchema.properties,
  },
  { additionalProperties: false },
);

export type PromotionSelectionRecordInput = Type.Static<typeof promotionSelectionRecordInputSchema>;
export type PromotionSelectionRecord = Type.Static<typeof promotionSelectionRecordSchema>;
export type PromotionSelectionRecordPreparation =
  | { readonly kind: 'Prepared'; readonly record: PromotionSelectionRecord }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'IncumbentAsSuccessor' | 'SaidConstructionFailed';
    };
export type PromotionSelectionRecordDecoding =
  | { readonly kind: 'Accepted'; readonly record: PromotionSelectionRecord }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'IncumbentAsSuccessor' | 'SaidMismatch';
    };

function incumbentAsSuccessor(input: PromotionSelectionRecordInput): boolean {
  return (
    input.selection.kind === 'Activate' &&
    input.selection.candidateRevisionSaid === input.expectedIncumbentRevisionSaid
  );
}

export function preparePromotionSelectionRecord(
  input: unknown,
): PromotionSelectionRecordPreparation {
  if (!Value.Check(promotionSelectionRecordInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (incumbentAsSuccessor(input)) return { kind: 'Rejected', reason: 'IncumbentAsSuccessor' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'PromotionSelection',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(promotionSelectionRecordSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', record: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodePromotionSelectionRecord(input: unknown): PromotionSelectionRecordDecoding {
  if (!Value.Check(promotionSelectionRecordSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (incumbentAsSuccessor(input)) return { kind: 'Rejected', reason: 'IncumbentAsSuccessor' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', record: structuredClone(input) };
}
