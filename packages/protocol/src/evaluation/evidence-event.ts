import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const phase = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Research'),
      policySaid: said,
      role: Type.Union([Type.Literal('DiagnosticRefiner'), Type.Literal('CandidateWorker')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Trial'),
      manifestSaid: said,
      arm: Type.Union(
        (['H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((arm) => Type.Literal(arm)),
      ),
      repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      attempt: Type.Union([Type.Literal(1), Type.Literal(2)]),
    },
    { additionalProperties: false },
  ),
]);
const previous = Type.Union([
  Type.Object({ kind: Type.Literal('Genesis') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Previous'), eventSaid: said }, { additionalProperties: false }),
]);
const detail = Type.Union([
  Type.Object(
    { kind: Type.Literal('ModelExchange'), rawArtifactSaid: said },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ToolProposed'),
      proposalIndex: count,
      toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
      inputArtifactSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ToolAuthorization'),
      proposalEventSaid: said,
      disposition: Type.Union([
        Type.Literal('Allowed'),
        Type.Literal('Denied'),
        Type.Literal('PendingApproval'),
      ]),
      receiptArtifactSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('EffectObserved'),
      authorizationEventSaid: said,
      receiptArtifactSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('UsageDebited'),
      providerRequests: count,
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count,
      cacheWriteTokens: count,
      spendMicroUsd: count,
      elapsedMilliseconds: count,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ArtifactCaptured'),
      artifactSaid: said,
      custody: Type.Union([Type.Literal('Public'), Type.Literal('ProtectedCiphertext')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('SourceRead'), sourceSaid: said, rawArtifactSaid: said },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('TrialStopped'),
      reason: Type.Union([
        Type.Literal('Completed'),
        Type.Literal('Interrupted'),
        Type.Literal('Invalid'),
        Type.Literal('LeaseLost'),
        Type.Literal('BudgetExhausted'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('DataWithheld'),
      reason: Type.Literal('ProtectedSecret'),
      markerSaid: said,
    },
    { additionalProperties: false },
  ),
]);

export const evaluationEvidenceEventInputSchema = Type.Object(
  {
    evaluationId: uuid,
    streamId: uuid,
    originRunId: uuid,
    taskId: uuid,
    taskRevisionSaid: said,
    personalAgentAid: said,
    taskMandateSaid: said,
    harnessRevisionSaid: said,
    phase,
    sequence: count,
    previous,
    occurredAt: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    }),
    detail,
  },
  { additionalProperties: false },
);

export const evaluationEvidenceEventSchema = Type.Object(
  { version: Type.Literal(1), d: said, ...evaluationEvidenceEventInputSchema.properties },
  { additionalProperties: false },
);
export type EvaluationEvidenceEvent = Type.Static<typeof evaluationEvidenceEventSchema>;
export type EvaluationEvidenceEventRejection =
  'SchemaInvalid' | 'ChainInvalid' | 'SlotInvalid' | 'SaidMismatch' | 'SaidConstructionFailed';
export type EvaluationEvidenceEventPreparation =
  | { readonly kind: 'Prepared'; readonly event: EvaluationEvidenceEvent }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationEvidenceEventRejection };
export type EvaluationEvidenceEventDecoding =
  | { readonly kind: 'Accepted'; readonly event: EvaluationEvidenceEvent }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationEvidenceEventRejection };

function invalidEvent(
  input: Type.Static<typeof evaluationEvidenceEventInputSchema>,
): EvaluationEvidenceEventRejection | undefined {
  if (
    input.evaluationId === input.originRunId ||
    input.streamId === input.originRunId ||
    input.streamId === input.evaluationId
  )
    return 'SchemaInvalid';
  if ((input.sequence === 0) !== (input.previous.kind === 'Genesis')) return 'ChainInvalid';
  if (
    input.phase.kind === 'Trial' &&
    input.phase.arm !== 'H1TaskSearch' &&
    input.phase.attempt !== 1
  )
    return 'SlotInvalid';
  return undefined;
}

export function prepareEvaluationEvidenceEvent(input: unknown): EvaluationEvidenceEventPreparation {
  if (!Value.Check(evaluationEvidenceEventInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalid = invalidEvent(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  try {
    const document: unknown = Saider.saidify({ version: 1, d: '', ...structuredClone(input) })[1];
    if (!Value.Check(evaluationEvidenceEventSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', event: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationEvidenceEvent(input: unknown): EvaluationEvidenceEventDecoding {
  if (!Value.Check(evaluationEvidenceEventSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalid = invalidEvent(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', event: structuredClone(input) };
}
