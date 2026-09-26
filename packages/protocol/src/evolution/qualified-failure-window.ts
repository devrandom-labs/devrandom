import { TextDecoder, TextEncoder } from 'node:util';

import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from '../evidence/evidence-artifact.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const maximumBytes = 32 * 1024;

/** Parent-owned public prefix; exact timeline verification happens before preparation. */
export const qualifiedFailureWindowSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('QualifiedFailureWindow'),
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    retainedCheckpointSaid: said,
    retainedSealSaid: said,
    failureEventSaid: said,
    verifierReceiptSaid: said,
    precedingEventSaids: Type.Array(said, { minItems: 1, maxItems: 1000, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type QualifiedFailureWindow = Type.Static<typeof qualifiedFailureWindowSchema>;
export type QualifiedFailureWindowRejection =
  'SchemaInvalid' | 'PrefixInvalid' | 'ArtifactTooLarge' | 'ArtifactInvalid' | 'NoncanonicalBytes';
export type QualifiedFailureWindowPreparation =
  | {
      readonly kind: 'Prepared';
      readonly window: QualifiedFailureWindow;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: QualifiedFailureWindowRejection };
export type QualifiedFailureWindowDecoding =
  | {
      readonly kind: 'Accepted';
      readonly window: QualifiedFailureWindow;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: QualifiedFailureWindowRejection };

function invalidWindow(window: QualifiedFailureWindow): boolean {
  return window.precedingEventSaids.includes(window.failureEventSaid);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key) as unknown)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function prepareQualifiedFailureWindow(input: unknown): QualifiedFailureWindowPreparation {
  if (!Value.Check(qualifiedFailureWindowSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (invalidWindow(input)) return { kind: 'Rejected', reason: 'PrefixInvalid' };
  const bytes = new TextEncoder().encode(canonical(input));
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactTooLarge' };
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  return { kind: 'Prepared', window: structuredClone(input), artifact: artifact.artifact, bytes };
}

export function decodeQualifiedFailureWindow(
  artifact: unknown,
  bytes: Uint8Array,
): QualifiedFailureWindowDecoding {
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactTooLarge' };
  const exact = decodeEvidenceArtifact(artifact, bytes);
  if (exact.kind !== 'Accepted' || exact.artifact.mediaType !== 'application/json')
    return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  let input: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!Value.Check(qualifiedFailureWindowSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (invalidWindow(input)) return { kind: 'Rejected', reason: 'PrefixInvalid' };
  if (text !== canonical(input)) return { kind: 'Rejected', reason: 'NoncanonicalBytes' };
  return {
    kind: 'Accepted',
    window: input,
    artifact: exact.artifact,
    bytes: Uint8Array.from(bytes),
  };
}
