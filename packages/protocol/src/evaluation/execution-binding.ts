import { validateExecutionBinding } from '@devrandom/domain';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
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
export const evaluationExecutionBindingSchema = Type.Object(
  {
    kind: Type.Literal('Evaluation'),
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    personalAgentAid: said,
    taskMandateSaid: said,
    harnessRevisionSaid: said,
    evaluationId: uuid,
    evaluationLeaseId: uuid,
    evidenceStreamId: uuid,
    phase,
  },
  { additionalProperties: false },
);
export type EvaluationExecutionWireBinding = Type.Static<typeof evaluationExecutionBindingSchema>;
export type EvaluationExecutionBindingDecoding =
  | { readonly kind: 'Accepted'; readonly binding: EvaluationExecutionWireBinding }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        'SchemaInvalid' | 'IdentityInvalid' | 'PredecessorRightsReused' | 'SlotInvalid';
    };

export function decodeEvaluationExecutionBinding(
  input: unknown,
): EvaluationExecutionBindingDecoding {
  if (!Value.Check(evaluationExecutionBindingSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const assessment = validateExecutionBinding(input);
  return assessment.kind === 'Accepted'
    ? { kind: 'Accepted', binding: structuredClone(input) }
    : { kind: 'Rejected', reason: assessment.reason };
}
