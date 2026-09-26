import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
export const protectedEvaluationArtifactInputSchema = Type.Object(
  {
    evaluationId: uuid,
    objectSaid: said,
    purpose: Type.Union([
      Type.Literal('TrialHoldout'),
      Type.Literal('OracleObservation'),
      Type.Literal('TerminalCase'),
    ]),
    segment: Type.Integer({ minimum: 0, maximum: 1023 }),
    nonce: Type.String({ pattern: '^[A-Za-z0-9_-]{16}$' }),
    tag: Type.String({ pattern: '^[A-Za-z0-9_-]{22}$' }),
    ciphertext: Type.String({ minLength: 2, maxLength: 699052, pattern: '^[A-Za-z0-9_-]+$' }),
    plaintextByteCount: Type.Integer({ minimum: 1, maximum: 512 * 1024 }),
  },
  { additionalProperties: false },
);
export const protectedEvaluationArtifactSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('Aes256GcmProtectedArtifact'),
    ...protectedEvaluationArtifactInputSchema.properties,
  },
  { additionalProperties: false },
);
export type ProtectedEvaluationArtifact = Type.Static<typeof protectedEvaluationArtifactSchema>;
export type ProtectedEvaluationArtifactRejection =
  'SchemaInvalid' | 'SaidMismatch' | 'SaidConstructionFailed';
export type ProtectedEvaluationArtifactPreparation =
  | { readonly kind: 'Prepared'; readonly artifact: ProtectedEvaluationArtifact }
  | { readonly kind: 'Rejected'; readonly reason: ProtectedEvaluationArtifactRejection };
export type ProtectedEvaluationArtifactDecoding =
  | { readonly kind: 'Accepted'; readonly artifact: ProtectedEvaluationArtifact }
  | { readonly kind: 'Rejected'; readonly reason: ProtectedEvaluationArtifactRejection };

export function prepareProtectedEvaluationArtifact(
  input: unknown,
): ProtectedEvaluationArtifactPreparation {
  if (!Value.Check(protectedEvaluationArtifactInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'Aes256GcmProtectedArtifact',
      ...structuredClone(input),
    })[1];
    if (!Value.Check(protectedEvaluationArtifactSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', artifact: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeProtectedEvaluationArtifact(
  input: unknown,
): ProtectedEvaluationArtifactDecoding {
  if (!Value.Check(protectedEvaluationArtifactSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', artifact: structuredClone(input) };
}
