import { Binary } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodeEvidenceArtifact,
  evidenceArtifactSchema,
  type EvidenceArtifact,
} from '@devrandom/protocol';

const saidPattern = '[A-Z][A-Za-z0-9_-]{43}';
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const saidSchema = Type.String({ pattern: `^${saidPattern}$` });
const uuidV4Schema = Type.String({
  pattern: `^${uuidPattern}$`,
});
export const evidenceArtifactDocumentIdPattern = `^(?:${saidPattern}|${uuidPattern}:${saidPattern})$`;

export function evidenceArtifactDocumentId(runId: string, artifactSaid: string): string {
  return `${runId}:${artifactSaid}`;
}

const evidenceArtifactDocumentSchema = Type.Object(
  {
    _id: Type.String({ pattern: evidenceArtifactDocumentIdPattern }),
    ownerAid: saidSchema,
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    artifact: evidenceArtifactSchema,
    bytes: Type.Unknown(),
    acceptedAt: Type.Unknown(),
  },
  { additionalProperties: false },
);

export interface EvidenceArtifactDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly runId: string;
  readonly evidenceStreamId: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Binary;
  readonly acceptedAt: Date;
}

export interface AcceptedEvidenceArtifact {
  readonly ownerAid: string;
  readonly runId: string;
  readonly evidenceStreamId: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
  readonly acceptedAt: string;
}

export class EvidenceArtifactDocumentInvalid extends Error {
  constructor() {
    super('EvidenceArtifactDocumentInvalid');
    this.name = 'EvidenceArtifactDocumentInvalid';
  }
}

function exactDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? undefined : date;
}

function artifactBytes(binary: Binary): Uint8Array | undefined {
  if (binary.sub_type !== Binary.SUBTYPE_DEFAULT) {
    return undefined;
  }
  return Uint8Array.from(binary.buffer);
}

export function decodeEvidenceArtifactDocument(input: unknown): AcceptedEvidenceArtifact {
  if (
    !Value.Check(evidenceArtifactDocumentSchema, input) ||
    !(input.bytes instanceof Binary) ||
    !(input.acceptedAt instanceof Date) ||
    Number.isNaN(input.acceptedAt.valueOf()) ||
    (input._id !== input.artifact.d &&
      input._id !== evidenceArtifactDocumentId(input.runId, input.artifact.d))
  ) {
    throw new EvidenceArtifactDocumentInvalid();
  }
  const bytes = artifactBytes(input.bytes);
  if (bytes === undefined) {
    throw new EvidenceArtifactDocumentInvalid();
  }
  const decoded = decodeEvidenceArtifact(input.artifact, bytes);
  if (decoded.kind !== 'Accepted') {
    throw new EvidenceArtifactDocumentInvalid();
  }
  return {
    ownerAid: input.ownerAid,
    runId: input.runId,
    evidenceStreamId: input.evidenceStreamId,
    artifact: decoded.artifact,
    bytes,
    acceptedAt: input.acceptedAt.toISOString(),
  };
}

export function encodeEvidenceArtifactDocument(
  accepted: AcceptedEvidenceArtifact,
): EvidenceArtifactDocument {
  const acceptedAt = exactDate(accepted.acceptedAt);
  if (
    acceptedAt === undefined ||
    decodeEvidenceArtifact(accepted.artifact, accepted.bytes).kind !== 'Accepted'
  ) {
    throw new EvidenceArtifactDocumentInvalid();
  }
  const document: EvidenceArtifactDocument = {
    _id: evidenceArtifactDocumentId(accepted.runId, accepted.artifact.d),
    ownerAid: accepted.ownerAid,
    runId: accepted.runId,
    evidenceStreamId: accepted.evidenceStreamId,
    artifact: accepted.artifact,
    bytes: new Binary(Uint8Array.from(accepted.bytes)),
    acceptedAt,
  };
  decodeEvidenceArtifactDocument(document);
  return document;
}
