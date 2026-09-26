import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const source = Type.Object(
  {
    episodeSaid: said,
    rawEvidenceSaid: said,
    ownerAid: said,
    repositoryResourceSaid: said,
    corpusSaid: said,
    disclosure: Type.Literal('AuthorizedAnalogy'),
  },
  { additionalProperties: false },
);
export const evaluationSourceInventoryInputSchema = Type.Object(
  {
    taskId: uuid,
    taskRevisionSaid: said,
    ownerAid: said,
    repositoryResourceSaid: said,
    corpusSaid: said,
    experienceMandateSaid: said,
    sources: Type.Array(source, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);
export const evaluationSourceInventorySchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('EvaluationSourceInventory'),
    ...evaluationSourceInventoryInputSchema.properties,
  },
  { additionalProperties: false },
);
export type EvaluationSourceInventory = Type.Static<typeof evaluationSourceInventorySchema>;
export type EvaluationSourceInventoryRejection =
  'SchemaInvalid' | 'SourceDenied' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvaluationSourceInventoryPreparation =
  | { readonly kind: 'Prepared'; readonly inventory: EvaluationSourceInventory }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationSourceInventoryRejection };
export type EvaluationSourceInventoryDecoding =
  | { readonly kind: 'Accepted'; readonly inventory: EvaluationSourceInventory }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationSourceInventoryRejection };

function sourcesDenied(input: Type.Static<typeof evaluationSourceInventoryInputSchema>): boolean {
  const episodes = new Set<string>();
  const raw = new Set<string>();
  for (const candidate of input.sources) {
    if (
      candidate.ownerAid !== input.ownerAid ||
      candidate.repositoryResourceSaid !== input.repositoryResourceSaid ||
      candidate.corpusSaid !== input.corpusSaid ||
      episodes.has(candidate.episodeSaid) ||
      raw.has(candidate.rawEvidenceSaid)
    )
      return true;
    episodes.add(candidate.episodeSaid);
    raw.add(candidate.rawEvidenceSaid);
  }
  return false;
}

export function prepareEvaluationSourceInventory(
  input: unknown,
): EvaluationSourceInventoryPreparation {
  if (!Value.Check(evaluationSourceInventoryInputSchema, input)) {
    if (
      typeof input === 'object' &&
      input !== null &&
      'sources' in input &&
      Array.isArray(input.sources) &&
      input.sources.some(
        (candidate: unknown) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'disclosure' in candidate &&
          candidate.disclosure !== 'AuthorizedAnalogy',
      )
    )
      return { kind: 'Rejected', reason: 'SourceDenied' };
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (sourcesDenied(input)) return { kind: 'Rejected', reason: 'SourceDenied' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'EvaluationSourceInventory',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(evaluationSourceInventorySchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', inventory: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationSourceInventory(input: unknown): EvaluationSourceInventoryDecoding {
  if (!Value.Check(evaluationSourceInventorySchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (sourcesDenied(input)) return { kind: 'Rejected', reason: 'SourceDenied' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', inventory: structuredClone(input) };
}
