import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodeEvidenceBatch,
  decodeEvidenceBatchAcknowledgement,
  evidenceBatchAcknowledgementSchema,
  evidenceBatchSchema,
  type EvidenceBatch,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
} from '@devrandom/protocol';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const commandFingerprintSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

const evidenceBatchDocumentSchema = Type.Object(
  {
    _id: saidSchema,
    ownerAid: saidSchema,
    commandFingerprint: commandFingerprintSchema,
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    startingSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    batch: evidenceBatchSchema,
    acknowledgement: evidenceBatchAcknowledgementSchema,
    receivedAt: Type.Unknown(),
  },
  { additionalProperties: false },
);

export interface EvidenceBatchDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly commandFingerprint: string;
  readonly runId: string;
  readonly evidenceStreamId: string;
  readonly startingSequence: number;
  readonly batch: EvidenceBatch;
  readonly acknowledgement: EvidenceBatchAcknowledgement;
  readonly receivedAt: Date;
}

export interface AcceptedEvidenceBatch {
  readonly ownerAid: string;
  readonly commandFingerprint: string;
  readonly batch: EvidenceBatch;
  readonly events: readonly EvidenceEvent[];
  readonly acknowledgement: EvidenceBatchAcknowledgement;
}

export class EvidenceBatchDocumentInvalid extends Error {
  constructor() {
    super('EvidenceBatchDocumentInvalid');
    this.name = 'EvidenceBatchDocumentInvalid';
  }
}

function exactDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? undefined : date;
}

export function decodeEvidenceBatchDocument(
  input: unknown,
  events: readonly EvidenceEvent[],
): AcceptedEvidenceBatch {
  if (
    !Value.Check(evidenceBatchDocumentSchema, input) ||
    !(input.receivedAt instanceof Date) ||
    Number.isNaN(input.receivedAt.valueOf()) ||
    input._id !== input.batch.d ||
    input.runId !== input.batch.runId ||
    input.evidenceStreamId !== input.batch.evidenceStreamId ||
    input.startingSequence !== input.batch.startingSequence ||
    input.receivedAt.toISOString() !== input.acknowledgement.receivedAt
  ) {
    throw new EvidenceBatchDocumentInvalid();
  }
  const decoded = decodeEvidenceBatch(input.batch, events);
  const acknowledgement = decodeEvidenceBatchAcknowledgement(input.acknowledgement, input.batch);
  if (decoded.kind !== 'Accepted' || acknowledgement.kind !== 'Accepted') {
    throw new EvidenceBatchDocumentInvalid();
  }
  return {
    ownerAid: input.ownerAid,
    commandFingerprint: input.commandFingerprint,
    batch: decoded.batch,
    events: decoded.events,
    acknowledgement: acknowledgement.acknowledgement,
  };
}

export function encodeEvidenceBatchDocument(
  accepted: AcceptedEvidenceBatch,
): EvidenceBatchDocument {
  const decoded = decodeEvidenceBatch(accepted.batch, accepted.events);
  const acknowledgement = decodeEvidenceBatchAcknowledgement(
    accepted.acknowledgement,
    accepted.batch,
  );
  const receivedAt = exactDate(accepted.acknowledgement.receivedAt);
  if (
    decoded.kind !== 'Accepted' ||
    acknowledgement.kind !== 'Accepted' ||
    receivedAt === undefined
  ) {
    throw new EvidenceBatchDocumentInvalid();
  }
  const document: EvidenceBatchDocument = {
    _id: accepted.batch.d,
    ownerAid: accepted.ownerAid,
    commandFingerprint: accepted.commandFingerprint,
    runId: accepted.batch.runId,
    evidenceStreamId: accepted.batch.evidenceStreamId,
    startingSequence: accepted.batch.startingSequence,
    batch: decoded.batch,
    acknowledgement: acknowledgement.acknowledgement,
    receivedAt,
  };
  decodeEvidenceBatchDocument(document, accepted.events);
  return document;
}
