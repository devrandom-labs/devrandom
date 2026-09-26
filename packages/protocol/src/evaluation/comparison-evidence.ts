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
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const conditionId = Type.String({ minLength: 1, maxLength: 96, pattern: '^[a-z][a-z0-9._-]*$' });
const slot = Type.Object(
  {
    arm: Type.Union([
      Type.Literal('H1'),
      Type.Literal('C1'),
      Type.Literal('C2'),
      Type.Literal('C3'),
      Type.Literal('H1TaskSearch'),
    ]),
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    attempt: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
);
const usage = Type.Object(
  {
    providerRequests: count,
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    spendMicroUsd: count,
    elapsedMilliseconds: count,
    repeatedFailures: count,
    unsafeProposals: count,
    unsafePrevented: count,
    unsafeEffects: count,
  },
  { additionalProperties: false },
);
const measured = Type.Object(
  {
    kind: Type.Literal('Measured'),
    artifactSaid: said,
    publicConditionIds: Type.Array(conditionId, { maxItems: 32, uniqueItems: true }),
    heldOutConditionIds: Type.Array(said, { maxItems: 32, uniqueItems: true }),
    usage,
  },
  { additionalProperties: false },
);

/** Parent-produced outcome of one M-locked slot; raw protected bytes stay ciphertext. */
export const trialObservationEvidenceSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('TrialObservationEvidence'),
    evaluationId: uuid,
    manifestSaid: said,
    harnessRevisionSaid: said,
    observation: Type.Object({ slot, disposition: measured }, { additionalProperties: false }),
    capturedSourceSaid: said,
    trialEvidenceHeadSaid: said,
    trialCleanupReceiptSaid: said,
    publicObservations: Type.Array(
      Type.Object(
        {
          conditionId,
          rawObservationSaid: said,
          verdict: Type.Union([Type.Literal('Pass'), Type.Literal('Fail')]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    protectedObservationSaid: said,
    protectedVerdict: Type.Union([Type.Literal('Pass'), Type.Literal('Fail')]),
    protectedCleanupReceiptSaid: said,
    providerUsageEventSaids: Type.Array(said, { maxItems: 50, uniqueItems: true }),
  },
  { additionalProperties: false },
);

/** Parent-produced descriptive measurement after the domain law selects task-search attempt. */
export const comparisonMeasurementEvidenceSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('ComparisonMeasurementEvidence'),
    evaluationId: uuid,
    manifestSaid: said,
    harnessRevisionSaid: said,
    measurement: Type.Object(
      {
        slot,
        artifactSaid: said,
        fullContractAccepted: Type.Boolean(),
        publicAccepted: count,
        heldOutAccepted: count,
        usage,
      },
      { additionalProperties: false },
    ),
    sourceObservationSaids: Type.Array(said, { minItems: 1, maxItems: 2, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type TrialObservationEvidence = Type.Static<typeof trialObservationEvidenceSchema>;
export type ComparisonMeasurementEvidence = Type.Static<typeof comparisonMeasurementEvidenceSchema>;
export type ComparisonEvidenceRejection =
  'SchemaInvalid' | 'BindingInvalid' | 'ArtifactInvalid' | 'NoncanonicalBytes';
type Prepared<Evidence> =
  | {
      readonly kind: 'Prepared';
      readonly evidence: Evidence;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: ComparisonEvidenceRejection };
type Decoded<Evidence> =
  | {
      readonly kind: 'Accepted';
      readonly evidence: Evidence;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: ComparisonEvidenceRejection };

const maximumBytes = 128 * 1024;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sorted(value)));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validUsage(value: Type.Static<typeof usage>): boolean {
  return value.unsafePrevented + value.unsafeEffects <= value.unsafeProposals;
}

function validObservation(value: TrialObservationEvidence): boolean {
  const disposition = value.observation.disposition;
  const publicIds = value.publicObservations.map((item) => item.conditionId);
  const passedIds = value.publicObservations
    .filter((item) => item.verdict === 'Pass')
    .map((item) => item.conditionId);
  return (
    validUsage(disposition.usage) &&
    unique(publicIds) &&
    unique(value.publicObservations.map((item) => item.rawObservationSaid)) &&
    JSON.stringify(disposition.publicConditionIds) === JSON.stringify(passedIds) &&
    (value.protectedVerdict === 'Pass') === (disposition.heldOutConditionIds.length === 1) &&
    (value.observation.slot.arm === 'H1TaskSearch' || value.observation.slot.attempt === 1)
  );
}

function validMeasurement(value: ComparisonMeasurementEvidence): boolean {
  return (
    validUsage(value.measurement.usage) &&
    value.sourceObservationSaids.length ===
      (value.measurement.slot.arm === 'H1TaskSearch' ? 2 : 1) &&
    (value.measurement.slot.arm === 'H1TaskSearch' || value.measurement.slot.attempt === 1) &&
    value.measurement.publicAccepted <= 32 &&
    value.measurement.heldOutAccepted <= 1
  );
}

function prepare<Evidence>(value: Evidence): Prepared<Evidence> {
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  return artifact.kind === 'Prepared'
    ? { kind: 'Prepared', evidence: structuredClone(value), artifact: artifact.artifact, bytes }
    : { kind: 'Rejected', reason: 'ArtifactInvalid' };
}

function decode<Evidence>(
  artifact: unknown,
  bytes: Uint8Array,
  validate: (value: unknown) => value is Evidence,
): Decoded<Evidence> {
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  const checked = decodeEvidenceArtifact(artifact, bytes);
  if (checked.kind !== 'Accepted' || checked.artifact.mediaType !== 'application/json')
    return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!validate(value)) return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (text !== new TextDecoder().decode(canonicalBytes(value)))
    return { kind: 'Rejected', reason: 'NoncanonicalBytes' };
  return {
    kind: 'Accepted',
    evidence: value,
    artifact: checked.artifact,
    bytes: Uint8Array.from(bytes),
  };
}

export function prepareTrialObservationEvidence(
  input: unknown,
): Prepared<TrialObservationEvidence> {
  if (!Value.Check(trialObservationEvidenceSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (!validObservation(input)) return { kind: 'Rejected', reason: 'BindingInvalid' };
  return prepare(input);
}

export function decodeTrialObservationEvidence(
  artifact: unknown,
  bytes: Uint8Array,
): Decoded<TrialObservationEvidence> {
  return decode(
    artifact,
    bytes,
    (value): value is TrialObservationEvidence =>
      Value.Check(trialObservationEvidenceSchema, value) && validObservation(value),
  );
}

export function prepareComparisonMeasurementEvidence(
  input: unknown,
): Prepared<ComparisonMeasurementEvidence> {
  if (!Value.Check(comparisonMeasurementEvidenceSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (!validMeasurement(input)) return { kind: 'Rejected', reason: 'BindingInvalid' };
  return prepare(input);
}

export function decodeComparisonMeasurementEvidence(
  artifact: unknown,
  bytes: Uint8Array,
): Decoded<ComparisonMeasurementEvidence> {
  return decode(
    artifact,
    bytes,
    (value): value is ComparisonMeasurementEvidence =>
      Value.Check(comparisonMeasurementEvidenceSchema, value) && validMeasurement(value),
  );
}
