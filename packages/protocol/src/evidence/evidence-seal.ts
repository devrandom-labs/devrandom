import Type from 'typebox';
import Value from 'typebox/value';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const evidenceSealExchangeRoute = '/devrandom/evidence/seal/1' as const;

export const evidenceSealPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('EvidenceStreamSeal'),
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    eventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    finalSequence: safeIntegerSchema,
    chainHeadSaid: saidSchema,
    harnessRevisionSaid: saidSchema,
    taskMandateSaid: saidSchema,
  },
  { additionalProperties: false },
);

export type EvidenceSealPayload = Type.Static<typeof evidenceSealPayloadSchema>;

export type EvidenceSealPayloadDecoding =
  | { readonly kind: 'Accepted'; readonly payload: EvidenceSealPayload }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'CursorInvalid' };

export function decodeEvidenceSealPayload(input: unknown): EvidenceSealPayloadDecoding {
  if (!Value.Check(evidenceSealPayloadSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (input.finalSequence + 1 !== input.eventCount) {
    return { kind: 'Rejected', reason: 'CursorInvalid' };
  }
  return { kind: 'Accepted', payload: input };
}
