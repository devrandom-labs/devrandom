import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { toolCapabilitySchema } from '../task/task-command.js';
import { runCalibrationDispositionSchema } from '../run/run-purpose.js';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const boundedIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
});
const toolCallIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/|-]*$',
});
const resourceSchema = Type.String({ minLength: 1, maxLength: 1_024 });
const digestSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

export const evidenceToolNameSchema = Type.Union([
  Type.Literal('read_file'),
  Type.Literal('list_files'),
  Type.Literal('search_repository'),
  Type.Literal('write_file'),
  Type.Literal('replace_text'),
  Type.Literal('run_formatter'),
  Type.Literal('run_static_analysis'),
  Type.Literal('run_tests'),
  Type.Literal('submit_result'),
]);

const budgetNameSchema = Type.Union([
  Type.Literal('workAccessAttemptLifetimeSeconds'),
  Type.Literal('workAccessGrantLifetimeSeconds'),
  Type.Literal('nonterminalAttemptsPerUserClient'),
  Type.Literal('activeGrantsPerUserClient'),
  Type.Literal('publicAttemptCreationsPerMinutePerLoopbackSource'),
  Type.Literal('nonterminalAttemptsGlobally'),
  Type.Literal('requestsPerGrant'),
  Type.Literal('tasksPerAdmittedUser'),
  Type.Literal('runsPerAdmittedUser'),
  Type.Literal('activeRunsPerAdmittedUser'),
  Type.Literal('hostedWorkTasksGlobally'),
  Type.Literal('hostedWorkRunsGlobally'),
  Type.Literal('activeHostedWorkRunsGlobally'),
  Type.Literal('ordinaryJsonRequestBodyBytes'),
  Type.Literal('evidenceBatchBodyBytes'),
  Type.Literal('artifactRequestBodyBytes'),
  Type.Literal('evidencePlusArtifactsPerRunBytes'),
  Type.Literal('acceptedEvidencePlusArtifactsGloballyBytes'),
  Type.Literal('runWallTimeSeconds'),
  Type.Literal('providerRequests'),
  Type.Literal('providerInputTokens'),
  Type.Literal('providerOutputTokens'),
  Type.Literal('toolProposals'),
  Type.Literal('aggregateChildCommandTimeSeconds'),
  Type.Literal('oneChildCommandTimeSeconds'),
  Type.Literal('changedFiles'),
  Type.Literal('changedWorktreeBytes'),
  Type.Literal('providerSpendMicroUsd'),
]);

const runBlockedReasonSchema = Type.Union([
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
  Type.Literal('HarnessCompatibilityFailure'),
]);

const toolAttribution = {
  piSessionId: uuidV4Schema,
  modelTurnId: boundedIdentifierSchema,
  toolCallId: toolCallIdentifierSchema,
  proposalIndex: safeIntegerSchema,
  tool: evidenceToolNameSchema,
  requiredCapability: toolCapabilitySchema,
  resource: resourceSchema,
};

export const evidenceEventDetailSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('RunStarted'), fromRunVersion: safeIntegerSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('IncarnationStarted') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('MandateVerified'),
      mandateSaid: saidSchema,
      disposition: Type.Literal('Current'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ModelRequest'),
      piSessionId: uuidV4Schema,
      modelTurnId: boundedIdentifierSchema,
      provider: boundedIdentifierSchema,
      model: boundedIdentifierSchema,
      maximumOutputTokens: positiveIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ModelMessageCompleted'),
      piSessionId: uuidV4Schema,
      modelTurnId: boundedIdentifierSchema,
      messageArtifactSaid: saidSchema,
      disposition: Type.Union([
        Type.Literal('Completed'),
        Type.Literal('Aborted'),
        Type.Literal('ProviderFailure'),
      ]),
      usage: Type.Object(
        {
          inputTokens: safeIntegerSchema,
          outputTokens: safeIntegerSchema,
          cacheReadTokens: safeIntegerSchema,
          cacheWriteTokens: safeIntegerSchema,
          spendMicroUsd: safeIntegerSchema,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('ToolProposed'), ...toolAttribution },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ToolAuthorized'),
      ...toolAttribution,
      mandateSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ToolRejected'),
      ...toolAttribution,
      reason: Type.Union([
        Type.Literal('CapabilityNotGranted'),
        Type.Literal('ResourceDenied'),
        Type.Literal('BudgetExhausted'),
        Type.Literal('MandateExpired'),
        Type.Literal('MandateRevoked'),
        Type.Literal('LeaseLost'),
        Type.Literal('ArgumentsInvalid'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('ApprovalRequired'), ...toolAttribution },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('EffectCompleted'),
      ...toolAttribution,
      outputArtifactSaids: Type.Array(saidSchema, { maxItems: 16, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('EffectFailed'),
      ...toolAttribution,
      failure: Type.Union([
        Type.Literal('ExitCodeMismatch'),
        Type.Literal('TimedOut'),
        Type.Literal('OutputLimitExceeded'),
        Type.Literal('FilesystemRejected'),
        Type.Literal('ArtifactUnavailable'),
        Type.Literal('ExecutableUnavailable'),
        Type.Literal('EffectAborted'),
        Type.Literal('ProcessCleanupUnconfirmed'),
        Type.Literal('ProcessSurvivedTermination'),
        Type.Literal('BudgetExhausted'),
        Type.Literal('SecretDetected'),
        Type.Literal('OutboxBackpressure'),
        Type.Literal('DependencyUnavailable'),
        Type.Literal('EvidenceIntegrityFailure'),
      ]),
      outputArtifactSaids: Type.Array(saidSchema, { maxItems: 16, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Observation'),
      source: Type.Union([
        Type.Literal('Repository'),
        Type.Literal('ToolEffect'),
        Type.Literal('Provider'),
        Type.Literal('Verifier'),
      ]),
      artifactSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('BudgetDebited'),
      budget: budgetNameSchema,
      amount: safeIntegerSchema,
      consumed: safeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('FailureObserved'),
      failure: Type.Union([
        Type.Literal('HarnessCompatibilityFailure'),
        Type.Literal('ProviderFailure'),
        Type.Literal('InfrastructureFailure'),
        Type.Literal('SecurityFailure'),
      ]),
      receiptSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ContextSummary'),
      sourceEventSaids: Type.Array(saidSchema, { minItems: 1, maxItems: 128, uniqueItems: true }),
      summaryArtifactSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('CheckpointVerified'), checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('CheckpointAccepted'), checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('RunCalibrationRecorded'),
      checkpointSaid: saidSchema,
      disposition: runCalibrationDispositionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('RunBlocked'),
      reason: runBlockedReasonSchema,
      checkpointSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ResultSubmitted'),
      artifactSaids: Type.Array(saidSchema, { maxItems: 64, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('TaskVerificationAccepted'),
      completionConditionId: boundedIdentifierSchema,
      receiptSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('TaskVerificationRejected'),
      completionConditionId: boundedIdentifierSchema,
      receiptSaid: saidSchema,
      reason: Type.Union([
        Type.Literal('UnexpectedExitCode'),
        Type.Literal('TimedOut'),
        Type.Literal('ExecutableUnavailable'),
        Type.Literal('OutputLimitExceeded'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('DataWithheld'),
      disposition: Type.Union([
        Type.Object(
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
        Type.Object(
          {
            kind: Type.Literal('PolicyExcluded'),
            reason: Type.Literal('RepositoryPolicy'),
            byteLength: safeIntegerSchema,
            contentDigest: digestSchema,
          },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('SecurityViolation'),
      violation: Type.Union([
        Type.Literal('SecretDetected'),
        Type.Literal('PathEscape'),
        Type.Literal('ProcessSurvivedTermination'),
        Type.Literal('EvidenceTampering'),
        Type.Literal('ProcessCleanupUnconfirmed'),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const eventBody = {
  sequence: safeIntegerSchema,
  predecessor: Type.Union([
    Type.Object({ kind: Type.Literal('Genesis') }, { additionalProperties: false }),
    Type.Object(
      { kind: Type.Literal('Previous'), eventSaid: saidSchema },
      { additionalProperties: false },
    ),
  ]),
  taskId: uuidV4Schema,
  taskRevisionSaid: saidSchema,
  runId: uuidV4Schema,
  incarnationId: uuidV4Schema,
  harnessRevisionSaid: saidSchema,
  personalAgentAid: saidSchema,
  taskMandateSaid: saidSchema,
  occurredAt: timestampSchema,
  recordedAt: timestampSchema,
  producer: Type.Union([
    Type.Object({ kind: Type.Literal('RunSupervisor') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('PiExecutor') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('ToolGateway') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('PublicTaskVerifier') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('EvidenceRecorder') }, { additionalProperties: false }),
  ]),
  event: evidenceEventDetailSchema,
};

export const evidenceEventDraftSchema = Type.Object(
  { version: Type.Literal(1), ...eventBody },
  { additionalProperties: false },
);
export const evidenceEventSchema = Type.Object(
  { version: Type.Literal(1), d: saidSchema, ...eventBody },
  { additionalProperties: false },
);

export type EvidenceEventDraft = Type.Static<typeof evidenceEventDraftSchema>;
export type EvidenceEvent = Type.Static<typeof evidenceEventSchema>;
export type EvidenceEventDetail = Type.Static<typeof evidenceEventDetailSchema>;

export type EvidenceEventPreparation =
  | { readonly kind: 'Prepared'; readonly event: EvidenceEvent }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        'SchemaInvalid' | 'CausalPositionInvalid' | 'EventTooLarge' | 'SaidConstructionFailed';
    };

export type EvidenceEventDecoding =
  | { readonly kind: 'Accepted'; readonly event: EvidenceEvent }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'CausalPositionInvalid' | 'EventTooLarge' | 'SaidMismatch';
    };

const utf8 = new TextEncoder();

function exactEventInstant(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function eventTimesAreExact(event: EvidenceEventDraft | EvidenceEvent): boolean {
  return exactEventInstant(event.occurredAt) && exactEventInstant(event.recordedAt);
}

function causalPositionIsValid(event: EvidenceEventDraft | EvidenceEvent): boolean {
  return event.sequence === 0
    ? event.predecessor.kind === 'Genesis'
    : event.predecessor.kind === 'Previous';
}

function withinEventLimit(event: EvidenceEvent): boolean {
  return utf8.encode(JSON.stringify(event)).byteLength <= 64 * 1_024;
}

export function prepareEvidenceEvent(draft: EvidenceEventDraft): EvidenceEventPreparation {
  if (!Value.Check(evidenceEventDraftSchema, draft) || !eventTimesAreExact(draft)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!causalPositionIsValid(draft)) {
    return { kind: 'Rejected', reason: 'CausalPositionInvalid' };
  }
  try {
    const {
      sequence,
      predecessor,
      taskId,
      taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid,
      personalAgentAid,
      taskMandateSaid,
      occurredAt,
      recordedAt,
      producer,
      event,
    } = draft;
    const candidate = {
      version: 1 as const,
      d: '',
      sequence,
      predecessor,
      taskId,
      taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid,
      personalAgentAid,
      taskMandateSaid,
      occurredAt,
      recordedAt,
      producer,
      event,
    };
    const saidified: unknown = Saider.saidify(candidate)[1];
    if (!Value.Check(evidenceEventSchema, saidified)) {
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    }
    if (!withinEventLimit(saidified)) {
      return { kind: 'Rejected', reason: 'EventTooLarge' };
    }
    return { kind: 'Prepared', event: saidified };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvidenceEvent(input: unknown): EvidenceEventDecoding {
  if (!Value.Check(evidenceEventSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!eventTimesAreExact(input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!causalPositionIsValid(input)) {
    return { kind: 'Rejected', reason: 'CausalPositionInvalid' };
  }
  if (!withinEventLimit(input)) {
    return { kind: 'Rejected', reason: 'EventTooLarge' };
  }
  try {
    return new Saider({ qb64: input.d }).verify(input, true, false)
      ? { kind: 'Accepted', event: input }
      : { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
}

export function evidenceArtifactReferences(event: EvidenceEventDetail): readonly string[] {
  switch (event.kind) {
    case 'ModelMessageCompleted':
      return [event.messageArtifactSaid];
    case 'EffectCompleted':
    case 'EffectFailed':
      return [...event.outputArtifactSaids];
    case 'Observation':
      return [event.artifactSaid];
    case 'ContextSummary':
      return [event.summaryArtifactSaid];
    case 'ResultSubmitted':
      return [...event.artifactSaids];
    case 'RunStarted':
    case 'IncarnationStarted':
    case 'MandateVerified':
    case 'ModelRequest':
    case 'ToolProposed':
    case 'ToolAuthorized':
    case 'ToolRejected':
    case 'ApprovalRequired':
    case 'BudgetDebited':
    case 'FailureObserved':
    case 'CheckpointVerified':
    case 'CheckpointAccepted':
    case 'RunCalibrationRecorded':
    case 'RunBlocked':
    case 'TaskVerificationAccepted':
    case 'TaskVerificationRejected':
    case 'DataWithheld':
    case 'SecurityViolation':
      return [];
  }
}
