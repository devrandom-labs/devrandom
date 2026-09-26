import { createHash } from 'node:crypto';

import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { runBudgetCeilingSchema } from '../run/budget-ceiling.js';
import { runBudgetConsumptionSchema } from '../run/budget-consumption.js';
import {
  calibrationExclusionReasonSchema,
  calibrationRejectionReasonSchema,
  preparedCompatibilityFailureCategorySchema,
  runPurposeSchema,
} from '../run/run-purpose.js';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const conditionIdSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z][a-z0-9-]{0,62}$',
});
const relativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*[\\\\\\u0000-\\u001f\\u007f-\\u009f])[^/]+(?:/[^/]+)*$',
});
const gitSha1Schema = Type.String({ pattern: '^[a-f0-9]{40}$' });
const gitSha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const outputArtifactSaidsSchema = Type.Array(saidSchema, {
  maxItems: 64,
  uniqueItems: true,
});

const publicVerifierOutcomeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Accepted'),
      observedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
      elapsedMilliseconds: safeIntegerSchema,
      outputArtifactSaids: outputArtifactSaidsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Rejected'),
      reason: Type.Union([
        Type.Object(
          {
            kind: Type.Literal('UnexpectedExitCode'),
            expected: Type.Integer({ minimum: 0, maximum: 255 }),
            observed: Type.Integer({ minimum: 0, maximum: 255 }),
          },
          { additionalProperties: false },
        ),
        Type.Object({ kind: Type.Literal('TimedOut') }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal('ExecutableUnavailable') },
          { additionalProperties: false },
        ),
        Type.Object({ kind: Type.Literal('OutputLimitExceeded') }, { additionalProperties: false }),
      ]),
      elapsedMilliseconds: safeIntegerSchema,
      outputArtifactSaids: outputArtifactSaidsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Unresolved'),
      reason: Type.Union([
        Type.Literal('NotAttempted'),
        Type.Literal('RunBlocked'),
        Type.Literal('EarlierConditionRejected'),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const publicVerifierReceiptBody = {
  completionConditionId: conditionIdSchema,
  commandSaid: saidSchema,
  recordedAt: timestampSchema,
  outcome: publicVerifierOutcomeSchema,
};

export const publicVerifierReceiptDraftSchema = Type.Object(
  { version: Type.Literal(1), ...publicVerifierReceiptBody },
  { additionalProperties: false },
);

export const publicVerifierReceiptSchema = Type.Object(
  { version: Type.Literal(1), d: saidSchema, ...publicVerifierReceiptBody },
  { additionalProperties: false },
);

export type PublicVerifierReceiptDraft = Type.Static<typeof publicVerifierReceiptDraftSchema>;
export type PublicVerifierReceipt = Type.Static<typeof publicVerifierReceiptSchema>;

export type PublicVerifierReceiptPreparation =
  | { readonly kind: 'Prepared'; readonly receipt: PublicVerifierReceipt }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'SaidConstructionFailed' };

export type PublicVerifierReceiptDecoding =
  | { readonly kind: 'Accepted'; readonly receipt: PublicVerifierReceipt }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'SaidMismatch' };

export type CheckpointFileContentIdentification =
  | { readonly kind: 'Identified'; readonly contentSaid: string; readonly byteLength: number }
  | { readonly kind: 'SaidConstructionFailed' };

export function identifyCheckpointFileContent(
  bytes: Uint8Array,
): CheckpointFileContentIdentification {
  try {
    const [identifier] = Saider.saidify({
      version: 1,
      d: '',
      kind: 'CheckpointFileContent',
      byteLength: bytes.byteLength,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    return { kind: 'Identified', contentSaid: identifier.qb64, byteLength: bytes.byteLength };
  } catch {
    return { kind: 'SaidConstructionFailed' };
  }
}

const blockedReasonSchema = Type.Union([
  Type.Literal('ApprovalRequired'),
  Type.Literal('UserInterrupted'),
  Type.Literal('DependencyUnavailable'),
  Type.Literal('ContextLimitReached'),
  Type.Literal('BudgetExhausted'),
  Type.Literal('TaskMandateExpired'),
  Type.Literal('OutboxBackpressure'),
  Type.Literal('SecretDetected'),
  Type.Literal('LeaseLost'),
  Type.Literal('ProcessLost'),
  Type.Literal('CheckpointPause'),
  Type.Literal('HarnessCompatibilityFailure'),
]);

const submissionVerificationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('NotSubmitted') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Pending') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Accepted') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Rejected') }, { additionalProperties: false }),
]);

const checkpointRunStateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Active'),
      phase: Type.Union([
        Type.Object({ kind: Type.Literal('Preparing') }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal('Running') }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal('Blocked'), reason: blockedReasonSchema },
          { additionalProperties: false },
        ),
      ]),
      verification: submissionVerificationSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Ended'),
      outcome: Type.Union([
        Type.Object({ kind: Type.Literal('Submitted') }, { additionalProperties: false }),
        Type.Object(
          {
            kind: Type.Literal('Failed'),
            failure: Type.Union([
              Type.Literal('EvidenceIntegrityFailure'),
              Type.Literal('LocalStateCorruption'),
              Type.Literal('ProviderUnrecoverableFailure'),
            ]),
          },
          { additionalProperties: false },
        ),
        Type.Object({ kind: Type.Literal('Cancelled') }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal('AuthorityRevoked'), mandateSaid: saidSchema },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('CalibrationConfirmed'),
            category: preparedCompatibilityFailureCategorySchema,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('CalibrationExcluded'),
            reason: calibrationExclusionReasonSchema,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('CalibrationRejected'),
            reason: calibrationRejectionReasonSchema,
          },
          { additionalProperties: false },
        ),
      ]),
      verification: submissionVerificationSchema,
    },
    { additionalProperties: false },
  ),
]);

const checkpointContinuationSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('CurrentIncarnationMayContinue') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ExternalResolutionRequired'),
      reason: Type.Union([
        Type.Literal('ApprovalRequired'),
        Type.Literal('DependencyUnavailable'),
        Type.Literal('ContextLimitReached'),
        Type.Literal('BudgetExhausted'),
        Type.Literal('TaskMandateExpired'),
        Type.Literal('OutboxBackpressure'),
        Type.Literal('SecretDetected'),
        Type.Literal('LeaseLost'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('LaterRuntimeRecoveryRequired') },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('LaterHarnessCompatibilityResolutionRequired') },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('NoContinuation') }, { additionalProperties: false }),
]);

const changedFileSchema = Type.Object(
  {
    path: relativePathSchema,
    disposition: Type.Union([
      Type.Literal('Added'),
      Type.Literal('Modified'),
      Type.Literal('Deleted'),
      Type.Literal('Renamed'),
      Type.Literal('TypeChanged'),
      Type.Literal('Unmerged'),
    ]),
    mode: Type.String({ pattern: '^[0-7]{6}$' }),
    contentSaid: saidSchema,
  },
  { additionalProperties: false },
);

const checkpointRepositorySchema = Type.Union([
  Type.Object(
    {
      objectFormat: Type.Literal('sha1'),
      baseCommit: gitSha1Schema,
      baseTree: gitSha1Schema,
      changedFiles: Type.Array(changedFileSchema, { maxItems: 256 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      objectFormat: Type.Literal('sha256'),
      baseCommit: gitSha256Schema,
      baseTree: gitSha256Schema,
      changedFiles: Type.Array(changedFileSchema, { maxItems: 256 }),
    },
    { additionalProperties: false },
  ),
]);

const privacyRepositoryMeasurementSchema = Type.Object(
  {
    kind: Type.Literal('UnavailableBecauseSecret'),
    disclosure: Type.Object(
      {
        kind: Type.Literal('WithheldSecret'),
        reason: Type.Union([
          Type.Literal('Credential'),
          Type.Literal('AuthorizationHeader'),
          Type.Literal('PrivateKey'),
          Type.Literal('EnvironmentSecret'),
        ]),
        byteLength: safeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    dataWithheldEventSaid: saidSchema,
    securityViolationEventSaid: saidSchema,
  },
  { additionalProperties: false },
);

const privacyRepositorySchema = Type.Union([
  Type.Object(
    {
      objectFormat: Type.Literal('sha1'),
      baseCommit: gitSha1Schema,
      baseTree: gitSha1Schema,
      repositoryMeasurement: privacyRepositoryMeasurementSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      objectFormat: Type.Literal('sha256'),
      baseCommit: gitSha256Schema,
      baseTree: gitSha256Schema,
      repositoryMeasurement: privacyRepositoryMeasurementSchema,
    },
    { additionalProperties: false },
  ),
]);

const privacyRunStateSchema = Type.Object(
  {
    kind: Type.Literal('Active'),
    phase: Type.Object(
      { kind: Type.Literal('Blocked'), reason: Type.Literal('SecretDetected') },
      { additionalProperties: false },
    ),
    verification: submissionVerificationSchema,
  },
  { additionalProperties: false },
);

const privacyContinuationSchema = Type.Object(
  { kind: Type.Literal('ExternalResolutionRequired'), reason: Type.Literal('SecretDetected') },
  { additionalProperties: false },
);

const verifiedCheckpointBody = {
  taskId: uuidV4Schema,
  taskRevisionSaid: saidSchema,
  runId: uuidV4Schema,
  incarnationId: uuidV4Schema,
  harnessRevisionSaid: saidSchema,
  harnessLineageId: uuidV4Schema,
  personalAgentAid: saidSchema,
  governorAid: saidSchema,
  taskMandateSaid: saidSchema,
  promotionMandateSaid: saidSchema,
  purpose: runPurposeSchema,
  repository: checkpointRepositorySchema,
  outputArtifactSaids: outputArtifactSaidsSchema,
  verifierReceipts: Type.Array(publicVerifierReceiptSchema, { maxItems: 32 }),
  evidence: Type.Object(
    {
      eventCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      finalSequence: safeIntegerSchema,
      chainHeadSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  budget: Type.Object(
    { consumed: runBudgetConsumptionSchema, remaining: runBudgetCeilingSchema },
    { additionalProperties: false },
  ),
  runState: checkpointRunStateSchema,
  continuation: checkpointContinuationSchema,
};

const privacyCheckpointBody = {
  ...verifiedCheckpointBody,
  repository: privacyRepositorySchema,
  runState: privacyRunStateSchema,
  continuation: privacyContinuationSchema,
};

export const verifiedCheckpointV1Schema = Type.Object(
  { version: Type.Literal(1), d: saidSchema, ...verifiedCheckpointBody },
  { additionalProperties: false },
);

export const verifiedCheckpointDraftSchema = Type.Union([
  Type.Object(
    { version: Type.Literal(1), ...verifiedCheckpointBody },
    { additionalProperties: false },
  ),
  Type.Object(
    { version: Type.Literal(2), ...privacyCheckpointBody },
    { additionalProperties: false },
  ),
]);

export const verifiedCheckpointSchema = Type.Union([
  verifiedCheckpointV1Schema,
  Type.Object(
    { version: Type.Literal(2), d: saidSchema, ...privacyCheckpointBody },
    { additionalProperties: false },
  ),
]);

export type VerifiedCheckpointDraft = Type.Static<typeof verifiedCheckpointDraftSchema>;
export type VerifiedCheckpoint = Type.Static<typeof verifiedCheckpointSchema>;

type VerifiedCheckpointInvalidity =
  | 'VerifierReceiptInvalid'
  | 'VerifierReceiptSetIncomplete'
  | 'ChangedFileManifestInvalid'
  | 'EvidenceCursorInvalid'
  | 'RunStateInvalid'
  | 'RunPurposeMismatch'
  | 'ContinuationMismatch';

export type VerifiedCheckpointPreparation =
  | { readonly kind: 'Prepared'; readonly checkpoint: VerifiedCheckpoint }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | VerifiedCheckpointInvalidity | 'SaidConstructionFailed';
    };

export type VerifiedCheckpointDecoding =
  | { readonly kind: 'Accepted'; readonly checkpoint: VerifiedCheckpoint }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | VerifiedCheckpointInvalidity | 'SaidMismatch';
    };

function receiptSaidMatches(receipt: PublicVerifierReceipt): boolean {
  try {
    return new Saider({ qb64: receipt.d }).verify(receipt, true, false);
  } catch {
    return false;
  }
}

export function preparePublicVerifierReceipt(
  draft: PublicVerifierReceiptDraft,
): PublicVerifierReceiptPreparation {
  if (!Value.Check(publicVerifierReceiptDraftSchema, draft)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  try {
    const candidate = {
      version: 1 as const,
      d: '',
      completionConditionId: draft.completionConditionId,
      commandSaid: draft.commandSaid,
      recordedAt: draft.recordedAt,
      outcome: draft.outcome,
    };
    const saidified: unknown = Saider.saidify(candidate)[1];
    return Value.Check(publicVerifierReceiptSchema, saidified)
      ? { kind: 'Prepared', receipt: saidified }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodePublicVerifierReceipt(input: unknown): PublicVerifierReceiptDecoding {
  if (!Value.Check(publicVerifierReceiptSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  return receiptSaidMatches(input)
    ? { kind: 'Accepted', receipt: input }
    : { kind: 'Rejected', reason: 'SaidMismatch' };
}

const utf8 = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte !== rightByte) {
      return (leftByte ?? 0) - (rightByte ?? 0);
    }
  }
  return leftBytes.length - rightBytes.length;
}

function changedFilesAreSorted(checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint): boolean {
  if (checkpoint.version === 2) return true;
  for (let index = 1; index < checkpoint.repository.changedFiles.length; index += 1) {
    const previous = checkpoint.repository.changedFiles[index - 1];
    const current = checkpoint.repository.changedFiles[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareUtf8(previous.path, current.path) >= 0
    ) {
      return false;
    }
  }
  return true;
}

function receiptsCoverConditions(
  checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint,
  completionConditionIds: readonly string[],
): boolean {
  if (
    checkpoint.verifierReceipts.length === 0 &&
    checkpoint.runState.kind === 'Ended' &&
    checkpoint.runState.outcome.kind === 'CalibrationExcluded' &&
    checkpoint.runState.verification.kind === 'NotSubmitted'
  ) {
    return true;
  }
  if (checkpoint.verifierReceipts.length !== completionConditionIds.length) {
    return false;
  }
  for (let index = 0; index < completionConditionIds.length; index += 1) {
    if (
      checkpoint.verifierReceipts[index]?.completionConditionId !== completionConditionIds[index]
    ) {
      return false;
    }
  }
  return true;
}

function runStateIsConsistent(checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint): boolean {
  if (checkpoint.runState.kind === 'Active') {
    return checkpoint.runState.verification.kind !== 'Accepted';
  }
  if (checkpoint.runState.outcome.kind === 'Submitted') {
    return checkpoint.runState.verification.kind === 'Accepted';
  }
  if (checkpoint.runState.outcome.kind === 'CalibrationConfirmed') {
    return checkpoint.runState.verification.kind === 'Rejected';
  }
  if (checkpoint.runState.outcome.kind === 'CalibrationExcluded') {
    return (
      checkpoint.runState.verification.kind === 'NotSubmitted' ||
      checkpoint.runState.verification.kind === 'Rejected'
    );
  }
  if (
    checkpoint.runState.outcome.kind === 'CalibrationRejected' &&
    checkpoint.runState.outcome.reason === 'H1Passed'
  ) {
    return checkpoint.runState.verification.kind === 'Accepted';
  }
  if (checkpoint.runState.outcome.kind === 'CalibrationRejected') {
    return checkpoint.runState.verification.kind === 'Rejected';
  }
  return checkpoint.runState.verification.kind !== 'Accepted';
}

function runPurposeMatches(checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint): boolean {
  if (checkpoint.runState.kind === 'Active') {
    return true;
  }
  switch (checkpoint.runState.outcome.kind) {
    case 'CalibrationConfirmed':
    case 'CalibrationExcluded':
    case 'CalibrationRejected':
      return checkpoint.purpose.kind === 'PreparedCompatibilityCalibration';
    case 'Submitted':
    case 'Failed':
    case 'Cancelled':
    case 'AuthorityRevoked':
      return true;
  }
}

function continuationMatches(checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint): boolean {
  const state = checkpoint.runState;
  const continuation = checkpoint.continuation;
  if (state.kind === 'Ended') {
    return continuation.kind === 'NoContinuation';
  }
  if (state.phase.kind !== 'Blocked') {
    return continuation.kind === 'CurrentIncarnationMayContinue';
  }
  if (state.phase.reason === 'HarnessCompatibilityFailure') {
    return continuation.kind === 'LaterHarnessCompatibilityResolutionRequired';
  }
  if (
    state.phase.reason === 'UserInterrupted' ||
    state.phase.reason === 'ProcessLost' ||
    state.phase.reason === 'CheckpointPause'
  ) {
    return continuation.kind === 'LaterRuntimeRecoveryRequired';
  }
  return (
    continuation.kind === 'ExternalResolutionRequired' && continuation.reason === state.phase.reason
  );
}

function checkpointInvalidity(
  checkpoint: VerifiedCheckpointDraft | VerifiedCheckpoint,
  completionConditionIds: readonly string[],
): VerifiedCheckpointInvalidity | undefined {
  for (const receipt of checkpoint.verifierReceipts) {
    if (decodePublicVerifierReceipt(receipt).kind !== 'Accepted') {
      return 'VerifierReceiptInvalid';
    }
  }
  if (!receiptsCoverConditions(checkpoint, completionConditionIds)) {
    return 'VerifierReceiptSetIncomplete';
  }
  if (!changedFilesAreSorted(checkpoint)) {
    return 'ChangedFileManifestInvalid';
  }
  if (
    checkpoint.version === 2 &&
    (checkpoint.evidence.eventCount < 2 ||
      checkpoint.evidence.chainHeadSaid !==
        checkpoint.repository.repositoryMeasurement.securityViolationEventSaid)
  ) {
    return 'EvidenceCursorInvalid';
  }
  if (checkpoint.evidence.finalSequence + 1 !== checkpoint.evidence.eventCount) {
    return 'EvidenceCursorInvalid';
  }
  if (!runStateIsConsistent(checkpoint)) {
    return 'RunStateInvalid';
  }
  if (!runPurposeMatches(checkpoint)) {
    return 'RunPurposeMismatch';
  }
  if (!continuationMatches(checkpoint)) {
    return 'ContinuationMismatch';
  }
  return undefined;
}

function checkpointSaidMatches(checkpoint: VerifiedCheckpoint): boolean {
  try {
    return new Saider({ qb64: checkpoint.d }).verify(checkpoint, true, false);
  } catch {
    return false;
  }
}

export function prepareVerifiedCheckpoint(
  draft: VerifiedCheckpointDraft,
  completionConditionIds: readonly string[],
): VerifiedCheckpointPreparation {
  if (!Value.Check(verifiedCheckpointDraftSchema, draft)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const invalidity = checkpointInvalidity(draft, completionConditionIds);
  if (invalidity !== undefined) {
    return { kind: 'Rejected', reason: invalidity };
  }
  try {
    const candidate = {
      version: draft.version,
      d: '',
      taskId: draft.taskId,
      taskRevisionSaid: draft.taskRevisionSaid,
      runId: draft.runId,
      incarnationId: draft.incarnationId,
      harnessRevisionSaid: draft.harnessRevisionSaid,
      harnessLineageId: draft.harnessLineageId,
      personalAgentAid: draft.personalAgentAid,
      governorAid: draft.governorAid,
      taskMandateSaid: draft.taskMandateSaid,
      promotionMandateSaid: draft.promotionMandateSaid,
      purpose: draft.purpose,
      repository: draft.repository,
      outputArtifactSaids: draft.outputArtifactSaids,
      verifierReceipts: draft.verifierReceipts,
      evidence: draft.evidence,
      budget: draft.budget,
      runState: draft.runState,
      continuation: draft.continuation,
    };
    const saidified: unknown = Saider.saidify(candidate)[1];
    return Value.Check(verifiedCheckpointSchema, saidified)
      ? { kind: 'Prepared', checkpoint: saidified }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeVerifiedCheckpoint(
  input: unknown,
  completionConditionIds: readonly string[],
): VerifiedCheckpointDecoding {
  if (!Value.Check(verifiedCheckpointSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!checkpointSaidMatches(input)) {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  const invalidity = checkpointInvalidity(input, completionConditionIds);
  return invalidity === undefined
    ? { kind: 'Accepted', checkpoint: input }
    : { kind: 'Rejected', reason: invalidity };
}
