import {
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  taskRecoveryBudgetCeilings,
  taskEvolutionClasses,
  taskToolCapabilities,
  type TaskEvaluationCapability,
} from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import { Value } from 'typebox/value';

import { rfc8785Sha256 } from '../rfc-8785.js';

const safeInteger = (maximum: number) => Type.Integer({ minimum: 0, maximum });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const taskLabelSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z][a-z0-9-]{0,62}$',
});

const boundedTextSchema = (maximum: number) =>
  Type.String({
    minLength: 1,
    maxLength: maximum,
    pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
  });

const relativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*[\\\\\\u0000-\\u001f\\u007f-\\u009f])[^/]+(?:/[^/]+)*$',
});

const gitSha1Schema = Type.String({ pattern: '^[a-f0-9]{40}$' });
const gitSha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });

export const sourceRepositorySchema = Type.Union([
  Type.Object({ kind: Type.Literal('currentHead') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('gitCommit'), commit: Type.Union([gitSha1Schema, gitSha256Schema]) },
    { additionalProperties: false },
  ),
]);

export type SourceRepository = Type.Static<typeof sourceRepositorySchema>;

export const preparedRepositorySchema = Type.Union([
  Type.Object(
    { objectFormat: Type.Literal('sha1'), commit: gitSha1Schema, tree: gitSha1Schema },
    { additionalProperties: false },
  ),
  Type.Object(
    { objectFormat: Type.Literal('sha256'), commit: gitSha256Schema, tree: gitSha256Schema },
    { additionalProperties: false },
  ),
]);

export type PreparedRepository = Type.Static<typeof preparedRepositorySchema>;

export const taskDeliverableSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('repositoryFile'),
      id: taskLabelSchema,
      path: relativePathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('namedResult'),
      id: taskLabelSchema,
      name: boundedTextSchema(240),
      description: boundedTextSchema(2_000),
    },
    { additionalProperties: false },
  ),
]);

const executableCommandProperties = {
  id: taskLabelSchema,
  argv: Type.Array(boundedTextSchema(1_024), { minItems: 1, maxItems: 32 }),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 300 }),
  expected: Type.Object(
    {
      kind: Type.Literal('exitCode'),
      code: Type.Integer({ minimum: 0, maximum: 255 }),
    },
    { additionalProperties: false },
  ),
};

export const taskCompletionConditionSchema = Type.Object(executableCommandProperties, {
  additionalProperties: false,
});

export const taskToolCommandSchema = Type.Object(
  {
    capability: Type.Union([Type.Literal('RunFormatter'), Type.Literal('RunStaticAnalysis')]),
    ...executableCommandProperties,
  },
  { additionalProperties: false },
);

export const taskEffectSchema = Type.Union([
  Type.Literal('NetworkAccess'),
  Type.Literal('PackageInstall'),
  Type.Literal('GitHistoryWrite'),
  Type.Literal('BackgroundProcess'),
  Type.Literal('CredentialAccess'),
  Type.Literal('ExternalFilesystemWrite'),
]);

export const toolCapabilitySchema = Type.Union([
  Type.Literal(taskToolCapabilities[0]),
  Type.Literal(taskToolCapabilities[1]),
  Type.Literal(taskToolCapabilities[2]),
  Type.Literal(taskToolCapabilities[3]),
  Type.Literal(taskToolCapabilities[4]),
  Type.Literal(taskToolCapabilities[5]),
]);

export type ToolCapability = Type.Static<typeof toolCapabilitySchema>;

export const evolutionClassSchema = Type.Union([
  Type.Literal(taskEvolutionClasses[0]),
  Type.Literal(taskEvolutionClasses[1]),
  Type.Literal(taskEvolutionClasses[2]),
]);

export const checkpointExpectationSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('deliverable'), deliverableId: taskLabelSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('completionCondition'),
      completionConditionId: taskLabelSchema,
    },
    { additionalProperties: false },
  ),
]);

export { taskBudgetCeilings };
export { taskEvaluationBudgetCeilings };
export { taskRecoveryBudgetCeilings };

export const taskBudgetsSchema = Type.Object(
  {
    workAccessAttemptLifetimeSeconds: safeInteger(
      taskBudgetCeilings.workAccessAttemptLifetimeSeconds,
    ),
    workAccessGrantLifetimeSeconds: safeInteger(taskBudgetCeilings.workAccessGrantLifetimeSeconds),
    nonterminalAttemptsPerUserClient: safeInteger(
      taskBudgetCeilings.nonterminalAttemptsPerUserClient,
    ),
    activeGrantsPerUserClient: safeInteger(taskBudgetCeilings.activeGrantsPerUserClient),
    publicAttemptCreationsPerMinutePerLoopbackSource: safeInteger(
      taskBudgetCeilings.publicAttemptCreationsPerMinutePerLoopbackSource,
    ),
    nonterminalAttemptsGlobally: safeInteger(taskBudgetCeilings.nonterminalAttemptsGlobally),
    requestsPerGrant: safeInteger(taskBudgetCeilings.requestsPerGrant),
    tasksPerAdmittedUser: safeInteger(taskBudgetCeilings.tasksPerAdmittedUser),
    runsPerAdmittedUser: safeInteger(taskBudgetCeilings.runsPerAdmittedUser),
    activeRunsPerAdmittedUser: safeInteger(taskBudgetCeilings.activeRunsPerAdmittedUser),
    hostedWorkTasksGlobally: safeInteger(taskBudgetCeilings.hostedWorkTasksGlobally),
    hostedWorkRunsGlobally: safeInteger(taskBudgetCeilings.hostedWorkRunsGlobally),
    activeHostedWorkRunsGlobally: safeInteger(taskBudgetCeilings.activeHostedWorkRunsGlobally),
    ordinaryJsonRequestBodyBytes: safeInteger(taskBudgetCeilings.ordinaryJsonRequestBodyBytes),
    evidenceBatchBodyBytes: safeInteger(taskBudgetCeilings.evidenceBatchBodyBytes),
    artifactRequestBodyBytes: safeInteger(taskBudgetCeilings.artifactRequestBodyBytes),
    evidencePlusArtifactsPerRunBytes: safeInteger(
      taskBudgetCeilings.evidencePlusArtifactsPerRunBytes,
    ),
    acceptedEvidencePlusArtifactsGloballyBytes: safeInteger(
      taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes,
    ),
    runWallTimeSeconds: safeInteger(taskBudgetCeilings.runWallTimeSeconds),
    providerRequests: safeInteger(taskBudgetCeilings.providerRequests),
    providerInputTokens: safeInteger(taskBudgetCeilings.providerInputTokens),
    providerOutputTokens: safeInteger(taskBudgetCeilings.providerOutputTokens),
    toolProposals: safeInteger(taskBudgetCeilings.toolProposals),
    aggregateChildCommandTimeSeconds: safeInteger(
      taskBudgetCeilings.aggregateChildCommandTimeSeconds,
    ),
    oneChildCommandTimeSeconds: safeInteger(taskBudgetCeilings.oneChildCommandTimeSeconds),
    changedFiles: safeInteger(taskBudgetCeilings.changedFiles),
    changedWorktreeBytes: safeInteger(taskBudgetCeilings.changedWorktreeBytes),
    providerSpendMicroUsd: safeInteger(taskBudgetCeilings.providerSpendMicroUsd),
  },
  { additionalProperties: false },
);

const taskContractProperties = {
  title: boundedTextSchema(240),
  objective: boundedTextSchema(8_000),
  deliverables: Type.Array(taskDeliverableSchema, { minItems: 1, maxItems: 64 }),
  completionConditions: Type.Array(taskCompletionConditionSchema, {
    minItems: 1,
    maxItems: 32,
  }),
  toolCommands: Type.Optional(Type.Array(taskToolCommandSchema, { minItems: 1, maxItems: 32 })),
  constraints: Type.Object(
    {
      protectedPaths: Type.Array(relativePathSchema, {
        maxItems: 64,
        uniqueItems: true,
      }),
      prohibitedEffects: Type.Array(taskEffectSchema, {
        maxItems: 6,
        uniqueItems: true,
      }),
      dataPolicy: Type.Literal('RepositoryContentOnly'),
    },
    { additionalProperties: false },
  ),
  requestedCapabilities: Type.Array(toolCapabilitySchema, {
    minItems: 1,
    maxItems: 6,
    uniqueItems: true,
  }),
  unavailableCapabilities: Type.Array(toolCapabilitySchema, {
    maxItems: 6,
    uniqueItems: true,
  }),
  budgets: taskBudgetsSchema,
  expiresAt: timestampSchema,
  evolutionClasses: Type.Array(evolutionClassSchema, {
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  }),
  checkpointExpectations: Type.Array(checkpointExpectationSchema, {
    maxItems: 96,
  }),
};

export const taskSourceCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    label: taskLabelSchema,
    title: taskContractProperties.title,
    objective: taskContractProperties.objective,
    repository: sourceRepositorySchema,
    deliverables: taskContractProperties.deliverables,
    completionConditions: taskContractProperties.completionConditions,
    toolCommands: taskContractProperties.toolCommands,
    constraints: taskContractProperties.constraints,
    requestedCapabilities: taskContractProperties.requestedCapabilities,
    unavailableCapabilities: taskContractProperties.unavailableCapabilities,
    budgets: taskContractProperties.budgets,
    expiresAt: taskContractProperties.expiresAt,
    evolutionClasses: taskContractProperties.evolutionClasses,
    checkpointExpectations: taskContractProperties.checkpointExpectations,
  },
  { additionalProperties: false },
);

export type TaskSourceCommand = Type.Static<typeof taskSourceCommandSchema>;

export const taskRevisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: saidSchema,
    title: taskContractProperties.title,
    objective: taskContractProperties.objective,
    repository: preparedRepositorySchema,
    deliverables: taskContractProperties.deliverables,
    completionConditions: taskContractProperties.completionConditions,
    toolCommands: taskContractProperties.toolCommands,
    constraints: taskContractProperties.constraints,
    requestedCapabilities: taskContractProperties.requestedCapabilities,
    unavailableCapabilities: taskContractProperties.unavailableCapabilities,
    budgets: taskContractProperties.budgets,
    expiresAt: taskContractProperties.expiresAt,
    evolutionClasses: taskContractProperties.evolutionClasses,
    checkpointExpectations: taskContractProperties.checkpointExpectations,
  },
  { additionalProperties: false },
);

export type TaskRevision = Type.Static<typeof taskRevisionSchema>;

export const preparedTaskCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuidV4Schema,
    label: taskLabelSchema,
    revision: taskRevisionSchema,
  },
  { additionalProperties: false },
);

export type PreparedTaskCommand = Type.Static<typeof preparedTaskCommandSchema>;

export const taskEvaluationBudgetsSchema = Type.Object(
  {
    ...taskBudgetsSchema.properties,
    tasksPerAdmittedUser: safeInteger(taskRecoveryBudgetCeilings.tasksPerAdmittedUser),
    runsPerAdmittedUser: safeInteger(taskRecoveryBudgetCeilings.runsPerAdmittedUser),
    artifactRequestBodyBytes: safeInteger(taskEvaluationBudgetCeilings.artifactRequestBodyBytes),
    evidencePlusArtifactsPerRunBytes: safeInteger(
      taskEvaluationBudgetCeilings.evidencePlusArtifactsPerRunBytes,
    ),
    runWallTimeSeconds: safeInteger(taskEvaluationBudgetCeilings.runWallTimeSeconds),
    providerRequests: safeInteger(taskEvaluationBudgetCeilings.providerRequests),
    providerInputTokens: safeInteger(taskEvaluationBudgetCeilings.providerInputTokens),
    providerOutputTokens: safeInteger(taskEvaluationBudgetCeilings.providerOutputTokens),
    toolProposals: safeInteger(taskEvaluationBudgetCeilings.toolProposals),
    aggregateChildCommandTimeSeconds: safeInteger(
      taskEvaluationBudgetCeilings.aggregateChildCommandTimeSeconds,
    ),
    providerSpendMicroUsd: safeInteger(taskEvaluationBudgetCeilings.providerSpendMicroUsd),
  },
  { additionalProperties: false },
);

export const evaluationExperienceSchema = Type.Object(
  {
    corpusSaid: saidSchema,
    repositoryResourceSaid: saidSchema,
    disclosure: Type.Literal('AuthorizedAnalogy'),
  },
  { additionalProperties: false },
);

const evaluationConstraintsSchema = Type.Object(
  {
    protectedPaths: taskContractProperties.constraints.properties.protectedPaths,
    prohibitedEffects: taskContractProperties.constraints.properties.prohibitedEffects,
    dataPolicy: Type.Literal('RepositoryAndAuthorizedTaskExperience'),
    experience: evaluationExperienceSchema,
  },
  { additionalProperties: false },
);

export const evaluationToolCapabilitySchema = Type.Union([
  toolCapabilitySchema,
  Type.Literal('ReadTaskMemory'),
]);

const taskEvaluationContractProperties = {
  ...taskContractProperties,
  constraints: evaluationConstraintsSchema,
  requestedCapabilities: Type.Array(evaluationToolCapabilitySchema, {
    minItems: 2,
    maxItems: 7,
    uniqueItems: true,
  }),
  unavailableCapabilities: Type.Array(evaluationToolCapabilitySchema, {
    maxItems: 7,
    uniqueItems: true,
  }),
  budgets: taskEvaluationBudgetsSchema,
};

export const taskSourceCommandV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    label: taskLabelSchema,
    ...taskEvaluationContractProperties,
    repository: sourceRepositorySchema,
  },
  { additionalProperties: false },
);

export const taskRevisionV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    d: saidSchema,
    title: taskEvaluationContractProperties.title,
    objective: taskEvaluationContractProperties.objective,
    repository: preparedRepositorySchema,
    deliverables: taskEvaluationContractProperties.deliverables,
    completionConditions: taskEvaluationContractProperties.completionConditions,
    toolCommands: taskEvaluationContractProperties.toolCommands,
    constraints: taskEvaluationContractProperties.constraints,
    requestedCapabilities: taskEvaluationContractProperties.requestedCapabilities,
    unavailableCapabilities: taskEvaluationContractProperties.unavailableCapabilities,
    budgets: taskEvaluationContractProperties.budgets,
    expiresAt: taskEvaluationContractProperties.expiresAt,
    evolutionClasses: taskEvaluationContractProperties.evolutionClasses,
    checkpointExpectations: taskEvaluationContractProperties.checkpointExpectations,
  },
  { additionalProperties: false },
);

export const preparedTaskCommandV2Schema = Type.Object(
  {
    version: Type.Literal(2),
    commandId: uuidV4Schema,
    label: taskLabelSchema,
    revision: taskRevisionV2Schema,
  },
  { additionalProperties: false },
);

export type TaskSourceCommandV2 = Type.Static<typeof taskSourceCommandV2Schema>;
export type TaskRevisionV2 = Type.Static<typeof taskRevisionV2Schema>;
export type PreparedTaskCommandV2 = Type.Static<typeof preparedTaskCommandV2Schema>;

export const authorizedTaskSourceCommandSchema = Type.Union([
  taskSourceCommandSchema,
  taskSourceCommandV2Schema,
]);
export const authorizedTaskRevisionSchema = Type.Union([taskRevisionSchema, taskRevisionV2Schema]);
export const authorizedPreparedTaskCommandSchema = Type.Union([
  preparedTaskCommandSchema,
  preparedTaskCommandV2Schema,
]);
export type AuthorizedTaskSourceCommand = Type.Static<typeof authorizedTaskSourceCommandSchema>;
export type AuthorizedTaskRevision = Type.Static<typeof authorizedTaskRevisionSchema>;
export type AuthorizedPreparedTaskCommand = Type.Static<typeof authorizedPreparedTaskCommandSchema>;

export type TaskContractInvalidity =
  | 'DeadlineInvalid'
  | 'TextConstraintViolation'
  | 'DuplicateDeliverableId'
  | 'DuplicateDeliverablePath'
  | 'DuplicateCompletionConditionId'
  | 'DuplicateToolCommandId'
  | 'ToolCommandCapabilityUnrequested'
  | 'ToolCommandTimeoutExceedsBudget'
  | 'DuplicateCheckpointReference'
  | 'UnknownCheckpointReference'
  | 'CapabilitySetsOverlap'
  | 'CompletionTimeoutExceedsBudget'
  | 'ShellSyntaxNotAccepted'
  | 'ExperienceCapabilityMissing';

export type TaskPreparationRejectionReason =
  'SchemaInvalid' | TaskContractInvalidity | 'RepositoryBindingMismatch' | 'SaidConstructionFailed';

export type TaskPreparation =
  | { readonly kind: 'Prepared'; readonly command: PreparedTaskCommand }
  | { readonly kind: 'Rejected'; readonly reason: TaskPreparationRejectionReason };

export type TaskRevisionInvalidity =
  'SchemaInvalid' | TaskContractInvalidity | 'NonCanonical' | 'SaidMismatch';

export type TaskRevisionDecoding =
  | { readonly kind: 'Accepted'; readonly revision: TaskRevision }
  | { readonly kind: 'Rejected'; readonly reason: TaskRevisionInvalidity };

type TaskContract = TaskSourceCommand | TaskRevision | TaskSourceCommandV2 | TaskRevisionV2;

export function taskTimestampIsCanonical(timestamp: string): boolean {
  const instant = new Date(timestamp);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === timestamp;
}

const utf8 = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte !== undefined && rightByte !== undefined && leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function utf8Sort<Value extends string>(values: readonly Value[]): Value[] {
  return [...values].sort(compareUtf8);
}

function isUnicodeScalarText(value: string, maximumScalars: number, maximumBytes: number): boolean {
  let scalars = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
    scalars += 1;
  }
  return scalars <= maximumScalars && utf8.encode(value).length <= maximumBytes;
}

function boundedContractTextIsValid(contract: TaskContract): boolean {
  if (
    !isUnicodeScalarText(contract.title, 120, 480) ||
    utf8.encode(contract.objective).length > 8_000
  ) {
    return false;
  }

  for (const deliverable of contract.deliverables) {
    if (deliverable.kind === 'repositoryFile') {
      if (utf8.encode(deliverable.path).length > 512) {
        return false;
      }
    } else if (
      !isUnicodeScalarText(deliverable.name, 120, 480) ||
      utf8.encode(deliverable.description).length > 2_000
    ) {
      return false;
    }
  }

  for (const path of contract.constraints.protectedPaths) {
    if (utf8.encode(path).length > 512) {
      return false;
    }
  }

  for (const condition of [...contract.completionConditions, ...(contract.toolCommands ?? [])]) {
    for (const argument of condition.argv) {
      if (utf8.encode(argument).length > 1_024) {
        return false;
      }
    }
  }
  return true;
}

function containsShellSyntax(argument: string): boolean {
  return (
    /[|<>`;]/u.test(argument) || argument.includes('&&') || /\$\(|\$\{|\$[A-Za-z_]/u.test(argument)
  );
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function contractRejection(contract: TaskContract): TaskContractInvalidity | undefined {
  if (
    contract.version === 2 &&
    (!contract.requestedCapabilities.includes('ReadTaskMemory') ||
      contract.unavailableCapabilities.includes('ReadTaskMemory'))
  ) {
    return 'ExperienceCapabilityMissing';
  }
  if (!taskTimestampIsCanonical(contract.expiresAt)) {
    return 'DeadlineInvalid';
  }
  if (!boundedContractTextIsValid(contract)) {
    return 'TextConstraintViolation';
  }
  if (firstDuplicate(contract.deliverables.map((deliverable) => deliverable.id)) !== undefined) {
    return 'DuplicateDeliverableId';
  }
  if (
    firstDuplicate(
      contract.deliverables.flatMap((deliverable) =>
        deliverable.kind === 'repositoryFile' ? [deliverable.path] : [],
      ),
    ) !== undefined
  ) {
    return 'DuplicateDeliverablePath';
  }
  if (
    firstDuplicate(contract.completionConditions.map((condition) => condition.id)) !== undefined
  ) {
    return 'DuplicateCompletionConditionId';
  }
  const commandIds = new Set(contract.completionConditions.map((condition) => condition.id));
  for (const command of contract.toolCommands ?? []) {
    if (commandIds.has(command.id)) return 'DuplicateToolCommandId';
    commandIds.add(command.id);
    if (!contract.requestedCapabilities.includes(command.capability)) {
      return 'ToolCommandCapabilityUnrequested';
    }
    if (
      command.timeoutSeconds > contract.budgets.oneChildCommandTimeSeconds ||
      command.timeoutSeconds > contract.budgets.aggregateChildCommandTimeSeconds
    ) {
      return 'ToolCommandTimeoutExceedsBudget';
    }
  }

  const deliverableIds = new Set(contract.deliverables.map((deliverable) => deliverable.id));
  const conditionIds = new Set(contract.completionConditions.map((condition) => condition.id));
  const checkpointReferences: string[] = [];
  for (const expectation of contract.checkpointExpectations) {
    if (expectation.kind === 'deliverable') {
      checkpointReferences.push(`deliverable:${expectation.deliverableId}`);
      if (!deliverableIds.has(expectation.deliverableId)) {
        return 'UnknownCheckpointReference';
      }
    } else {
      checkpointReferences.push(`completionCondition:${expectation.completionConditionId}`);
      if (!conditionIds.has(expectation.completionConditionId)) {
        return 'UnknownCheckpointReference';
      }
    }
  }
  if (firstDuplicate(checkpointReferences) !== undefined) {
    return 'DuplicateCheckpointReference';
  }

  const requested = new Set<TaskEvaluationCapability>(contract.requestedCapabilities);
  if (contract.unavailableCapabilities.some((capability) => requested.has(capability))) {
    return 'CapabilitySetsOverlap';
  }
  if (
    contract.completionConditions.some(
      (condition) =>
        condition.timeoutSeconds > contract.budgets.oneChildCommandTimeSeconds ||
        condition.timeoutSeconds > contract.budgets.aggregateChildCommandTimeSeconds,
    )
  ) {
    return 'CompletionTimeoutExceedsBudget';
  }
  if (
    [...contract.completionConditions, ...(contract.toolCommands ?? [])].some((condition) =>
      condition.argv.some((argument) => containsShellSyntax(argument)),
    )
  ) {
    return 'ShellSyntaxNotAccepted';
  }
  return undefined;
}

function rebuildRepository(repository: PreparedRepository): PreparedRepository {
  return {
    objectFormat: repository.objectFormat,
    commit: repository.commit,
    tree: repository.tree,
  };
}

function rebuildContract(contract: TaskContract, repository: PreparedRepository, d: string) {
  return {
    version: contract.version,
    d,
    title: contract.title,
    objective: contract.objective,
    repository: rebuildRepository(repository),
    deliverables: contract.deliverables.map((deliverable) =>
      deliverable.kind === 'repositoryFile'
        ? { kind: deliverable.kind, id: deliverable.id, path: deliverable.path }
        : {
            kind: deliverable.kind,
            id: deliverable.id,
            name: deliverable.name,
            description: deliverable.description,
          },
    ),
    completionConditions: contract.completionConditions.map((condition) => ({
      id: condition.id,
      argv: [...condition.argv],
      timeoutSeconds: condition.timeoutSeconds,
      expected: { kind: condition.expected.kind, code: condition.expected.code },
    })),
    ...(contract.toolCommands === undefined
      ? {}
      : {
          toolCommands: contract.toolCommands.map((command) => ({
            capability: command.capability,
            id: command.id,
            argv: [...command.argv],
            timeoutSeconds: command.timeoutSeconds,
            expected: { kind: command.expected.kind, code: command.expected.code },
          })),
        }),
    constraints: {
      protectedPaths: utf8Sort(contract.constraints.protectedPaths),
      prohibitedEffects: utf8Sort(contract.constraints.prohibitedEffects),
      dataPolicy: contract.constraints.dataPolicy,
      ...(contract.version === 2
        ? {
            experience: {
              corpusSaid: contract.constraints.experience.corpusSaid,
              repositoryResourceSaid: contract.constraints.experience.repositoryResourceSaid,
              disclosure: contract.constraints.experience.disclosure,
            },
          }
        : {}),
    },
    requestedCapabilities: utf8Sort(contract.requestedCapabilities),
    unavailableCapabilities: utf8Sort(contract.unavailableCapabilities),
    budgets: {
      workAccessAttemptLifetimeSeconds: contract.budgets.workAccessAttemptLifetimeSeconds,
      workAccessGrantLifetimeSeconds: contract.budgets.workAccessGrantLifetimeSeconds,
      nonterminalAttemptsPerUserClient: contract.budgets.nonterminalAttemptsPerUserClient,
      activeGrantsPerUserClient: contract.budgets.activeGrantsPerUserClient,
      publicAttemptCreationsPerMinutePerLoopbackSource:
        contract.budgets.publicAttemptCreationsPerMinutePerLoopbackSource,
      nonterminalAttemptsGlobally: contract.budgets.nonterminalAttemptsGlobally,
      requestsPerGrant: contract.budgets.requestsPerGrant,
      tasksPerAdmittedUser: contract.budgets.tasksPerAdmittedUser,
      runsPerAdmittedUser: contract.budgets.runsPerAdmittedUser,
      activeRunsPerAdmittedUser: contract.budgets.activeRunsPerAdmittedUser,
      hostedWorkTasksGlobally: contract.budgets.hostedWorkTasksGlobally,
      hostedWorkRunsGlobally: contract.budgets.hostedWorkRunsGlobally,
      activeHostedWorkRunsGlobally: contract.budgets.activeHostedWorkRunsGlobally,
      ordinaryJsonRequestBodyBytes: contract.budgets.ordinaryJsonRequestBodyBytes,
      evidenceBatchBodyBytes: contract.budgets.evidenceBatchBodyBytes,
      artifactRequestBodyBytes: contract.budgets.artifactRequestBodyBytes,
      evidencePlusArtifactsPerRunBytes: contract.budgets.evidencePlusArtifactsPerRunBytes,
      acceptedEvidencePlusArtifactsGloballyBytes:
        contract.budgets.acceptedEvidencePlusArtifactsGloballyBytes,
      runWallTimeSeconds: contract.budgets.runWallTimeSeconds,
      providerRequests: contract.budgets.providerRequests,
      providerInputTokens: contract.budgets.providerInputTokens,
      providerOutputTokens: contract.budgets.providerOutputTokens,
      toolProposals: contract.budgets.toolProposals,
      aggregateChildCommandTimeSeconds: contract.budgets.aggregateChildCommandTimeSeconds,
      oneChildCommandTimeSeconds: contract.budgets.oneChildCommandTimeSeconds,
      changedFiles: contract.budgets.changedFiles,
      changedWorktreeBytes: contract.budgets.changedWorktreeBytes,
      providerSpendMicroUsd: contract.budgets.providerSpendMicroUsd,
    },
    expiresAt: contract.expiresAt,
    evolutionClasses: utf8Sort(contract.evolutionClasses),
    checkpointExpectations: contract.checkpointExpectations.map((expectation) =>
      expectation.kind === 'deliverable'
        ? { kind: expectation.kind, deliverableId: expectation.deliverableId }
        : {
            kind: expectation.kind,
            completionConditionId: expectation.completionConditionId,
          },
    ),
  };
}

export function prepareTaskCommand(
  source: TaskSourceCommand,
  commandId: string,
  repository: PreparedRepository,
): TaskPreparation {
  if (
    !Value.Check(taskSourceCommandSchema, source) ||
    !Value.Check(uuidV4Schema, commandId) ||
    !Value.Check(preparedRepositorySchema, repository)
  ) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (source.repository.kind === 'gitCommit' && source.repository.commit !== repository.commit) {
    return { kind: 'Rejected', reason: 'RepositoryBindingMismatch' };
  }
  const rejection = contractRejection(source);
  if (rejection !== undefined) {
    return { kind: 'Rejected', reason: rejection };
  }

  try {
    const candidate = rebuildContract(source, repository, '');
    const saidified: unknown = Saider.saidify(candidate)[1];
    if (!Value.Check(taskRevisionSchema, saidified)) {
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    }
    return {
      kind: 'Prepared',
      command: { version: 1, commandId, label: source.label, revision: saidified },
    };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export type TaskPreparationV2 =
  | { readonly kind: 'Prepared'; readonly command: PreparedTaskCommandV2 }
  | { readonly kind: 'Rejected'; readonly reason: TaskPreparationRejectionReason };

export function prepareTaskCommandV2(
  source: unknown,
  commandId: string,
  repository: PreparedRepository,
): TaskPreparationV2 {
  if (
    !Value.Check(taskSourceCommandV2Schema, source) ||
    !Value.Check(uuidV4Schema, commandId) ||
    !Value.Check(preparedRepositorySchema, repository)
  )
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (source.repository.kind === 'gitCommit' && source.repository.commit !== repository.commit)
    return { kind: 'Rejected', reason: 'RepositoryBindingMismatch' };
  const rejection = contractRejection(source);
  if (rejection !== undefined) return { kind: 'Rejected', reason: rejection };
  try {
    const candidate = rebuildContract(source, repository, '');
    const saidified: unknown = Saider.saidify(candidate)[1];
    if (!Value.Check(taskRevisionV2Schema, saidified))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return {
      kind: 'Prepared',
      command: { version: 2, commandId, label: source.label, revision: saidified },
    };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export type TaskRevisionDecodingV2 =
  | { readonly kind: 'Accepted'; readonly revision: TaskRevisionV2 }
  | { readonly kind: 'Rejected'; readonly reason: TaskRevisionInvalidity };

export function decodeTaskRevisionV2(input: unknown): TaskRevisionDecodingV2 {
  if (!Value.Check(taskRevisionV2Schema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalidity = contractRejection(input);
  if (invalidity !== undefined) return { kind: 'Rejected', reason: invalidity };
  const canonical = rebuildContract(input, input.repository, input.d);
  if (JSON.stringify(input) !== JSON.stringify(canonical))
    return { kind: 'Rejected', reason: 'NonCanonical' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', revision: input };
}

export function decodeTaskRevision(input: unknown): TaskRevisionDecoding {
  if (!Value.Check(taskRevisionSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const invalidity = contractRejection(input);
  if (invalidity !== undefined) {
    return { kind: 'Rejected', reason: invalidity };
  }
  const canonical = rebuildContract(input, input.repository, input.d);
  if (JSON.stringify(input) !== JSON.stringify(canonical)) {
    return { kind: 'Rejected', reason: 'NonCanonical' };
  }
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false)) {
      return { kind: 'Rejected', reason: 'SaidMismatch' };
    }
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', revision: input };
}

export function taskCommandFingerprint(command: PreparedTaskCommand): string {
  if (
    !Value.Check(preparedTaskCommandSchema, command) ||
    decodeTaskRevision(command.revision).kind !== 'Accepted'
  ) {
    throw new TypeError('Task command fingerprint requires a valid prepared command');
  }
  const content = {
    version: command.version,
    label: command.label,
    revision: command.revision,
  };
  return rfc8785Sha256(content);
}

export function prepareAuthorizedTaskCommand(
  source: unknown,
  commandId: string,
  repository: PreparedRepository,
): TaskPreparation | TaskPreparationV2 {
  if (Value.Check(taskSourceCommandV2Schema, source))
    return prepareTaskCommandV2(source, commandId, repository);
  if (Value.Check(taskSourceCommandSchema, source))
    return prepareTaskCommand(source, commandId, repository);
  return { kind: 'Rejected', reason: 'SchemaInvalid' };
}

export function decodeAuthorizedTaskRevision(
  input: unknown,
): TaskRevisionDecoding | TaskRevisionDecodingV2 {
  if (Value.Check(taskRevisionV2Schema, input)) return decodeTaskRevisionV2(input);
  return decodeTaskRevision(input);
}

export function authorizedTaskCommandFingerprint(command: {
  readonly version: 1 | 2;
  readonly commandId: string;
  readonly label: string;
  readonly revision: AuthorizedTaskRevision;
}): string {
  if (command.version === 1 && Value.Check(preparedTaskCommandSchema, command))
    return taskCommandFingerprint(command);
  if (
    !Value.Check(preparedTaskCommandV2Schema, command) ||
    decodeTaskRevisionV2(command.revision).kind !== 'Accepted'
  )
    throw new TypeError('Task command fingerprint requires a valid prepared command');
  return rfc8785Sha256({
    version: command.version,
    label: command.label,
    revision: command.revision,
  });
}
