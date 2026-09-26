import Type from 'typebox';
import Value from 'typebox/value';

import {
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '../work-access.js';
import { rfc8785Sha256 } from '../rfc-8785.js';
import {
  evidenceArtifactSchema,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from './evidence-artifact.js';
import { decodeEvidenceBatch, evidenceBatchSchema } from './evidence-batch.js';
import { evidenceEventSchema } from './evidence-event.js';
import {
  decodeVerifiedCheckpoint,
  publicVerifierReceiptSchema,
  verifiedCheckpointSchema,
} from './verified-checkpoint.js';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const evidenceArtifactParametersSchema = Type.Object(
  { runId: uuidV4Schema, artifactSaid: saidSchema },
  { additionalProperties: false },
);

export type EvidenceArtifactParameters = Type.Static<typeof evidenceArtifactParametersSchema>;

export const verifierReceiptParametersSchema = Type.Object(
  { runId: uuidV4Schema, receiptSaid: saidSchema },
  { additionalProperties: false },
);

export const verifierReceiptReadingSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    checkpointSaid: saidSchema,
    receipt: publicVerifierReceiptSchema,
  },
  { additionalProperties: false },
);

export const evidenceArtifactMetadataHeadersSchema = Type.Object(
  {
    'content-type': evidenceArtifactSchema.properties.mediaType,
  },
  { additionalProperties: true },
);

export type EvidenceArtifactMetadataHeaders = Type.Static<
  typeof evidenceArtifactMetadataHeadersSchema
>;

export const evidenceArtifactRawBodySchema = Type.Unknown({
  contentMediaType: 'application/octet-stream',
  description: 'Raw immutable artifact bytes',
});

export const evidenceArtifactBodyByteLimit = 512 * 1_024;

/** A ranged raw read is deliberately smaller than the immutable upload ceiling. */
export const evidenceArtifactReadMaximumRangeBytes = 64 * 1_024;

export const evidenceArtifactReadRangeHeadersSchema = Type.Object(
  { range: Type.Optional(Type.String({ maxLength: 128 })) },
  { additionalProperties: true },
);

export type EvidenceArtifactReadRange =
  | { readonly kind: 'Full' }
  | { readonly kind: 'Range'; readonly start: number; readonly end: number }
  | { readonly kind: 'Unsatisfiable' };

export function decodeEvidenceArtifactReadRange(
  header: unknown,
  totalBytes: number,
): EvidenceArtifactReadRange {
  if (header === undefined) return { kind: 'Full' };
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || typeof header !== 'string')
    return { kind: 'Unsatisfiable' };
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(header);
  if (match === null) return { kind: 'Unsatisfiable' };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end >= totalBytes ||
    end - start + 1 > evidenceArtifactReadMaximumRangeBytes
  )
    return { kind: 'Unsatisfiable' };
  return { kind: 'Range', start, end };
}

export const evidenceArtifactReadResponseSchema = Type.Unsafe<Uint8Array>({
  type: 'string',
  format: 'binary',
  contentMediaType: 'application/octet-stream',
  description: 'Exact immutable Run artifact bytes',
});

export const evidenceArtifactRangeUnsatisfiableProblemSchema = Type.Object(
  {
    type: Type.Literal('https://devrandom.example/problems/evidence-artifact-range-unsatisfiable'),
    title: Type.Literal('Evidence artifact range is unsatisfiable'),
    status: Type.Literal(416),
    code: Type.Literal('EvidenceArtifactRangeUnsatisfiable'),
    correlationId: uuidV4Schema,
  },
  { additionalProperties: false },
);

export type EvidenceArtifactUploadDecoding =
  | {
      readonly kind: 'Accepted';
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'ArtifactRequestInvalid'
        | 'ArtifactBodyInvalid'
        | 'ArtifactBodyTooLarge'
        | 'ArtifactSaidMismatch';
    };

export function decodeEvidenceArtifactUpload(
  parameters: unknown,
  headers: unknown,
  body: unknown,
): EvidenceArtifactUploadDecoding {
  if (
    !Value.Check(evidenceArtifactParametersSchema, parameters) ||
    !Value.Check(evidenceArtifactMetadataHeadersSchema, headers)
  ) {
    return { kind: 'Rejected', reason: 'ArtifactRequestInvalid' };
  }
  if (!(body instanceof Uint8Array)) {
    return { kind: 'Rejected', reason: 'ArtifactBodyInvalid' };
  }
  if (body.byteLength > evidenceArtifactBodyByteLimit) {
    return { kind: 'Rejected', reason: 'ArtifactBodyTooLarge' };
  }
  const bytes = new Uint8Array(body);
  const prepared = prepareEvidenceArtifact(bytes, headers['content-type']);
  if (prepared.kind === 'Rejected') {
    return { kind: 'Rejected', reason: 'ArtifactRequestInvalid' };
  }
  if (prepared.artifact.d !== parameters.artifactSaid) {
    return { kind: 'Rejected', reason: 'ArtifactSaidMismatch' };
  }
  return { kind: 'Accepted', artifact: prepared.artifact, bytes };
}

export const evidenceArtifactAcknowledgementSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Union([Type.Literal('Stored'), Type.Literal('AlreadyStored')]),
    runId: uuidV4Schema,
    artifact: evidenceArtifactSchema,
    receivedAt: timestampSchema,
  },
  { additionalProperties: false },
);

export type EvidenceArtifactAcknowledgement = Type.Static<
  typeof evidenceArtifactAcknowledgementSchema
>;

export const evidenceBatchParametersSchema = Type.Object(
  { runId: uuidV4Schema, batchSaid: saidSchema },
  { additionalProperties: false },
);

export type EvidenceBatchParameters = Type.Static<typeof evidenceBatchParametersSchema>;

export const appendEvidenceBatchBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    batch: evidenceBatchSchema,
    events: Type.Array(evidenceEventSchema, { minItems: 1, maxItems: 32 }),
    checkpoint: Type.Optional(verifiedCheckpointSchema),
  },
  { additionalProperties: false },
);

export type AppendEvidenceBatchBody = Type.Static<typeof appendEvidenceBatchBodySchema>;

export function evidenceBatchCommandFingerprint(body: AppendEvidenceBatchBody): string {
  if (!Value.Check(appendEvidenceBatchBodySchema, body)) {
    throw new TypeError('Evidence batch fingerprint requires a valid transport body');
  }
  return rfc8785Sha256(body);
}

export type EvidenceBatchTransportRejectionReason =
  | 'SchemaInvalid'
  | 'BatchInvalid'
  | 'CheckpointInvalid'
  | 'CheckpointRunMismatch'
  | 'CheckpointEvidenceMismatch';

export type AppendEvidenceBatchBodyDecoding =
  | { readonly kind: 'Accepted'; readonly body: AppendEvidenceBatchBody }
  | {
      readonly kind: 'Rejected';
      readonly reason: EvidenceBatchTransportRejectionReason;
    };

function checkpointHeadMatchesBatch(body: AppendEvidenceBatchBody): boolean {
  const checkpoint = body.checkpoint;
  if (checkpoint === undefined) {
    return true;
  }
  if (
    checkpoint.evidence.finalSequence < body.batch.startingSequence ||
    checkpoint.evidence.finalSequence > body.batch.endingSequence
  ) {
    return checkpoint.evidence.finalSequence < body.batch.startingSequence;
  }
  const batchIndex = checkpoint.evidence.finalSequence - body.batch.startingSequence;
  return body.events[batchIndex]?.d === checkpoint.evidence.chainHeadSaid;
}

export function decodeAppendEvidenceBatchBody(
  input: unknown,
  completionConditionIds: readonly string[],
): AppendEvidenceBatchBodyDecoding {
  if (!Value.Check(appendEvidenceBatchBodySchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (decodeEvidenceBatch(input.batch, input.events).kind !== 'Accepted') {
    return { kind: 'Rejected', reason: 'BatchInvalid' };
  }
  if (input.checkpoint === undefined) {
    return { kind: 'Accepted', body: input };
  }
  if (decodeVerifiedCheckpoint(input.checkpoint, completionConditionIds).kind !== 'Accepted') {
    return { kind: 'Rejected', reason: 'CheckpointInvalid' };
  }
  if (input.checkpoint.runId !== input.batch.runId) {
    return { kind: 'Rejected', reason: 'CheckpointRunMismatch' };
  }
  if (!checkpointHeadMatchesBatch(input)) {
    return { kind: 'Rejected', reason: 'CheckpointEvidenceMismatch' };
  }
  return { kind: 'Accepted', body: input };
}

export type AppendEvidenceBatchCommandDecoding =
  | {
      readonly kind: 'Accepted';
      readonly command: {
        readonly parameters: EvidenceBatchParameters;
        readonly body: AppendEvidenceBatchBody;
      };
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        EvidenceBatchTransportRejectionReason | 'BatchPathMismatch' | 'BatchRunMismatch';
    };

export function decodeAppendEvidenceBatchCommand(
  parameters: unknown,
  body: unknown,
  completionConditionIds: readonly string[],
): AppendEvidenceBatchCommandDecoding {
  if (!Value.Check(evidenceBatchParametersSchema, parameters)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const decoded = decodeAppendEvidenceBatchBody(body, completionConditionIds);
  if (decoded.kind === 'Rejected') {
    return decoded;
  }
  if (parameters.batchSaid !== decoded.body.batch.d) {
    return { kind: 'Rejected', reason: 'BatchPathMismatch' };
  }
  if (parameters.runId !== decoded.body.batch.runId) {
    return { kind: 'Rejected', reason: 'BatchRunMismatch' };
  }
  return { kind: 'Accepted', command: { parameters, body: decoded.body } };
}

export const evidenceSealReconciliationBodySchema = Type.Object(
  { version: Type.Literal(1), sealExchangeSaid: saidSchema },
  { additionalProperties: false },
);

export type EvidenceSealReconciliationBody = Type.Static<
  typeof evidenceSealReconciliationBodySchema
>;

export const acceptedEvidenceEventProjectionSchema = Type.Object(
  { version: Type.Literal(1), event: evidenceEventSchema, receivedAt: timestampSchema },
  { additionalProperties: false },
);

export type AcceptedEvidenceEventProjection = Type.Static<
  typeof acceptedEvidenceEventProjectionSchema
>;

export const evidenceTimelineQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export type EvidenceTimelineQuery = Type.Static<typeof evidenceTimelineQuerySchema>;

const evidenceCursorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Empty') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Accepted'),
      eventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      acceptedThroughSequence: safeIntegerSchema,
      chainHeadSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
]);

const evidenceCheckpointProjectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Absent') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('Accepted'), checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
]);

const evidenceSealProjectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Unsealed') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('SealExchangePending'), sealExchangeSaid: saidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Sealed'),
      sealExchangeSaid: saidSchema,
      eventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      finalSequence: safeIntegerSchema,
      chainHeadSaid: saidSchema,
      sealedAt: timestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const evidenceStreamProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: uuidV4Schema,
    evidenceStreamId: uuidV4Schema,
    cursor: evidenceCursorSchema,
    checkpoint: evidenceCheckpointProjectionSchema,
    seal: evidenceSealProjectionSchema,
  },
  { additionalProperties: false },
);

export type EvidenceStreamProjection = Type.Static<typeof evidenceStreamProjectionSchema>;

export const evidenceTimelinePageSchema = Type.Object(
  {
    version: Type.Literal(1),
    stream: evidenceStreamProjectionSchema,
    events: Type.Array(acceptedEvidenceEventProjectionSchema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export type EvidenceTimelinePage = Type.Static<typeof evidenceTimelinePageSchema>;

export type EvidenceTimelinePageDecoding =
  | { readonly kind: 'Accepted'; readonly page: EvidenceTimelinePage }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'SchemaInvalid'
        | 'StreamInvalid'
        | 'RunMismatch'
        | 'EventRunMismatch'
        | 'EventOrderInvalid'
        | 'PageTooLarge';
    };

export type EvidenceStreamProjectionDecoding =
  | { readonly kind: 'Accepted'; readonly projection: EvidenceStreamProjection }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'CursorInvalid' | 'SealCursorMismatch';
    };

export function decodeEvidenceStreamProjection(input: unknown): EvidenceStreamProjectionDecoding {
  if (!Value.Check(evidenceStreamProjectionSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (
    input.cursor.kind === 'Accepted' &&
    input.cursor.acceptedThroughSequence + 1 !== input.cursor.eventCount
  ) {
    return { kind: 'Rejected', reason: 'CursorInvalid' };
  }
  if (input.seal.kind === 'Sealed') {
    if (
      input.cursor.kind !== 'Accepted' ||
      input.checkpoint.kind !== 'Accepted' ||
      input.cursor.eventCount !== input.seal.eventCount ||
      input.cursor.acceptedThroughSequence !== input.seal.finalSequence ||
      input.cursor.chainHeadSaid !== input.seal.chainHeadSaid
    ) {
      return { kind: 'Rejected', reason: 'SealCursorMismatch' };
    }
  }
  if (
    input.seal.kind === 'SealExchangePending' &&
    (input.cursor.kind !== 'Accepted' || input.checkpoint.kind !== 'Accepted')
  ) {
    return { kind: 'Rejected', reason: 'SealCursorMismatch' };
  }
  if (
    input.cursor.kind === 'Empty' &&
    (input.checkpoint.kind !== 'Absent' || input.seal.kind !== 'Unsealed')
  ) {
    return { kind: 'Rejected', reason: 'CursorInvalid' };
  }
  return { kind: 'Accepted', projection: input };
}

export function decodeEvidenceTimelinePage(
  input: unknown,
  expectedRunId: string,
): EvidenceTimelinePageDecoding {
  if (!Value.Check(evidenceTimelinePageSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (decodeEvidenceStreamProjection(input.stream).kind !== 'Accepted') {
    return { kind: 'Rejected', reason: 'StreamInvalid' };
  }
  if (input.stream.runId !== expectedRunId) {
    return { kind: 'Rejected', reason: 'RunMismatch' };
  }
  let previousSequence: number | undefined;
  for (const accepted of input.events) {
    if (accepted.event.runId !== expectedRunId) {
      return { kind: 'Rejected', reason: 'EventRunMismatch' };
    }
    if (previousSequence !== undefined && accepted.event.sequence !== previousSequence + 1) {
      return { kind: 'Rejected', reason: 'EventOrderInvalid' };
    }
    previousSequence = accepted.event.sequence;
  }
  if (
    previousSequence !== undefined &&
    (input.stream.cursor.kind !== 'Accepted' ||
      previousSequence > input.stream.cursor.acceptedThroughSequence)
  ) {
    return { kind: 'Rejected', reason: 'EventOrderInvalid' };
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1_024 * 1_024) {
    return { kind: 'Rejected', reason: 'PageTooLarge' };
  }
  return { kind: 'Accepted', page: input };
}

const correlationIdSchema = uuidV4Schema;

function problem<
  Code extends string,
  Status extends number,
  Title extends string,
  Path extends string,
>(code: Code, status: Status, title: Title, path: Path) {
  return {
    type: Type.Literal(`https://devrandom.example/problems/${path}`),
    title: Type.Literal(title),
    status: Type.Literal(status),
    code: Type.Literal(code),
    correlationId: correlationIdSchema,
  };
}

export const evidenceRequestInvalidProblemSchema = Type.Object(
  problem('EvidenceRequestInvalid', 400, 'Evidence request is invalid', 'evidence-request-invalid'),
  { additionalProperties: false },
);

export const evidenceCapabilityInvalidProblemSchema = Type.Object(
  problem(
    'EvidenceCapabilityInvalid',
    401,
    'Work Access capability is invalid',
    'evidence-capability-invalid',
  ),
  { additionalProperties: false },
);

export const evidenceRunNotFoundProblemSchema = Type.Object(
  problem('EvidenceRunNotFound', 404, 'Evidence Run was not found', 'evidence-run-not-found'),
  { additionalProperties: false },
);

type EvidenceSimpleConflictReason =
  | 'ArtifactConflict'
  | 'BatchConflict'
  | 'CheckpointConflict'
  | 'SealConflict'
  | 'CursorConcurrentUpdate'
  | 'SequenceGap'
  | 'SealCursorIncomplete';

function evidenceConflict<Reason extends EvidenceSimpleConflictReason>(reason: Reason) {
  return {
    ...problem(
      'EvidenceConflict',
      409,
      'Evidence delivery conflicts with the accepted stream',
      'evidence-conflict',
    ),
    reason: Type.Literal(reason),
  };
}

export const evidenceConflictProblemSchema = Type.Union([
  Type.Object(evidenceConflict('ArtifactConflict'), { additionalProperties: false }),
  Type.Object(evidenceConflict('BatchConflict'), { additionalProperties: false }),
  Type.Object(evidenceConflict('CheckpointConflict'), { additionalProperties: false }),
  Type.Object(evidenceConflict('SealConflict'), { additionalProperties: false }),
  Type.Object(evidenceConflict('CursorConcurrentUpdate'), { additionalProperties: false }),
  Type.Object(
    {
      ...evidenceConflict('SequenceGap'),
      expectedStartingSequence: safeIntegerSchema,
      receivedStartingSequence: safeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...evidenceConflict('SealCursorIncomplete'),
      acceptedEventCount: safeIntegerSchema,
      claimedEventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);

export const evidenceQuotaExceededProblemSchema = Type.Object(
  {
    ...problem(
      'EvidenceQuotaExceeded',
      413,
      'Evidence size or storage quota was exceeded',
      'evidence-quota-exceeded',
    ),
    reason: Type.Union([
      Type.Literal('RequestBodyTooLarge'),
      Type.Literal('ArtifactTooLarge'),
      Type.Literal('EventTooLarge'),
      Type.Literal('BatchTooLarge'),
      Type.Literal('RunEvidenceQuotaExceeded'),
      Type.Literal('GlobalEvidenceQuotaExceeded'),
    ]),
  },
  { additionalProperties: false },
);

export const evidenceRejectedProblemSchema = Type.Object(
  {
    ...problem('EvidenceRejected', 422, 'Evidence content was rejected', 'evidence-rejected'),
    reason: Type.Union([
      Type.Literal('ArtifactSaidMismatch'),
      Type.Literal('ArtifactMetadataMismatch'),
      Type.Literal('SecretDetected'),
      Type.Literal('BatchSaidMismatch'),
      Type.Literal('EventSaidMismatch'),
      Type.Literal('RunBindingMismatch'),
      Type.Literal('EventBindingMismatch'),
      Type.Literal('PredecessorMismatch'),
      Type.Literal('CheckpointInvalid'),
      Type.Literal('CheckpointBindingMismatch'),
      Type.Literal('SealExchangeMalformed'),
      Type.Literal('SealExchangeSaidMismatch'),
      Type.Literal('SealRouteMismatch'),
      Type.Literal('SealRecipientMismatch'),
      Type.Literal('SealSignerMismatch'),
      Type.Literal('SealPayloadMismatch'),
    ]),
  },
  { additionalProperties: false },
);

export const evidenceUnavailableProblemSchema = Type.Object(
  {
    ...problem(
      'EvidenceUnavailable',
      503,
      'Evidence dependency is unavailable',
      'evidence-unavailable',
    ),
    dependency: Type.Union([
      Type.Literal('HostedMongoDB'),
      Type.Literal('Keria'),
      Type.Literal('Witness'),
    ]),
  },
  { additionalProperties: false },
);

export const evidenceProblemSchema = Type.Union([
  evidenceRequestInvalidProblemSchema,
  evidenceCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  evidenceRunNotFoundProblemSchema,
  evidenceConflictProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  evidenceQuotaExceededProblemSchema,
  evidenceRejectedProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  evidenceUnavailableProblemSchema,
]);

export type EvidenceProblem = Type.Static<typeof evidenceProblemSchema>;
