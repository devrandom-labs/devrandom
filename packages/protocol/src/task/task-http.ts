import Type from 'typebox';
import { Value } from 'typebox/value';

import {
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '../work-access.js';
import {
  decodeAuthorizedTaskRevision,
  authorizedPreparedTaskCommandSchema,
  authorizedTaskRevisionSchema,
  taskLabelSchema,
  type TaskRevisionInvalidity,
  type TaskRevision,
  type TaskRevisionV2,
} from './task-command.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const createTaskBodySchema = authorizedPreparedTaskCommandSchema;
export type CreateTaskBody = Type.Static<typeof createTaskBodySchema>;

export const taskLifecycleSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Open') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Completed') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Cancelled') }, { additionalProperties: false }),
]);

const taskProperties = {
  version: Type.Literal(1),
  taskId: uuidV4Schema,
  ownerAid: keriIdentifierSchema,
  label: taskLabelSchema,
  harnessLineageId: uuidV4Schema,
  revisionSaid: keriIdentifierSchema,
  lifecycle: taskLifecycleSchema,
  commandId: uuidV4Schema,
  createdAt: timestampSchema,
  expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};

export const taskProjectionSchema = Type.Object(
  {
    ...taskProperties,
    revision: authorizedTaskRevisionSchema,
  },
  { additionalProperties: false },
);

export type TaskProjection = Type.Static<typeof taskProjectionSchema>;
export type TaskProjectionV1 = Omit<TaskProjection, 'revision'> & {
  readonly revision: TaskRevision;
};
export type TaskProjectionV2 = Omit<TaskProjection, 'revision'> & {
  readonly revision: TaskRevisionV2;
};

export type TaskProjectionDecoding =
  | { readonly kind: 'Accepted'; readonly projection: TaskProjection }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'RevisionInvalid';
      readonly revisionInvalidity: TaskRevisionInvalidity;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'RevisionSaidMismatch' }
  | { readonly kind: 'Rejected'; readonly reason: 'DeadlineInvalid' };

export function decodeTaskProjection(input: unknown): TaskProjectionDecoding {
  if (!Value.Check(taskProjectionSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const revision = decodeAuthorizedTaskRevision(input.revision);
  if (revision.kind === 'Rejected') {
    return {
      kind: 'Rejected',
      reason: 'RevisionInvalid',
      revisionInvalidity: revision.reason,
    };
  }
  if (input.revisionSaid !== revision.revision.d) {
    return { kind: 'Rejected', reason: 'RevisionSaidMismatch' };
  }
  const createdAt = Date.parse(input.createdAt);
  const expiresAt = Date.parse(revision.revision.expiresAt);
  const lifetimeMilliseconds = expiresAt - createdAt;
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    lifetimeMilliseconds <= 0 ||
    lifetimeMilliseconds > 4 * 60 * 60 * 1_000
  ) {
    return { kind: 'Rejected', reason: 'DeadlineInvalid' };
  }
  return { kind: 'Accepted', projection: input };
}

export const taskSummarySchema = Type.Object(taskProperties, { additionalProperties: false });
export type TaskSummary = Type.Static<typeof taskSummarySchema>;

export const taskListProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    tasks: Type.Array(taskSummarySchema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export type TaskListProjection = Type.Static<typeof taskListProjectionSchema>;

export const taskListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

export type TaskListQuery = Type.Static<typeof taskListQuerySchema>;

export const taskLabelParametersSchema = Type.Object(
  { label: taskLabelSchema },
  { additionalProperties: false },
);

export type TaskLabelParameters = Type.Static<typeof taskLabelParametersSchema>;

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

export const taskRequestInvalidProblemSchema = Type.Object(
  problem('TaskRequestInvalid', 400, 'Task request is invalid', 'task-request-invalid'),
  { additionalProperties: false },
);

export const taskCapabilityInvalidProblemSchema = Type.Object(
  problem(
    'TaskCapabilityInvalid',
    401,
    'Work Access capability is invalid',
    'task-capability-invalid',
  ),
  { additionalProperties: false },
);

export const taskCreationForbiddenProblemSchema = Type.Object(
  {
    ...problem('TaskCreationForbidden', 403, 'Task creation is not permitted', 'task-forbidden'),
    reason: Type.Union([
      Type.Literal('ScopeMissing'),
      Type.Literal('EligibilityMissing'),
      Type.Literal('CredentialNotCurrent'),
    ]),
  },
  { additionalProperties: false },
);

export const taskNotFoundProblemSchema = Type.Object(
  problem('TaskNotFound', 404, 'Task was not found', 'task-not-found'),
  { additionalProperties: false },
);

export const taskCommandConflictProblemSchema = Type.Object(
  {
    ...problem(
      'TaskCommandConflict',
      409,
      'Task command conflicts with its prior use',
      'task-command-conflict',
    ),
    commandId: uuidV4Schema,
  },
  { additionalProperties: false },
);

export const taskLabelConflictProblemSchema = Type.Object(
  {
    ...problem('TaskLabelConflict', 409, 'Task label already exists', 'task-label-conflict'),
    label: taskLabelSchema,
  },
  { additionalProperties: false },
);

export const taskBodyTooLargeProblemSchema = Type.Object(
  problem('TaskBodyTooLarge', 413, 'Task request body is too large', 'task-body-too-large'),
  { additionalProperties: false },
);

export const taskContractRejectedProblemSchema = Type.Object(
  {
    ...problem('TaskContractRejected', 422, 'Task contract was rejected', 'task-contract-rejected'),
    reason: Type.Union([
      Type.Literal('SecretDetected'),
      Type.Literal('RepositoryBindingInvalid'),
      Type.Literal('BudgetUnacceptable'),
      Type.Literal('DeadlineUnacceptable'),
      Type.Literal('CapabilityConflict'),
      Type.Literal('CheckpointReferenceInvalid'),
    ]),
  },
  { additionalProperties: false },
);

export const taskCapacityProblemSchema = Type.Object(
  problem('TaskCapacityExceeded', 429, 'Task capacity exceeded', 'task-capacity-exceeded'),
  { additionalProperties: false },
);

export const taskUnavailableProblemSchema = Type.Object(
  {
    ...problem('TaskUnavailable', 503, 'Task dependency is unavailable', 'task-unavailable'),
    dependency: Type.Union([
      Type.Literal('HostedMongoDB'),
      Type.Literal('Keria'),
      Type.Literal('Witness'),
    ]),
  },
  { additionalProperties: false },
);

export const taskProblemSchema = Type.Union([
  taskRequestInvalidProblemSchema,
  taskCapabilityInvalidProblemSchema,
  taskCreationForbiddenProblemSchema,
  taskNotFoundProblemSchema,
  taskCommandConflictProblemSchema,
  taskLabelConflictProblemSchema,
  taskBodyTooLargeProblemSchema,
  taskContractRejectedProblemSchema,
  taskCapacityProblemSchema,
  taskUnavailableProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
]);

export type TaskProblem = Type.Static<typeof taskProblemSchema>;
