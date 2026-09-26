import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { taskBudgetsSchema } from '../task/task-command.js';
import { runProjectionSchema } from './run-http.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const instant = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const position = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const runContinuationRequestSchema = Type.Object(
  {
    version: Type.Literal(1),
    expectedRunVersion: position,
    predecessorCheckpointSaid: said,
    predecessorSealSaid: said,
    predecessorHeadSaid: said,
    successorIncarnationId: uuid,
    successorStreamId: uuid,
    expectedActivePointerVersion: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
    expectedActivationReceiptSaid: said,
  },
  { additionalProperties: false },
);

const segmentBody = {
  version: Type.Literal(1),
  kind: Type.Literal('RunSuccessorSegment'),
  runId: uuid,
  taskId: uuid,
  taskRevisionSaid: said,
  ownerAid: said,
  personalAgentAid: said,
  taskMandateSaid: said,
  fromRunVersion: position,
  predecessor: Type.Object(
    {
      incarnationId: uuid,
      evidenceStreamId: uuid,
      checkpointSaid: said,
      sealExchangeSaid: said,
      finalSequence: position,
      chainHeadSaid: said,
    },
    { additionalProperties: false },
  ),
  successor: Type.Object(
    { incarnationId: uuid, evidenceStreamId: uuid, harnessRevisionSaid: said },
    { additionalProperties: false },
  ),
  activation: Type.Object(
    { pointerVersion: Type.Integer({ minimum: 2 }), decisionReceiptSaid: said },
    { additionalProperties: false },
  ),
  consumedBudget: taskBudgetsSchema,
  admittedAt: instant,
};

export const runSuccessorSegmentInputSchema = Type.Object(segmentBody, {
  additionalProperties: false,
});
export const runSuccessorSegmentSchema = Type.Object(
  { d: said, ...segmentBody },
  { additionalProperties: false },
);
export const runContinuationReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Union([Type.Literal('Admitted'), Type.Literal('Equivalent')]),
    run: runProjectionSchema,
    segment: runSuccessorSegmentSchema,
  },
  { additionalProperties: false },
);

export type RunContinuationRequest = Type.Static<typeof runContinuationRequestSchema>;
export type RunSuccessorSegmentInput = Type.Static<typeof runSuccessorSegmentInputSchema>;
export type RunSuccessorSegment = Type.Static<typeof runSuccessorSegmentSchema>;
export type RunContinuationReceipt = Type.Static<typeof runContinuationReceiptSchema>;

export function prepareRunSuccessorSegment(
  input: unknown,
):
  | { readonly kind: 'Prepared'; readonly segment: RunSuccessorSegment }
  | { readonly kind: 'Rejected' } {
  if (!Value.Check(runSuccessorSegmentInputSchema, input)) return { kind: 'Rejected' };
  const admittedAt = new Date(input.admittedAt);
  if (
    !Number.isFinite(admittedAt.valueOf()) ||
    admittedAt.toISOString() !== input.admittedAt ||
    input.predecessor.incarnationId === input.successor.incarnationId ||
    input.predecessor.evidenceStreamId === input.successor.evidenceStreamId
  )
    return { kind: 'Rejected' };
  try {
    const document: unknown = Saider.saidify({ d: '', ...structuredClone(input) })[1];
    return Value.Check(runSuccessorSegmentSchema, document)
      ? { kind: 'Prepared', segment: document }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
}

export function decodeRunSuccessorSegment(
  input: unknown,
):
  | { readonly kind: 'Accepted'; readonly segment: RunSuccessorSegment }
  | { readonly kind: 'Rejected' } {
  if (!Value.Check(runSuccessorSegmentSchema, input)) return { kind: 'Rejected' };
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'd'));
  const prepared = prepareRunSuccessorSegment(body);
  return prepared.kind === 'Prepared' && prepared.segment.d === input.d
    ? { kind: 'Accepted', segment: structuredClone(input) }
    : { kind: 'Rejected' };
}
