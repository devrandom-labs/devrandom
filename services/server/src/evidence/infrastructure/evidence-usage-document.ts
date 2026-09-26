import Type from 'typebox';
import Value from 'typebox/value';

import { evidenceUsageDocumentId } from './evidence-storage-contract.js';

const globalEvidenceByteCeiling = 256 * 1_024 * 1_024;

export const evidenceUsageDocumentSchema = Type.Object(
  {
    _id: Type.Literal(evidenceUsageDocumentId),
    version: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    acceptedBytes: Type.Integer({ minimum: 0, maximum: globalEvidenceByteCeiling }),
  },
  { additionalProperties: false },
);

export type EvidenceUsageDocument = Type.Static<typeof evidenceUsageDocumentSchema>;

export const evidenceUsageInitialDocument = Object.freeze({
  _id: evidenceUsageDocumentId,
  version: 0,
  acceptedBytes: 0,
}) satisfies EvidenceUsageDocument;

export class EvidenceUsageDocumentInvalid extends Error {
  constructor() {
    super('EvidenceUsageDocumentInvalid');
    this.name = 'EvidenceUsageDocumentInvalid';
  }
}

export function decodeEvidenceUsageDocument(input: unknown): EvidenceUsageDocument {
  if (!Value.Check(evidenceUsageDocumentSchema, input)) {
    throw new EvidenceUsageDocumentInvalid();
  }
  return {
    _id: input._id,
    version: input.version,
    acceptedBytes: input.acceptedBytes,
  };
}
