import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvaluationEvidenceEvent, type EvaluationEvidenceEvent } from './evidence-event.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const predecessor = Type.Union([
  Type.Object({ kind: Type.Literal('Genesis') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Previous'), eventSaid: said }, { additionalProperties: false }),
]);

export const evaluationEvidenceBatchSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    evaluationId: uuid,
    streamId: uuid,
    originRunId: uuid,
    taskId: uuid,
    startingSequence: sequence,
    endingSequence: sequence,
    predecessor,
    eventSaids: Type.Array(said, { minItems: 1, maxItems: 32, uniqueItems: true }),
    eventCount: Type.Integer({ minimum: 1, maximum: 32 }),
    encodedByteCount: Type.Integer({ minimum: 1, maximum: 256 * 1024 }),
  },
  { additionalProperties: false },
);
export type EvaluationEvidenceBatch = Type.Static<typeof evaluationEvidenceBatchSchema>;
export type EvaluationEvidenceBatchRejection =
  | 'SchemaInvalid'
  | 'EventInvalid'
  | 'EventBindingMismatch'
  | 'CausalChainInvalid'
  | 'BatchTooLarge'
  | 'BatchMismatch'
  | 'SaidMismatch'
  | 'SaidConstructionFailed';
export type EvaluationEvidenceBatchPreparation =
  | { readonly kind: 'Prepared'; readonly batch: EvaluationEvidenceBatch }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationEvidenceBatchRejection };
export type EvaluationEvidenceBatchDecoding =
  | { readonly kind: 'Accepted'; readonly batch: EvaluationEvidenceBatch }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationEvidenceBatchRejection };

function batchEvents(
  events: readonly EvaluationEvidenceEvent[],
):
  | { readonly kind: 'Valid'; readonly encodedBytes: number }
  | { readonly kind: 'Invalid'; readonly reason: EvaluationEvidenceBatchRejection } {
  if (events.length === 0 || events.length > 32)
    return { kind: 'Invalid', reason: 'BatchTooLarge' };
  let encodedBytes = 0;
  const first = events[0];
  if (first === undefined) return { kind: 'Invalid', reason: 'SchemaInvalid' };
  for (const [index, event] of events.entries()) {
    if (decodeEvaluationEvidenceEvent(event).kind !== 'Accepted')
      return { kind: 'Invalid', reason: 'EventInvalid' };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bytes > 64 * 1024) return { kind: 'Invalid', reason: 'BatchTooLarge' };
    encodedBytes += bytes;
    if (
      event.evaluationId !== first.evaluationId ||
      event.streamId !== first.streamId ||
      event.originRunId !== first.originRunId ||
      event.taskId !== first.taskId ||
      event.taskRevisionSaid !== first.taskRevisionSaid ||
      event.personalAgentAid !== first.personalAgentAid ||
      event.taskMandateSaid !== first.taskMandateSaid
    )
      return { kind: 'Invalid', reason: 'EventBindingMismatch' };
    const prior = events[index - 1];
    if (
      prior !== undefined &&
      (event.sequence !== prior.sequence + 1 ||
        event.previous.kind !== 'Previous' ||
        event.previous.eventSaid !== prior.d)
    )
      return { kind: 'Invalid', reason: 'CausalChainInvalid' };
  }
  if (encodedBytes > 256 * 1024) return { kind: 'Invalid', reason: 'BatchTooLarge' };
  return { kind: 'Valid', encodedBytes };
}

export function prepareEvaluationEvidenceBatch(
  events: readonly EvaluationEvidenceEvent[],
): EvaluationEvidenceBatchPreparation {
  const inspection = batchEvents(events);
  if (inspection.kind === 'Invalid') return { kind: 'Rejected', reason: inspection.reason };
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined)
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      evaluationId: first.evaluationId,
      streamId: first.streamId,
      originRunId: first.originRunId,
      taskId: first.taskId,
      startingSequence: first.sequence,
      endingSequence: last.sequence,
      predecessor: first.previous,
      eventSaids: events.map((event) => event.d),
      eventCount: events.length,
      encodedByteCount: inspection.encodedBytes,
    })[1];
    if (!Value.Check(evaluationEvidenceBatchSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', batch: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationEvidenceBatch(
  input: unknown,
  events: readonly EvaluationEvidenceEvent[],
): EvaluationEvidenceBatchDecoding {
  if (!Value.Check(evaluationEvidenceBatchSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const inspection = batchEvents(events);
  if (inspection.kind === 'Invalid') return { kind: 'Rejected', reason: inspection.reason };
  const first = events[0];
  const last = events.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.evaluationId !== first.evaluationId ||
    input.streamId !== first.streamId ||
    input.originRunId !== first.originRunId ||
    input.taskId !== first.taskId ||
    input.startingSequence !== first.sequence ||
    input.endingSequence !== last.sequence ||
    input.eventCount !== events.length ||
    input.encodedByteCount !== inspection.encodedBytes ||
    JSON.stringify(input.predecessor) !== JSON.stringify(first.previous) ||
    input.eventSaids.some((said_, index) => said_ !== events[index]?.d)
  )
    return { kind: 'Rejected', reason: 'BatchMismatch' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', batch: structuredClone(input) };
}
