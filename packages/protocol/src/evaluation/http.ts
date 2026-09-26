import Type from 'typebox';

import { evaluationClosureSchema } from './closure.js';
import { evaluationEvidenceBatchSchema } from './evidence-batch.js';
import { evaluationEvidenceEventSchema } from './evidence-event.js';
import { evaluationExecutionProfileSchema } from './execution-profile.js';
import { evaluationManifestInputSchema } from './manifest.js';
import { protectedEvaluationArtifactSchema } from './protected-artifact.js';
import { evaluationSourceInventorySchema } from './source-inventory.js';

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

export const evaluationEvidenceUploadSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    batch: evaluationEvidenceBatchSchema,
    events: Type.Array(evaluationEvidenceEventSchema, { minItems: 1, maxItems: 32 }),
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

export const evaluationClosureCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    expectedEvaluationVersion: Type.Integer({ minimum: 1 }),
    closure: evaluationClosureSchema,
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
