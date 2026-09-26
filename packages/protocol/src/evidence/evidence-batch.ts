import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvidenceEvent, evidenceEventSchema, type EvidenceEvent } from './evidence-event.js';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const batchPredecessorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Genesis') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('Previous'), eventSaid: saidSchema },
    { additionalProperties: false },
  ),
]);

export const evidenceBatchSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: saidSchema,
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    startingSequence: safeIntegerSchema,
    endingSequence: safeIntegerSchema,
    predecessor: batchPredecessorSchema,
    eventSaids: Type.Array(saidSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    eventCount: Type.Integer({ minimum: 1, maximum: 32 }),
    encodedByteCount: Type.Integer({ minimum: 1, maximum: 256 * 1_024 }),
  },
  { additionalProperties: false },
);

const evidenceBatchDraftSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    events: Type.Array(evidenceEventSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);

export const evidenceBatchAcknowledgementSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Union([
      Type.Object({ kind: Type.Literal('Accepted') }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal('AlreadyAccepted') }, { additionalProperties: false }),
    ]),
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    batchSaid: saidSchema,
    acceptedThroughSequence: safeIntegerSchema,
    chainHeadSaid: saidSchema,
    receivedAt: timestampSchema,
  },
  { additionalProperties: false },
);

export type EvidenceBatch = Type.Static<typeof evidenceBatchSchema>;
export type EvidenceBatchDraft = Type.Static<typeof evidenceBatchDraftSchema>;
export type EvidenceBatchAcknowledgement = Type.Static<typeof evidenceBatchAcknowledgementSchema>;

type EvidenceBatchInvalidity =
  | 'SchemaInvalid'
  | 'EventInvalid'
  | 'EventIdentityMismatch'
  | 'RunBindingMismatch'
  | 'CausalChainInvalid'
  | 'EncodedByteCountMismatch'
  | 'BatchTooLarge';

export type EvidenceBatchPreparation =
  | { readonly kind: 'Prepared'; readonly batch: EvidenceBatch }
  | {
      readonly kind: 'Rejected';
      readonly reason: EvidenceBatchInvalidity | 'SaidConstructionFailed';
    };

export type EvidenceBatchDecoding =
  | {
      readonly kind: 'Accepted';
      readonly batch: EvidenceBatch;
      readonly events: readonly EvidenceEvent[];
    }
  | {
      readonly kind: 'Rejected';
      readonly reason: EvidenceBatchInvalidity | 'SaidMismatch';
    };

export type EvidenceBatchAcknowledgementDecoding =
  | {
      readonly kind: 'Accepted';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'BatchBindingMismatch' | 'CursorMismatch';
    };

const utf8 = new TextEncoder();

function encodedEventBytes(events: readonly EvidenceEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += utf8.encode(JSON.stringify(event)).byteLength;
  }
  return total;
}

function eventsAreOneChain(
  runId: string,
  events: readonly EvidenceEvent[],
): EvidenceBatchInvalidity | undefined {
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (current === undefined || decodeEvidenceEvent(current).kind !== 'Accepted') {
      return 'EventInvalid';
    }
    if (current.runId !== runId) {
      return 'RunBindingMismatch';
    }
    const previous = events[index - 1];
    if (previous === undefined) {
      continue;
    }
    if (
      current.sequence !== previous.sequence + 1 ||
      current.predecessor.kind !== 'Previous' ||
      current.predecessor.eventSaid !== previous.d
    ) {
      return 'CausalChainInvalid';
    }
  }
  return undefined;
}

function batchSaidMatches(batch: EvidenceBatch): boolean {
  try {
    return new Saider({ qb64: batch.d }).verify(batch, true, false);
  } catch {
    return false;
  }
}

function predecessorsMatch(
  left: EvidenceBatch['predecessor'],
  right: EvidenceEvent['predecessor'],
): boolean {
  if (left.kind === 'Genesis' || right.kind === 'Genesis') {
    return left.kind === right.kind;
  }
  return left.eventSaid === right.eventSaid;
}

export function prepareEvidenceBatch(draft: EvidenceBatchDraft): EvidenceBatchPreparation {
  if (draft.events.length > 32 || encodedEventBytes(draft.events) > 256 * 1_024) {
    return { kind: 'Rejected', reason: 'BatchTooLarge' };
  }
  if (!Value.Check(evidenceBatchDraftSchema, draft)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const invalidity = eventsAreOneChain(draft.runId, draft.events);
  if (invalidity !== undefined) {
    return { kind: 'Rejected', reason: invalidity };
  }
  const first = draft.events[0];
  const last = draft.events.at(-1);
  if (first === undefined || last === undefined) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  try {
    const candidate = {
      version: 1 as const,
      d: '',
      runId: draft.runId,
      evidenceStreamId: draft.evidenceStreamId,
      startingSequence: first.sequence,
      endingSequence: last.sequence,
      predecessor: first.predecessor,
      eventSaids: draft.events.map((event) => event.d),
      eventCount: draft.events.length,
      encodedByteCount: encodedEventBytes(draft.events),
    };
    const saidified: unknown = Saider.saidify(candidate)[1];
    return Value.Check(evidenceBatchSchema, saidified)
      ? { kind: 'Prepared', batch: saidified }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvidenceBatch(
  input: unknown,
  events: readonly EvidenceEvent[],
): EvidenceBatchDecoding {
  if (!Value.Check(evidenceBatchSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!batchSaidMatches(input)) {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  if (events.length !== input.eventCount || events.length !== input.eventSaids.length) {
    return { kind: 'Rejected', reason: 'EventIdentityMismatch' };
  }
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.d !== input.eventSaids[index]) {
      return { kind: 'Rejected', reason: 'EventIdentityMismatch' };
    }
  }
  const invalidity = eventsAreOneChain(input.runId, events);
  if (invalidity !== undefined) {
    return { kind: 'Rejected', reason: invalidity };
  }
  const first = events[0];
  const last = events.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first.sequence !== input.startingSequence ||
    last.sequence !== input.endingSequence ||
    !predecessorsMatch(input.predecessor, first.predecessor)
  ) {
    return { kind: 'Rejected', reason: 'CausalChainInvalid' };
  }
  if (encodedEventBytes(events) !== input.encodedByteCount) {
    return { kind: 'Rejected', reason: 'EncodedByteCountMismatch' };
  }
  return { kind: 'Accepted', batch: input, events };
}

export function decodeEvidenceBatchAcknowledgement(
  input: unknown,
  batch: EvidenceBatch,
): EvidenceBatchAcknowledgementDecoding {
  if (!Value.Check(evidenceBatchAcknowledgementSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (
    input.runId !== batch.runId ||
    input.evidenceStreamId !== batch.evidenceStreamId ||
    input.batchSaid !== batch.d
  ) {
    return { kind: 'Rejected', reason: 'BatchBindingMismatch' };
  }
  if (
    input.acceptedThroughSequence !== batch.endingSequence ||
    input.chainHeadSaid !== batch.eventSaids.at(-1)
  ) {
    return { kind: 'Rejected', reason: 'CursorMismatch' };
  }
  return { kind: 'Accepted', acknowledgement: input };
}
