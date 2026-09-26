import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodeVerifiedCheckpoint,
  verifiedCheckpointSchema,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

const evidenceCheckpointDocumentSchema = Type.Object(
  {
    _id: saidSchema,
    ownerAid: saidSchema,
    evidenceStreamId: uuidV4Schema,
    batchSaid: saidSchema,
    runId: uuidV4Schema,
    checkpoint: verifiedCheckpointSchema,
    receivedAt: Type.Unknown(),
  },
  { additionalProperties: false },
);

export interface EvidenceCheckpointDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evidenceStreamId: string;
  readonly batchSaid: string;
  readonly runId: string;
  readonly checkpoint: VerifiedCheckpoint;
  readonly receivedAt: Date;
}

export interface AcceptedEvidenceCheckpoint {
  readonly ownerAid: string;
  readonly evidenceStreamId: string;
  readonly batchSaid: string;
  readonly checkpoint: VerifiedCheckpoint;
  readonly receivedAt: string;
}

export class EvidenceCheckpointDocumentInvalid extends Error {
  constructor() {
    super('EvidenceCheckpointDocumentInvalid');
    this.name = 'EvidenceCheckpointDocumentInvalid';
  }
}

function exactDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? undefined : date;
}

export function decodeEvidenceCheckpointDocument(
  input: unknown,
  completionConditionIds: readonly string[],
): AcceptedEvidenceCheckpoint {
  if (
    !Value.Check(evidenceCheckpointDocumentSchema, input) ||
    !(input.receivedAt instanceof Date) ||
    Number.isNaN(input.receivedAt.valueOf()) ||
    input._id !== input.checkpoint.d ||
    input.runId !== input.checkpoint.runId
  ) {
    throw new EvidenceCheckpointDocumentInvalid();
  }
  const decoded = decodeVerifiedCheckpoint(input.checkpoint, completionConditionIds);
  if (decoded.kind !== 'Accepted') {
    throw new EvidenceCheckpointDocumentInvalid();
  }
  return {
    ownerAid: input.ownerAid,
    evidenceStreamId: input.evidenceStreamId,
    batchSaid: input.batchSaid,
    checkpoint: decoded.checkpoint,
    receivedAt: input.receivedAt.toISOString(),
  };
}

export function encodeEvidenceCheckpointDocument(
  accepted: AcceptedEvidenceCheckpoint,
  completionConditionIds: readonly string[],
): EvidenceCheckpointDocument {
  const decoded = decodeVerifiedCheckpoint(accepted.checkpoint, completionConditionIds);
  const receivedAt = exactDate(accepted.receivedAt);
  if (decoded.kind !== 'Accepted' || receivedAt === undefined) {
    throw new EvidenceCheckpointDocumentInvalid();
  }
  const document: EvidenceCheckpointDocument = {
    _id: accepted.checkpoint.d,
    ownerAid: accepted.ownerAid,
    evidenceStreamId: accepted.evidenceStreamId,
    batchSaid: accepted.batchSaid,
    runId: accepted.checkpoint.runId,
    checkpoint: decoded.checkpoint,
    receivedAt,
  };
  decodeEvidenceCheckpointDocument(document, completionConditionIds);
  return document;
}
