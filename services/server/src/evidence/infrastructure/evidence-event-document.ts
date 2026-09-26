import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvidenceEvent, evidenceEventSchema, type EvidenceEvent } from '@devrandom/protocol';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

const evidenceEventDocumentSchema = Type.Object(
  {
    _id: saidSchema,
    ownerAid: saidSchema,
    evidenceStreamId: uuidV4Schema,
    batchSaid: saidSchema,
    runId: uuidV4Schema,
    sequence: safeIntegerSchema,
    event: evidenceEventSchema,
    receivedAt: Type.Unknown(),
  },
  { additionalProperties: false },
);

export interface EvidenceEventDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evidenceStreamId: string;
  readonly batchSaid: string;
  readonly runId: string;
  readonly sequence: number;
  readonly event: EvidenceEvent;
  readonly receivedAt: Date;
}

export interface AcceptedEvidenceEvent {
  readonly ownerAid: string;
  readonly evidenceStreamId: string;
  readonly batchSaid: string;
  readonly event: EvidenceEvent;
  readonly receivedAt: string;
}

export class EvidenceEventDocumentInvalid extends Error {
  constructor() {
    super('EvidenceEventDocumentInvalid');
    this.name = 'EvidenceEventDocumentInvalid';
  }
}

function exactDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? undefined : date;
}

export function decodeEvidenceEventDocument(input: unknown): AcceptedEvidenceEvent {
  if (
    !Value.Check(evidenceEventDocumentSchema, input) ||
    !(input.receivedAt instanceof Date) ||
    Number.isNaN(input.receivedAt.valueOf()) ||
    input._id !== input.event.d ||
    input.runId !== input.event.runId ||
    input.sequence !== input.event.sequence
  ) {
    throw new EvidenceEventDocumentInvalid();
  }
  const decoded = decodeEvidenceEvent(input.event);
  if (decoded.kind !== 'Accepted') {
    throw new EvidenceEventDocumentInvalid();
  }
  return {
    ownerAid: input.ownerAid,
    evidenceStreamId: input.evidenceStreamId,
    batchSaid: input.batchSaid,
    event: decoded.event,
    receivedAt: input.receivedAt.toISOString(),
  };
}

export function encodeEvidenceEventDocument(
  accepted: AcceptedEvidenceEvent,
): EvidenceEventDocument {
  const receivedAt = exactDate(accepted.receivedAt);
  if (receivedAt === undefined || decodeEvidenceEvent(accepted.event).kind !== 'Accepted') {
    throw new EvidenceEventDocumentInvalid();
  }
  const document: EvidenceEventDocument = {
    _id: accepted.event.d,
    ownerAid: accepted.ownerAid,
    evidenceStreamId: accepted.evidenceStreamId,
    batchSaid: accepted.batchSaid,
    runId: accepted.event.runId,
    sequence: accepted.event.sequence,
    event: accepted.event,
    receivedAt,
  };
  decodeEvidenceEventDocument(document);
  return document;
}
