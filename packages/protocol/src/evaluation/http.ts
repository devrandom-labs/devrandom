import { Buffer } from 'node:buffer';

import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvidenceArtifact, evidenceArtifactSchema } from '../evidence/evidence-artifact.js';
import { evaluationClosureSchema } from './closure.js';
import { evaluationEvidenceBatchSchema } from './evidence-batch.js';
import { evaluationEvidenceEventSchema } from './evidence-event.js';
import { evaluationExecutionProfileSchema } from './execution-profile.js';
import { evaluationManifestInputSchema, evaluationManifestSchema } from './manifest.js';
import { protectedEvaluationArtifactSchema } from './protected-artifact.js';
import { evaluationSourceInventorySchema } from './source-inventory.js';
import { evaluationVerifierBundleSchema } from './verifier-bundle.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const fingerprint = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const timestamp = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const evaluationPreparationCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    taskId: uuid,
    taskRevisionSaid: said,
    sourceInventory: evaluationSourceInventorySchema,
    executionProfile: evaluationExecutionProfileSchema,
  },
  { additionalProperties: false },
);

/** Hosted Access supplies the authenticated owner; the command cannot override it. */
export const evaluationAdmissionCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    taskId: uuid,
    taskRevisionSaid: said,
    originRunId: uuid,
    retainedCheckpointSaid: said,
    retainedSealSaid: said,
    expectedActiveRevisionSaid: said,
    personalAgentAid: said,
    taskMandateSaid: said,
    policySaid: said,
    executionProfileSaid: said,
    sourceInventorySaid: said,
    allocation: evaluationManifestInputSchema.properties.allocation,
  },
  { additionalProperties: false },
);

export const evaluationAdmissionReceiptSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Admitted'),
      evaluationId: uuid,
      version: Type.Integer({ minimum: 1 }),
      lease: Type.Object(
        {
          evaluationId: uuid,
          leaseId: uuid,
          version: Type.Integer({ minimum: 1 }),
          serverTime: timestamp,
          expiresAt: timestamp,
        },
        { additionalProperties: false },
      ),
      evidenceStreamId: uuid,
      reservationSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Blocked'),
      gate: Type.Union(
        (['Profile', 'Source', 'Authority', 'Budget', 'Qualification', 'Evidence'] as const).map(
          (gate) => Type.Literal(gate),
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Conflict') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Unavailable') }, { additionalProperties: false }),
]);

export const evaluationLeaseRenewalCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    evaluationId: uuid,
    leaseId: uuid,
    expectedEvaluationVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const evaluationLeaseSchema = Type.Object(
  {
    evaluationId: uuid,
    leaseId: uuid,
    version: Type.Integer({ minimum: 1 }),
    serverTime: timestamp,
    expiresAt: timestamp,
  },
  { additionalProperties: false },
);

export const evaluationLeaseRenewalReceiptSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal('Renewed'), Type.Literal('AlreadyRenewed')]),
      evaluationId: uuid,
      version: Type.Integer({ minimum: 1 }),
      lease: evaluationLeaseSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Lost'), evaluationId: uuid }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Blocked'),
      gate: Type.Union([Type.Literal('Authority'), Type.Literal('Budget'), Type.Literal('Closed')]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Conflict') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Unavailable') }, { additionalProperties: false }),
]);

/** The owner submits exact parent-held verifier bytes and all four ciphertext descriptors before M locks. */
export const evaluationManifestLockCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    expectedEvaluationVersion: Type.Integer({ minimum: 1 }),
    leaseId: uuid,
    manifest: evaluationManifestSchema,
    verifierBundle: evaluationVerifierBundleSchema,
    verifierBundleBytesBase64Url: Type.String({
      minLength: 2,
      maxLength: 1_048_576,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
    protectedArtifacts: Type.Array(protectedEvaluationArtifactSchema, {
      minItems: 4,
      maxItems: 4,
    }),
  },
  { additionalProperties: false },
);
export const evaluationManifestLockReceiptSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('Locked'), Type.Literal('AlreadyLocked')]),
    evaluationId: uuid,
    manifestSaid: said,
    ownerAid: said,
    policySaid: said,
    leaseId: uuid,
    lockedAtLeaseVersion: Type.Integer({ minimum: 1 }),
    lockedAtEvaluationVersion: Type.Integer({ minimum: 2 }),
    currentLeaseVersion: Type.Integer({ minimum: 1 }),
    currentEvaluationVersion: Type.Integer({ minimum: 2 }),
  },
  { additionalProperties: false },
);

/** One public payload per request keeps base64 and event bytes inside the current artifact body cap. */
export const publicEvaluationArtifactEnvelopeSchema = Type.Object(
  {
    artifact: evidenceArtifactSchema,
    bytesBase64Url: Type.String({
      minLength: 0,
      maxLength: (384 * 1024 * 4) / 3,
      pattern: '^[A-Za-z0-9_-]*$',
    }),
  },
  { additionalProperties: false },
);

export function decodePublicEvaluationArtifact(
  input: unknown,
): { readonly kind: 'Accepted'; readonly bytes: Uint8Array } | { readonly kind: 'Rejected' } {
  if (!Value.Check(publicEvaluationArtifactEnvelopeSchema, input)) return { kind: 'Rejected' };
  const bytes = Buffer.from(input.bytesBase64Url, 'base64url');
  if (
    bytes.byteLength > 384 * 1024 ||
    bytes.toString('base64url') !== input.bytesBase64Url ||
    decodeEvidenceArtifact(input.artifact, bytes).kind !== 'Accepted'
  )
    return { kind: 'Rejected' };
  return { kind: 'Accepted', bytes };
}

export const evaluationEvidenceUploadSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    batch: evaluationEvidenceBatchSchema,
    events: Type.Array(evaluationEvidenceEventSchema, { minItems: 1, maxItems: 32 }),
    publicArtifacts: Type.Array(publicEvaluationArtifactEnvelopeSchema, { maxItems: 1 }),
    protectedArtifacts: Type.Array(protectedEvaluationArtifactSchema, { maxItems: 32 }),
  },
  { additionalProperties: false },
);
export const evaluationEvidenceAcknowledgementSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Union([Type.Literal('Accepted'), Type.Literal('AlreadyAccepted')]),
    evaluationId: uuid,
    streamId: uuid,
    batchSaid: said,
    acceptedThroughSequence: Type.Integer({ minimum: 0 }),
    chainHeadSaid: said,
  },
  { additionalProperties: false },
);

/** A bounded, owner-authorized view of an immutable accepted Evaluation prefix. */
export const evaluationAcceptedEvidencePageSchema = Type.Object(
  {
    version: Type.Literal(1),
    evaluationId: uuid,
    streamId: uuid,
    afterSequence: Type.Integer({ minimum: -1, maximum: 9_999 }),
    throughSequence: Type.Integer({ minimum: 0, maximum: 9_999 }),
    throughHeadSaid: said,
    events: Type.Array(evaluationEvidenceEventSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);

/** Owner-scoped current admission and stream cursor, read before exact prefix replay. */
export const evaluationPositionSchema = Type.Object(
  {
    version: Type.Literal(1),
    evaluationId: uuid,
    ownerAid: said,
    commandId: uuid,
    originRunId: uuid,
    streamId: uuid,
    reservationSaid: said,
    lease: evaluationLeaseSchema,
    acceptedThroughSequence: Type.Integer({ minimum: -1, maximum: 9_999 }),
    chainHeadSaid: Type.Union([said, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Raw bytes are available only for Public custody; protected ciphertext has no read DTO. */
export const evaluationPublicArtifactReadSchema = Type.Object(
  {
    version: Type.Literal(1),
    evaluationId: uuid,
    ...publicEvaluationArtifactEnvelopeSchema.properties,
  },
  { additionalProperties: false },
);

export const evaluationClosureCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    expectedEvaluationVersion: Type.Integer({ minimum: 1 }),
    closure: evaluationClosureSchema,
    evidenceIndex: Type.Object(
      {
        artifact: evidenceArtifactSchema,
        bytesBase64Url: Type.String({
          minLength: 1,
          maxLength: Math.ceil((128 * 1_024 * 4) / 3),
          pattern: '^[A-Za-z0-9_-]*$',
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const experienceQuerySchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: uuid,
    sourceInventorySaid: said,
    corpusSaid: said,
    failureQuery: Type.String({ minLength: 1, maxLength: 1024 }),
    maximumResults: Type.Literal(3),
  },
  { additionalProperties: false },
);
export const experienceQueryReceiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('Retrieved'),
    sources: Type.Array(
      Type.Object(
        { episodeSaid: said, rawEvidenceSaid: said, score: Type.Number({ minimum: 0 }) },
        { additionalProperties: false },
      ),
      { maxItems: 3 },
    ),
    queryReceiptSaid: said,
    chargedMicroUsd: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const exactEvidenceReadingSchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: uuid,
    sourceInventorySaid: said,
    evidenceSaid: said,
    offset: Type.Integer({ minimum: 0, maximum: 64 * 1024 * 1024 }),
    maximumBytes: Type.Integer({ minimum: 1, maximum: 32 * 1024 }),
  },
  { additionalProperties: false },
);
