import { createHash } from 'node:crypto';

import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const digestSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const artifactMediaTypeSchema = Type.Union([
  Type.Literal('application/octet-stream'),
  Type.Literal('application/json'),
  Type.Literal('text/plain; charset=utf-8'),
  Type.Literal('text/x-diff; charset=utf-8'),
]);

export const evidenceArtifactSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: saidSchema,
    mediaType: artifactMediaTypeSchema,
    byteLength: Type.Integer({ minimum: 0, maximum: 512 * 1_024 }),
    contentDigest: digestSchema,
  },
  { additionalProperties: false },
);

export type EvidenceArtifact = Type.Static<typeof evidenceArtifactSchema>;
export type EvidenceArtifactMediaType = Type.Static<typeof artifactMediaTypeSchema>;

export type EvidenceArtifactPreparation =
  | { readonly kind: 'Prepared'; readonly artifact: EvidenceArtifact }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'ArtifactTooLarge' | 'MediaTypeInvalid' | 'SaidConstructionFailed';
    };

export type EvidenceArtifactDecoding =
  | { readonly kind: 'Accepted'; readonly artifact: EvidenceArtifact }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        'SchemaInvalid' | 'SaidMismatch' | 'ByteLengthMismatch' | 'ContentDigestMismatch';
    };

function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function saidMatches(artifact: EvidenceArtifact): boolean {
  try {
    return new Saider({ qb64: artifact.d }).verify(artifact, true, false);
  } catch {
    return false;
  }
}

export function prepareEvidenceArtifact(
  bytes: Uint8Array,
  mediaType: string,
): EvidenceArtifactPreparation {
  if (bytes.byteLength > 512 * 1_024) {
    return { kind: 'Rejected', reason: 'ArtifactTooLarge' };
  }
  if (!Value.Check(artifactMediaTypeSchema, mediaType)) {
    return { kind: 'Rejected', reason: 'MediaTypeInvalid' };
  }
  try {
    const candidate = {
      version: 1 as const,
      d: '',
      mediaType,
      byteLength: bytes.byteLength,
      contentDigest: contentDigest(bytes),
    };
    const saidified: unknown = Saider.saidify(candidate)[1];
    return Value.Check(evidenceArtifactSchema, saidified)
      ? { kind: 'Prepared', artifact: saidified }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvidenceArtifact(
  input: unknown,
  bytes: Uint8Array,
): EvidenceArtifactDecoding {
  if (!Value.Check(evidenceArtifactSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!saidMatches(input)) {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  if (input.byteLength !== bytes.byteLength) {
    return { kind: 'Rejected', reason: 'ByteLengthMismatch' };
  }
  if (input.contentDigest !== contentDigest(bytes)) {
    return { kind: 'Rejected', reason: 'ContentDigestMismatch' };
  }
  return { kind: 'Accepted', artifact: input };
}
