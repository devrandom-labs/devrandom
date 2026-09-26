import { Buffer } from 'node:buffer';

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
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const trialPhase = Type.Object(
  {
    kind: Type.Literal('Trial'),
    manifestSaid: said,
    arm: Type.Union(
      (['H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((arm) => Type.Literal(arm)),
    ),
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    attempt: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
);

export const evaluationProviderUsageReceiptInputSchema = Type.Object(
  {
    evaluationId: uuid,
    streamId: uuid,
    harnessRevisionSaid: said,
    phase: trialPhase,
    modelExchangeEventSaid: said,
    requestOrdinal: count,
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    responseId: Type.String({ minLength: 1, maxLength: 256 }),
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    totalTokens: count,
    spendMicroUsd: count,
    providerReportArtifactSaid: said,
  },
  { additionalProperties: false },
);

export const evaluationProviderUsageReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('EvaluationProviderUsageReceipt'),
    ...evaluationProviderUsageReceiptInputSchema.properties,
  },
  { additionalProperties: false },
);

export type EvaluationProviderUsageReceiptInput = Type.Static<
  typeof evaluationProviderUsageReceiptInputSchema
>;
export type EvaluationProviderUsageReceipt = Type.Static<
  typeof evaluationProviderUsageReceiptSchema
>;
export type EvaluationProviderUsageReceiptPreparation =
  | {
      readonly kind: 'Prepared';
      readonly receipt: EvaluationProviderUsageReceipt;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'ArithmeticInvalid' | 'TooLarge' };
export type EvaluationProviderUsageReceiptDecoding =
  | {
      readonly kind: 'Accepted';
      readonly receipt: EvaluationProviderUsageReceipt;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected' };

const maximumReceiptBytes = 8 * 1_024;

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .map(([key, item]) => [key, ordered(item)]),
    );
  }
  return value;
}

function valid(receipt: EvaluationProviderUsageReceipt): boolean {
  const total = receipt.inputTokens + receipt.outputTokens;
  const cached = receipt.cacheReadTokens + receipt.cacheWriteTokens;
  return (
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(cached) &&
    cached <= receipt.inputTokens &&
    total === receipt.totalTokens &&
    (receipt.phase.arm === 'H1TaskSearch' || receipt.phase.attempt === 1)
  );
}

/** Parent-only exact raw evidence; the provider's original frame is separately addressable. */
export function prepareEvaluationProviderUsageReceipt(
  input: unknown,
): EvaluationProviderUsageReceiptPreparation {
  if (!Value.Check(evaluationProviderUsageReceiptInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const receipt: EvaluationProviderUsageReceipt = {
    version: 1,
    kind: 'EvaluationProviderUsageReceipt',
    ...structuredClone(input),
  };
  if (!valid(receipt)) return { kind: 'Rejected', reason: 'ArithmeticInvalid' };
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(receipt)));
  if (bytes.byteLength > maximumReceiptBytes) return { kind: 'Rejected', reason: 'TooLarge' };
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  return artifact.kind === 'Prepared'
    ? { kind: 'Prepared', receipt, artifact: artifact.artifact, bytes }
    : { kind: 'Rejected', reason: 'TooLarge' };
}

export function decodeEvaluationProviderUsageReceipt(
  artifact: unknown,
  bytes: unknown,
): EvaluationProviderUsageReceiptDecoding {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumReceiptBytes)
    return { kind: 'Rejected' };
  const decodedArtifact = decodeEvidenceArtifact(artifact, bytes);
  if (decodedArtifact.kind !== 'Accepted') return { kind: 'Rejected' };
  if (decodedArtifact.artifact.mediaType !== 'application/json') return { kind: 'Rejected' };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Value.Check(evaluationProviderUsageReceiptSchema, parsed) || !valid(parsed))
      return { kind: 'Rejected' };
    const canonical = new TextEncoder().encode(JSON.stringify(ordered(parsed)));
    if (!Buffer.from(canonical).equals(Buffer.from(bytes))) return { kind: 'Rejected' };
    return {
      kind: 'Accepted',
      receipt: parsed,
      artifact: decodedArtifact.artifact,
      bytes: Uint8Array.from(bytes),
    };
  } catch {
    return { kind: 'Rejected' };
  }
}
