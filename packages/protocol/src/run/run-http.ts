import Type from 'typebox';

import {
  createRun,
  runPurposeAllowsLifecycle,
  runLifecycleRetainsBudgetExcess,
  runStateIsCoherent,
  taskBudgetNames,
  type Run,
} from '@devrandom/domain';
import Value from 'typebox/value';

import {
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '../work-access.js';
import { preparedRepositorySchema } from '../task/task-command.js';
import { runBudgetCeilingSchema } from './budget-ceiling.js';
import { runBudgetConsumptionSchema } from './budget-consumption.js';
import {
  calibrationExclusionReasonSchema,
  calibrationRejectionReasonSchema,
  preparedCompatibilityFailureCategorySchema,
  runPurposeSchema,
} from './run-purpose.js';

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

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

const activePhaseSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Preparing') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Running') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('Blocked'), reason: blockedReasonSchema, checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
]);

const endedOutcomeSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('Submitted'), checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Failed'),
      failure: Type.Union([
        Type.Literal('EvidenceIntegrityFailure'),
        Type.Literal('LocalStateCorruption'),
        Type.Literal('ProviderUnrecoverableFailure'),
      ]),
      checkpointSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Cancelled'), checkpointSaid: saidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('AuthorityRevoked'),
      mandateSaid: saidSchema,
      checkpointSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('CalibrationConfirmed'),
      checkpointSaid: saidSchema,
      category: preparedCompatibilityFailureCategorySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('CalibrationExcluded'),
      checkpointSaid: saidSchema,
      reason: calibrationExclusionReasonSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('CalibrationRejected'),
      checkpointSaid: saidSchema,
      reason: calibrationRejectionReasonSchema,
    },
    { additionalProperties: false },
  ),
]);

export const runLifecycleSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('Active'), phase: activePhaseSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Ended'), outcome: endedOutcomeSchema },
    { additionalProperties: false },
  ),
]);

export const submissionVerificationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('NotSubmitted') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Pending') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Accepted') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Rejected') }, { additionalProperties: false }),
]);

export const runLeaseSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Unassigned') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Held'),
      incarnationId: uuidV4Schema,
      acquiredAt: timestampSchema,
      expiresAt: timestampSchema,
      segmentSaid: Type.Optional(saidSchema),
      lastChange: Type.Union([
        Type.Object(
          { kind: Type.Literal('Acquired'), fromRunVersion: safeIntegerSchema },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal('Renewed'), fromRunVersion: safeIntegerSchema },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal('Replaced'),
            fromRunVersion: safeIntegerSchema,
            segmentSaid: saidSchema,
          },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
]);

export const runProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: uuidV4Schema,
    runVersion: safeIntegerSchema,
    ownerAid: saidSchema,
    commandId: uuidV4Schema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessLineageId: uuidV4Schema,
    harnessRevisionSaid: saidSchema,
    personalAgentAid: saidSchema,
    taskMandateSaid: saidSchema,
    governorAid: saidSchema,
    promotionMandateSaid: saidSchema,
    purpose: runPurposeSchema,
    repository: preparedRepositorySchema,
    admissionExchangeSaid: saidSchema,
    evidenceStreamId: uuidV4Schema,
    budget: Type.Object(
      { ceiling: runBudgetCeilingSchema, consumed: runBudgetConsumptionSchema },
      { additionalProperties: false },
    ),
    lifecycle: runLifecycleSchema,
    submissionVerification: submissionVerificationSchema,
    lease: runLeaseSchema,
    currentExecution: Type.Optional(
      Type.Object(
        {
          segmentSaid: saidSchema,
          harnessRevisionSaid: saidSchema,
          evidenceStreamId: uuidV4Schema,
        },
        { additionalProperties: false },
      ),
    ),
    activation: Type.Object(
      {
        kind: Type.Literal('InitialSpecializationAccepted'),
        harnessLineageId: uuidV4Schema,
        harnessRevisionSaid: saidSchema,
        runId: uuidV4Schema,
        acceptedAt: timestampSchema,
      },
      { additionalProperties: false },
    ),
    acceptedAt: timestampSchema,
  },
  { additionalProperties: false },
);

export type RunProjection = Type.Static<typeof runProjectionSchema>;

export function projectRun(run: Run): RunProjection {
  const binding = run.binding;
  return {
    version: 1,
    runId: binding.runId,
    runVersion: run.version,
    ownerAid: binding.ownerAid,
    commandId: binding.commandId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    harnessLineageId: binding.harnessLineageId,
    harnessRevisionSaid: binding.initialHarnessRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    governorAid: binding.governorAid,
    promotionMandateSaid: binding.promotionMandateSaid,
    purpose: binding.purpose,
    repository: binding.repository,
    admissionExchangeSaid: binding.admissionExchangeSaid,
    evidenceStreamId: binding.evidenceStreamId,
    budget: { ceiling: binding.budget, consumed: run.consumedBudget },
    lifecycle: run.lifecycle,
    submissionVerification: run.submissionVerification,
    lease: run.lease,
    ...(run.currentExecution === undefined ? {} : { currentExecution: run.currentExecution }),
    activation: binding.initialSpecialization,
    acceptedAt: binding.acceptedAt,
  };
}

export type RunProjectionDecoding =
  { readonly kind: 'Accepted'; readonly run: Run } | { readonly kind: 'Rejected' };

function runInstantIsCanonical(value: string): boolean {
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

export function runLeaseTimesAreValid(serverTime: string, expiresAt: string): boolean {
  return (
    runInstantIsCanonical(serverTime) &&
    runInstantIsCanonical(expiresAt) &&
    Date.parse(expiresAt) > Date.parse(serverTime)
  );
}

export function decodeRunProjection(input: unknown): RunProjectionDecoding {
  if (!Value.Check(runProjectionSchema, input)) {
    return { kind: 'Rejected' };
  }
  if (
    !runInstantIsCanonical(input.acceptedAt) ||
    !runInstantIsCanonical(input.activation.acceptedAt) ||
    input.activation.harnessLineageId !== input.harnessLineageId ||
    input.activation.harnessRevisionSaid !== input.harnessRevisionSaid ||
    !runPurposeAllowsLifecycle(input.purpose, input.lifecycle) ||
    !runStateIsCoherent({
      lifecycle: input.lifecycle,
      submissionVerification: input.submissionVerification,
    }) ||
    (taskBudgetNames.some((name) => input.budget.consumed[name] > input.budget.ceiling[name]) &&
      !runLifecycleRetainsBudgetExcess(input.lifecycle)) ||
    (input.lease.kind === 'Held' &&
      (input.lease.lastChange.fromRunVersion >= input.runVersion ||
        !runLeaseTimesAreValid(input.lease.acquiredAt, input.lease.expiresAt))) ||
    (input.currentExecution !== undefined &&
      (input.lease.kind !== 'Held' ||
        input.lease.segmentSaid !== input.currentExecution.segmentSaid ||
        input.currentExecution.harnessRevisionSaid === input.harnessRevisionSaid ||
        input.currentExecution.evidenceStreamId === input.evidenceStreamId)) ||
    (input.lease.kind === 'Held' &&
      (input.currentExecution === undefined) !== (input.lease.segmentSaid === undefined)) ||
    (input.lease.kind === 'Held' &&
      input.lease.lastChange.kind === 'Replaced' &&
      input.lease.lastChange.segmentSaid !== input.lease.segmentSaid)
  ) {
    return { kind: 'Rejected' };
  }
  const created = createRun({
    runId: input.runId,
    ownerAid: input.ownerAid,
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    personalAgentAid: input.personalAgentAid,
    taskMandateSaid: input.taskMandateSaid,
    governorAid: input.governorAid,
    promotionMandateSaid: input.promotionMandateSaid,
    initialHarnessRevisionSaid: input.harnessRevisionSaid,
    purpose: input.purpose,
    initialSpecialization: input.activation,
    repository: input.repository,
    commandId: input.commandId,
    admissionExchangeSaid: input.admissionExchangeSaid,
    evidenceStreamId: input.evidenceStreamId,
    budget: input.budget.ceiling,
    acceptedAt: input.acceptedAt,
  });
  if (created.kind === 'Rejected') {
    return { kind: 'Rejected' };
  }
  return {
    kind: 'Accepted',
    run: {
      ...created.run,
      version: input.runVersion,
      lifecycle: input.lifecycle,
      submissionVerification: input.submissionVerification,
      lease: input.lease,
      consumedBudget: input.budget.consumed,
      ...(input.currentExecution === undefined ? {} : { currentExecution: input.currentExecution }),
    },
  };
}

export const runAdmissionPendingProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Literal('RunAdmissionExchangePending'),
    commandId: uuidV4Schema,
    admissionExchangeSaid: saidSchema,
  },
  { additionalProperties: false },
);

export type RunAdmissionPendingProjection = Type.Static<typeof runAdmissionPendingProjectionSchema>;

export const runParametersSchema = Type.Object(
  { runId: uuidV4Schema },
  { additionalProperties: false },
);

export const runIncarnationParametersSchema = Type.Object(
  { runId: uuidV4Schema, incarnationId: uuidV4Schema },
  { additionalProperties: false },
);

export const runLeaseAcquisitionBodySchema = Type.Object(
  { version: Type.Literal(1), expectedRunVersion: safeIntegerSchema },
  { additionalProperties: false },
);

export type RunLeaseAcquisitionBody = Type.Static<typeof runLeaseAcquisitionBodySchema>;

export const runLeaseProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: Type.Union([Type.Literal('Acquired'), Type.Literal('Reconciled')]),
    runId: uuidV4Schema,
    incarnationId: uuidV4Schema,
    runVersion: safeIntegerSchema,
    serverTime: timestampSchema,
    expiresAt: timestampSchema,
  },
  { additionalProperties: false },
);

export type RunLeaseProjection = Type.Static<typeof runLeaseProjectionSchema>;

export const runLeaseRenewalHeaderNames = Object.freeze({
  serverTime: 'x-devrandom-server-time',
  expiresAt: 'x-devrandom-lease-expires-at',
  runVersion: 'x-devrandom-run-version',
});

const runVersionHeaderSchema = Type.String({ pattern: '^(0|[1-9][0-9]{0,15})$' });

export const runLeaseRenewalHeadersSchema = Type.Object(
  {
    [runLeaseRenewalHeaderNames.serverTime]: timestampSchema,
    [runLeaseRenewalHeaderNames.expiresAt]: timestampSchema,
    [runLeaseRenewalHeaderNames.runVersion]: runVersionHeaderSchema,
  },
  { additionalProperties: false },
);

export interface RunLeaseRenewalReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly incarnationId: string;
  readonly runVersion: number;
  readonly serverTime: string;
  readonly expiresAt: string;
}

export type RunLeaseRenewalReceiptDecoding =
  | { readonly kind: 'Accepted'; readonly receipt: RunLeaseRenewalReceipt }
  | { readonly kind: 'Rejected' };

export function decodeRunLeaseRenewalReceipt(
  runId: string,
  incarnationId: string,
  headers: unknown,
): RunLeaseRenewalReceiptDecoding {
  if (
    !Value.Check(runIncarnationParametersSchema, { runId, incarnationId }) ||
    !Value.Check(runLeaseRenewalHeadersSchema, headers)
  ) {
    return { kind: 'Rejected' };
  }
  const runVersion = Number(headers[runLeaseRenewalHeaderNames.runVersion]);
  const serverTime = headers[runLeaseRenewalHeaderNames.serverTime];
  const expiresAt = headers[runLeaseRenewalHeaderNames.expiresAt];
  if (
    !Number.isSafeInteger(runVersion) ||
    runVersion < 0 ||
    !runLeaseTimesAreValid(serverTime, expiresAt)
  ) {
    return { kind: 'Rejected' };
  }
  return {
    kind: 'Accepted',
    receipt: { version: 1, runId, incarnationId, runVersion, serverTime, expiresAt },
  };
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

export const runRequestInvalidProblemSchema = Type.Object(
  problem('RunRequestInvalid', 400, 'Run request is invalid', 'run-request-invalid'),
  { additionalProperties: false },
);
export const runCapabilityInvalidProblemSchema = Type.Object(
  problem(
    'RunCapabilityInvalid',
    401,
    'Work Access capability is invalid',
    'run-capability-invalid',
  ),
  { additionalProperties: false },
);
export const runAdmissionForbiddenProblemSchema = Type.Object(
  {
    ...problem(
      'RunAdmissionForbidden',
      403,
      'Run admission is not permitted',
      'run-admission-forbidden',
    ),
    reason: Type.Union([
      Type.Literal('UserCredentialNotCurrent'),
      Type.Literal('TaskMandateNotAdmitted'),
      Type.Literal('TaskMandatePending'),
      Type.Literal('TaskMandateNotYetValid'),
      Type.Literal('TaskMandateExpired'),
      Type.Literal('TaskMandateRevoked'),
      Type.Literal('TaskMandateBindingRejected'),
      Type.Literal('PromotionMandateNotAdmitted'),
      Type.Literal('PromotionMandatePending'),
      Type.Literal('PromotionMandateNotYetValid'),
      Type.Literal('PromotionMandateExpired'),
      Type.Literal('PromotionMandateRevoked'),
      Type.Literal('PromotionMandateBindingRejected'),
    ]),
  },
  { additionalProperties: false },
);
export const runResourceNotFoundProblemSchema = Type.Object(
  {
    ...problem('RunResourceNotFound', 404, 'Run resource was not found', 'run-resource-not-found'),
    resource: Type.Union([
      Type.Literal('Task'),
      Type.Literal('HarnessRevision'),
      Type.Literal('Run'),
    ]),
  },
  { additionalProperties: false },
);
function runConflict(reason: string) {
  return {
    ...problem('RunConflict', 409, 'Run command conflicts with durable state', 'run-conflict'),
    reason: Type.Literal(reason),
  };
}

export const runContinuationRejectedProblemSchema = Type.Object(
  runConflict('ContinuationRejected'),
  { additionalProperties: false },
);

export const runConflictProblemSchema = Type.Union([
  Type.Object(runConflict('CommandConflict'), { additionalProperties: false }),
  Type.Object(runConflict('InitialHarnessIncumbentConflict'), {
    additionalProperties: false,
  }),
  Type.Object(runConflict('ConcurrentUpdate'), { additionalProperties: false }),
  Type.Object(runConflict('RunNotPreparing'), { additionalProperties: false }),
  Type.Object(runConflict('LeaseNotHeld'), { additionalProperties: false }),
  Type.Object(runConflict('RunNotRenewable'), { additionalProperties: false }),
  Type.Object(
    { ...runConflict('ExistingRunRequiresLaterResume'), runId: uuidV4Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...runConflict('RunAlreadyEnded'), runId: uuidV4Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...runConflict('VersionConflict'), currentVersion: safeIntegerSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...runConflict('LeaseConflict'),
      incarnationId: uuidV4Schema,
      expiresAt: timestampSchema,
      currentVersion: safeIntegerSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...runConflict('LaterResumeRequired'), expiredAt: timestampSchema },
    { additionalProperties: false },
  ),
  runContinuationRejectedProblemSchema,
]);
export const runBodyTooLargeProblemSchema = Type.Object(
  problem('RunBodyTooLarge', 413, 'Run request body is too large', 'run-body-too-large'),
  { additionalProperties: false },
);
export const runAdmissionRejectedProblemSchema = Type.Object(
  {
    ...problem('RunAdmissionRejected', 422, 'Run admission was rejected', 'run-admission-rejected'),
    reason: Type.Union([
      Type.Literal('AdmissionExchangeMalformed'),
      Type.Literal('AdmissionExchangeSaidMismatch'),
      Type.Literal('AdmissionExchangeRouteMismatch'),
      Type.Literal('AdmissionExchangeRecipientMismatch'),
      Type.Literal('AdmissionExchangeSignerMismatch'),
      Type.Literal('AdmissionExchangePayloadMismatch'),
      Type.Literal('TaskBindingMismatch'),
      Type.Literal('HarnessBindingMismatch'),
      Type.Literal('RepositoryBindingMismatch'),
      Type.Literal('MandateBindingMismatch'),
      Type.Literal('BudgetRejected'),
      Type.Literal('PrincipalConflict'),
    ]),
  },
  { additionalProperties: false },
);
export const runCapacityExceededProblemSchema = Type.Object(
  {
    ...problem('RunCapacityExceeded', 429, 'Run capacity is exhausted', 'run-capacity-exceeded'),
    scope: Type.Union([Type.Literal('Owner'), Type.Literal('Global')]),
  },
  { additionalProperties: false },
);
export const runUnavailableProblemSchema = Type.Object(
  {
    ...problem('RunUnavailable', 503, 'Run dependency is unavailable', 'run-unavailable'),
    dependency: Type.Union([
      Type.Literal('HostedMongoDB'),
      Type.Literal('Keria'),
      Type.Literal('Witness'),
    ]),
  },
  { additionalProperties: false },
);

export const runProblemSchema = Type.Union([
  runRequestInvalidProblemSchema,
  runCapabilityInvalidProblemSchema,
  runAdmissionForbiddenProblemSchema,
  runResourceNotFoundProblemSchema,
  runConflictProblemSchema,
  runBodyTooLargeProblemSchema,
  runAdmissionRejectedProblemSchema,
  runCapacityExceededProblemSchema,
  runUnavailableProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
]);

export type RunProblem = Type.Static<typeof runProblemSchema>;
