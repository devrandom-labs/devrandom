import {
  createEvidenceStream,
  runStateIsCoherent,
  type EvidenceProvisionalOutcome,
  type EvidenceStream,
  type RunLifecycle,
  type SubmissionVerification,
} from '@devrandom/domain';
import { runLifecycleSchema, submissionVerificationSchema } from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

const evidenceStreamBindingSchema = Type.Object(
  {
    streamId: uuidV4Schema,
    runId: uuidV4Schema,
    ownerAid: saidSchema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    incarnationId: uuidV4Schema,
    harnessRevisionSaid: saidSchema,
    personalAgentAid: saidSchema,
    taskMandateSaid: saidSchema,
    combinedByteCeiling: safeIntegerSchema,
  },
  { additionalProperties: false },
);

const evidenceCursorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Genesis') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Continued'),
      acceptedThrough: safeIntegerSchema,
      chainHeadSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
]);

const evidenceProvisionalOutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('None') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Checkpointed'),
      checkpointSaid: saidSchema,
      lifecycle: runLifecycleSchema,
      submissionVerification: submissionVerificationSchema,
    },
    { additionalProperties: false },
  ),
]);

const evidenceSealSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Open') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Sealed'),
      exchangeSaid: saidSchema,
      sealedAt: timestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const evidenceStreamDocumentSchema = Type.Object(
  {
    _id: uuidV4Schema,
    version: safeIntegerSchema,
    binding: evidenceStreamBindingSchema,
    cursor: evidenceCursorSchema,
    acceptedEvidenceBytes: safeIntegerSchema,
    acceptedArtifactBytes: safeIntegerSchema,
    provisional: evidenceProvisionalOutcomeSchema,
    seal: evidenceSealSchema,
  },
  { additionalProperties: false },
);

export type EvidenceStreamDocument = Type.Static<typeof evidenceStreamDocumentSchema>;

export class EvidenceStreamDocumentInvalid extends Error {
  constructor() {
    super('EvidenceStreamDocumentInvalid');
    this.name = 'EvidenceStreamDocumentInvalid';
  }
}

function checkpointMatchesLifecycle(checkpointSaid: string, lifecycle: RunLifecycle): boolean {
  if (lifecycle.kind === 'Active') {
    return lifecycle.phase.kind === 'Blocked' && lifecycle.phase.checkpointSaid === checkpointSaid;
  }
  return (
    lifecycle.outcome.kind !== 'Cancelled' && lifecycle.outcome.checkpointSaid === checkpointSaid
  );
}

function provisionalIsValid(provisional: EvidenceProvisionalOutcome): boolean {
  return (
    provisional.kind === 'None' ||
    (runStateIsCoherent({
      lifecycle: provisional.lifecycle,
      submissionVerification: provisional.submissionVerification,
    }) &&
      checkpointMatchesLifecycle(provisional.checkpointSaid, provisional.lifecycle))
  );
}

function rebuildLifecycle(lifecycle: RunLifecycle): RunLifecycle {
  if (lifecycle.kind === 'Active') {
    return lifecycle.phase.kind === 'Blocked'
      ? {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: lifecycle.phase.reason,
            checkpointSaid: lifecycle.phase.checkpointSaid,
          },
        }
      : { kind: 'Active', phase: { kind: lifecycle.phase.kind } };
  }
  switch (lifecycle.outcome.kind) {
    case 'Submitted':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'Submitted',
          checkpointSaid: lifecycle.outcome.checkpointSaid,
        },
      };
    case 'Failed':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'Failed',
          failure: lifecycle.outcome.failure,
          checkpointSaid: lifecycle.outcome.checkpointSaid,
        },
      };
    case 'Cancelled':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'Cancelled',
          checkpointSaid: lifecycle.outcome.checkpointSaid,
        },
      };
    case 'AuthorityRevoked':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'AuthorityRevoked',
          mandateSaid: lifecycle.outcome.mandateSaid,
          checkpointSaid: lifecycle.outcome.checkpointSaid,
        },
      };
    case 'CalibrationConfirmed':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationConfirmed',
          checkpointSaid: lifecycle.outcome.checkpointSaid,
          category: { ...lifecycle.outcome.category },
        },
      };
    case 'CalibrationExcluded':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationExcluded',
          checkpointSaid: lifecycle.outcome.checkpointSaid,
          reason: lifecycle.outcome.reason,
        },
      };
    case 'CalibrationRejected':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationRejected',
          checkpointSaid: lifecycle.outcome.checkpointSaid,
          reason: lifecycle.outcome.reason,
        },
      };
  }
}

function rebuildVerification(verification: SubmissionVerification): SubmissionVerification {
  return { kind: verification.kind };
}

function rebuildProvisional(
  provisional: EvidenceStreamDocument['provisional'],
): EvidenceProvisionalOutcome {
  return provisional.kind === 'None'
    ? { kind: 'None' }
    : {
        kind: 'Checkpointed',
        checkpointSaid: provisional.checkpointSaid,
        lifecycle: rebuildLifecycle(provisional.lifecycle),
        submissionVerification: rebuildVerification(provisional.submissionVerification),
      };
}

export function decodeEvidenceStreamDocument(input: unknown): EvidenceStream {
  if (!Value.Check(evidenceStreamDocumentSchema, input) || input._id !== input.binding.streamId) {
    throw new EvidenceStreamDocumentInvalid();
  }
  const created = createEvidenceStream(input.binding);
  if (created.kind !== 'Created') {
    throw new EvidenceStreamDocumentInvalid();
  }
  const provisional = rebuildProvisional(input.provisional);
  const acceptedBytes = input.acceptedEvidenceBytes + input.acceptedArtifactBytes;
  if (
    !Number.isSafeInteger(acceptedBytes) ||
    acceptedBytes > input.binding.combinedByteCeiling ||
    (input.cursor.kind === 'Genesis' && input.acceptedEvidenceBytes !== 0) ||
    (input.cursor.kind === 'Continued' && input.acceptedEvidenceBytes === 0) ||
    !provisionalIsValid(provisional) ||
    (input.seal.kind === 'Sealed' &&
      (input.cursor.kind !== 'Continued' || provisional.kind !== 'Checkpointed')) ||
    (input.version === 0 &&
      (input.cursor.kind !== 'Genesis' ||
        acceptedBytes !== 0 ||
        provisional.kind !== 'None' ||
        input.seal.kind !== 'Open'))
  ) {
    throw new EvidenceStreamDocumentInvalid();
  }
  return {
    version: input.version,
    binding: { ...created.stream.binding },
    cursor:
      input.cursor.kind === 'Genesis'
        ? { kind: 'Genesis' }
        : {
            kind: 'Continued',
            acceptedThrough: input.cursor.acceptedThrough,
            chainHeadSaid: input.cursor.chainHeadSaid,
          },
    acceptedEvidenceBytes: input.acceptedEvidenceBytes,
    acceptedArtifactBytes: input.acceptedArtifactBytes,
    provisional,
    seal:
      input.seal.kind === 'Open'
        ? { kind: 'Open' }
        : {
            kind: 'Sealed',
            exchangeSaid: input.seal.exchangeSaid,
            sealedAt: input.seal.sealedAt,
          },
  };
}

export function encodeEvidenceStreamDocument(stream: EvidenceStream): EvidenceStreamDocument {
  const document: EvidenceStreamDocument = {
    _id: stream.binding.streamId,
    version: stream.version,
    binding: { ...stream.binding },
    cursor:
      stream.cursor.kind === 'Genesis'
        ? { kind: 'Genesis' }
        : {
            kind: 'Continued',
            acceptedThrough: stream.cursor.acceptedThrough,
            chainHeadSaid: stream.cursor.chainHeadSaid,
          },
    acceptedEvidenceBytes: stream.acceptedEvidenceBytes,
    acceptedArtifactBytes: stream.acceptedArtifactBytes,
    provisional:
      stream.provisional.kind === 'None'
        ? { kind: 'None' }
        : {
            kind: 'Checkpointed',
            checkpointSaid: stream.provisional.checkpointSaid,
            lifecycle: rebuildLifecycle(stream.provisional.lifecycle),
            submissionVerification: rebuildVerification(stream.provisional.submissionVerification),
          },
    seal:
      stream.seal.kind === 'Open'
        ? { kind: 'Open' }
        : {
            kind: 'Sealed',
            exchangeSaid: stream.seal.exchangeSaid,
            sealedAt: stream.seal.sealedAt,
          },
  };
  decodeEvidenceStreamDocument(document);
  return document;
}
