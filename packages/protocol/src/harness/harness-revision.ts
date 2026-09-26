import {
  deriveBaselineHarness,
  type BaselineHarnessDerivationInput,
  type BaselineHarnessManifest,
  type HarnessCommand,
  type HarnessToolCommand,
  type HarnessComponentReference,
  type HarnessInstructionResource,
  type HarnessToolDefinition,
  type ReviewedHarnessResource,
  type TaskToolCapability,
} from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import { Value } from 'typebox/value';

import {
  taskBudgetsSchema,
  taskToolCommandSchema,
  toolCapabilitySchema,
  type TaskRevision,
} from '../task/task-command.js';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const identitySchema = Type.String({
  minLength: 1,
  maxLength: 96,
  pattern: '^[a-z][a-z0-9._-]*$',
});
const versionSchema = Type.Integer({ minimum: 1, maximum: 65_535 });
const boundedArgumentSchema = Type.String({
  minLength: 1,
  maxLength: 1_024,
  pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$',
});
const relativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*[\\\\\\u0000-\\u001f\\u007f-\\u009f])[^/]+(?:/[^/]+)*$',
});
const absoluteExecutableRealpathSchema = Type.String({
  minLength: 2,
  maxLength: 4_096,
  pattern: '^/(?!.*//)(?!.*(?:/\\.{1,2})(?:/|$))[^\\u0000-\\u001f\\u007f-\\u009f]+$',
});
const gitSha1Schema = Type.String({ pattern: '^[a-f0-9]{40}$' });
const gitSha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });

const componentReferenceSchema = Type.Object(
  {
    identity: identitySchema,
    version: versionSchema,
    contentSaid: saidSchema,
  },
  { additionalProperties: false },
);

const reviewedResourceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('Workflow'), Type.Literal('Skill')]),
    identity: identitySchema,
    version: versionSchema,
    contentSaid: saidSchema,
  },
  { additionalProperties: false },
);

const toolDefinitionSchema = Type.Object(
  {
    identity: identitySchema,
    version: versionSchema,
    contentSaid: saidSchema,
    requiredCapability: toolCapabilitySchema,
  },
  { additionalProperties: false },
);

const instructionResourceSchema = Type.Object(
  { path: relativePathSchema, contentSaid: saidSchema },
  { additionalProperties: false },
);

const commandProperties = {
  identity: identitySchema,
  contentSaid: saidSchema,
  executableRealpath: absoluteExecutableRealpathSchema,
  argv: Type.Array(boundedArgumentSchema, { minItems: 1, maxItems: 32 }),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 300 }),
  expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
};
const completionCommandSchema = Type.Object(commandProperties, { additionalProperties: false });
const toolCommandSchema = Type.Object(
  {
    capability: Type.Union([Type.Literal('RunFormatter'), Type.Literal('RunStaticAnalysis')]),
    ...commandProperties,
  },
  { additionalProperties: false },
);

const capabilitySetSchema = Type.Array(toolCapabilitySchema, {
  maxItems: 6,
  uniqueItems: true,
});

const modelCompatibilitySchema = Type.Object(
  {
    provider: identitySchema,
    model: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
    }),
    contextWindowTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
    maximumOutputTokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    thinkingLevel: Type.Union([
      Type.Literal('off'),
      Type.Literal('minimal'),
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('xhigh'),
    ]),
    credentialSource: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,95}$' }),
    toolCalls: Type.Union([Type.Literal('Supported'), Type.Literal('Unsupported')]),
    usageAccounting: Type.Union([Type.Literal('Required'), Type.Literal('Unsupported')]),
  },
  { additionalProperties: false },
);

const runtimeVersionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[0-9][A-Za-z0-9.+_-]*$',
});

const environmentCompatibilitySchema = Type.Object(
  {
    operatingSystem: Type.Union([Type.Literal('darwin'), Type.Literal('linux')]),
    architecture: Type.Union([Type.Literal('arm64'), Type.Literal('x64')]),
    nodeVersion: runtimeVersionSchema,
    gitVersion: runtimeVersionSchema,
    piSdkVersion: Type.Literal('0.87.1'),
    xstateVersion: Type.Literal('5.33.2'),
  },
  { additionalProperties: false },
);

export const baselineHarnessRevisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: saidSchema,
    kind: Type.Literal('InitialSpecialization'),
    template: componentReferenceSchema,
    task: Type.Object(
      {
        taskId: uuidV4Schema,
        revisionSaid: saidSchema,
        harnessLineageId: uuidV4Schema,
        requestedCapabilities: Type.Array(toolCapabilitySchema, {
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    authority: Type.Object(
      {
        personalAgentAid: saidSchema,
        taskMandateSaid: saidSchema,
        allowedCapabilities: Type.Array(toolCapabilitySchema, {
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    repository: Type.Union([
      Type.Object(
        {
          objectFormat: Type.Literal('sha1'),
          commit: gitSha1Schema,
          tree: gitSha1Schema,
          instructionResources: Type.Array(instructionResourceSchema, { maxItems: 64 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          objectFormat: Type.Literal('sha256'),
          commit: gitSha256Schema,
          tree: gitSha256Schema,
          instructionResources: Type.Array(instructionResourceSchema, { maxItems: 64 }),
        },
        { additionalProperties: false },
      ),
    ]),
    reviewedResources: Type.Array(reviewedResourceSchema, { minItems: 2, maxItems: 2 }),
    orchestrationPolicy: componentReferenceSchema,
    contextSelectionPolicy: componentReferenceSchema,
    activeTools: Type.Array(toolDefinitionSchema, { minItems: 1, maxItems: 9 }),
    completionCommands: Type.Array(completionCommandSchema, { minItems: 1, maxItems: 32 }),
    toolCommands: Type.Optional(Type.Array(toolCommandSchema, { minItems: 1, maxItems: 32 })),
    modelCompatibility: modelCompatibilitySchema,
    environmentCompatibility: environmentCompatibilitySchema,
    capabilities: Type.Object(
      { available: capabilitySetSchema, unavailable: capabilitySetSchema },
      { additionalProperties: false },
    ),
    budgetCeilings: Type.Object(
      { task: taskBudgetsSchema, server: taskBudgetsSchema, mandate: taskBudgetsSchema },
      { additionalProperties: false },
    ),
    policies: Type.Object(
      {
        derivation: componentReferenceSchema,
        redaction: componentReferenceSchema,
        toolGateway: componentReferenceSchema,
        evidence: componentReferenceSchema,
        verifier: componentReferenceSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type BaselineHarnessRevision = Type.Static<typeof baselineHarnessRevisionSchema>;

interface HarnessComponentDefinition {
  readonly role:
    | 'Template'
    | 'ReviewedWorkflow'
    | 'ReviewedSkill'
    | 'OrchestrationPolicy'
    | 'ContextSelectionPolicy'
    | 'Tool'
    | 'DerivationPolicy'
    | 'RedactionPolicy'
    | 'ToolGatewayPolicy'
    | 'EvidencePolicy'
    | 'VerifierPolicy';
  readonly identity: string;
  readonly version: number;
  readonly contract: string;
  readonly requiredCapability?: TaskToolCapability;
}

function identifyCatalogueComponent(
  definition: HarnessComponentDefinition,
): HarnessComponentReference {
  const document =
    definition.requiredCapability === undefined
      ? {
          version: 1,
          d: '',
          kind: 'HarnessComponent',
          role: definition.role,
          identity: definition.identity,
          revision: definition.version,
          contract: definition.contract,
        }
      : {
          version: 1,
          d: '',
          kind: 'HarnessComponent',
          role: definition.role,
          identity: definition.identity,
          revision: definition.version,
          contract: definition.contract,
          requiredCapability: definition.requiredCapability,
        };
  const [identifier] = Saider.saidify(document);
  return Object.freeze({
    identity: definition.identity,
    version: definition.version,
    contentSaid: identifier.qb64,
  });
}

function reviewedResource(
  definition: HarnessComponentDefinition & { readonly role: 'ReviewedWorkflow' | 'ReviewedSkill' },
): ReviewedHarnessResource {
  const identified = identifyCatalogueComponent(definition);
  return Object.freeze({
    kind: definition.role === 'ReviewedWorkflow' ? 'Workflow' : 'Skill',
    ...identified,
  });
}

function toolDefinition(
  definition: HarnessComponentDefinition & {
    readonly role: 'Tool';
    readonly requiredCapability: TaskToolCapability;
  },
): HarnessToolDefinition {
  return Object.freeze({
    ...identifyCatalogueComponent(definition),
    requiredCapability: definition.requiredCapability,
  });
}

const template = identifyCatalogueComponent({
  role: 'Template',
  identity: 'coding.default',
  version: 1,
  contract: 'One repository-scoped Pi executor under Devrandom supervision.',
});
const repositoryChangeWorkflow = reviewedResource({
  role: 'ReviewedWorkflow',
  identity: 'repository-change',
  version: 1,
  contract: 'Inspect, edit, verify, and submit one bounded repository change.',
});
const reviewedResources = Object.freeze([
  repositoryChangeWorkflow,
  reviewedResource({
    role: 'ReviewedSkill',
    identity: 'bounded-repository-access',
    version: 1,
    contract: 'Use only repository-scoped context and declared completion commands.',
  }),
]);
const reviewedCommandResources = Object.freeze([
  repositoryChangeWorkflow,
  reviewedResource({
    role: 'ReviewedSkill',
    identity: 'bounded-repository-access',
    version: 2,
    contract:
      'Use repository-scoped context and only declared completion, formatter, and static-analysis commands through their matching capabilities.',
  }),
]);
const orchestrationPolicy = identifyCatalogueComponent({
  role: 'OrchestrationPolicy',
  identity: 'single-pi-executor',
  version: 1,
  contract: 'Construct one sequential Pi executor beneath the Run Supervisor.',
});
const contextSelectionPolicy = identifyCatalogueComponent({
  role: 'ContextSelectionPolicy',
  identity: 'task-repository-context',
  version: 1,
  contract: 'Select exact Task, instructions, repository evidence, and accepted event context.',
});
const toolCatalogue = Object.freeze([
  toolDefinition({
    role: 'Tool',
    identity: 'read_file',
    version: 1,
    contract: 'Read one bounded regular repository file.',
    requiredCapability: 'ReadRepository',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'list_files',
    version: 1,
    contract: 'List one bounded repository subtree.',
    requiredCapability: 'ReadRepository',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'search_repository',
    version: 1,
    contract: 'Search bounded repository text.',
    requiredCapability: 'ReadRepository',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'write_file',
    version: 1,
    contract: 'Create or replace one policy-allowed repository file.',
    requiredCapability: 'EditRepository',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'replace_text',
    version: 1,
    contract: 'Replace one exact occurrence set in a policy-allowed repository file.',
    requiredCapability: 'EditRepository',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'run_formatter',
    version: 1,
    contract: 'Run one H1-declared formatter command without a shell.',
    requiredCapability: 'RunFormatter',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'run_static_analysis',
    version: 1,
    contract: 'Run one H1-declared static-analysis command without a shell.',
    requiredCapability: 'RunStaticAnalysis',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'run_tests',
    version: 1,
    contract: 'Run one H1-declared public test command without a shell.',
    requiredCapability: 'RunTests',
  }),
  toolDefinition({
    role: 'Tool',
    identity: 'submit_result',
    version: 1,
    contract: 'Propose artifacts and invoke the public Task Verifier.',
    requiredCapability: 'SubmitResult',
  }),
]);
const policies = Object.freeze({
  derivation: identifyCatalogueComponent({
    role: 'DerivationPolicy',
    identity: 'h1-derivation',
    version: 1,
    contract: 'Pure canonical derivation of the initial specialization manifest.',
  }),
  redaction: identifyCatalogueComponent({
    role: 'RedactionPolicy',
    identity: 'credential-redaction',
    version: 1,
    contract:
      'Credentials and bearer capabilities never enter prompts, evidence, or child environments.',
  }),
  toolGateway: identifyCatalogueComponent({
    role: 'ToolGatewayPolicy',
    identity: 'sequential-tool-gateway',
    version: 1,
    contract: 'Decode, authorize, execute, and account one consequential tool call at a time.',
  }),
  evidence: identifyCatalogueComponent({
    role: 'EvidencePolicy',
    identity: 'ordered-evidence-chain',
    version: 1,
    contract: 'Record a closed predecessor-linked evidence stream and bounded artifacts.',
  }),
  verifier: identifyCatalogueComponent({
    role: 'VerifierPolicy',
    identity: 'public-task-verifier',
    version: 1,
    contract: 'Only accepted public-condition receipts can establish Task completion.',
  }),
});

export const baselineHarnessCatalogue = Object.freeze({
  template,
  reviewedResources,
  orchestrationPolicy,
  contextSelectionPolicy,
  toolCatalogue,
  policies,
});

export interface BaselineHarnessPreparationInput {
  readonly task: BaselineHarnessDerivationInput['task'];
  readonly authority: BaselineHarnessDerivationInput['authority'];
  readonly repository: BaselineHarnessDerivationInput['repository'];
  readonly completionCommands: readonly HarnessCommand[];
  readonly toolCommands: readonly HarnessToolCommand[];
  readonly modelCompatibility: BaselineHarnessDerivationInput['modelCompatibility'];
  readonly environmentCompatibility: BaselineHarnessDerivationInput['environmentCompatibility'];
  readonly capabilities: BaselineHarnessDerivationInput['capabilities'];
  readonly budgetCeilings: BaselineHarnessDerivationInput['budgetCeilings'];
}

export type BaselineHarnessPreparation =
  | { readonly kind: 'Prepared'; readonly revision: BaselineHarnessRevision }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'SaidConstructionFailed';
    }
  | Exclude<ReturnType<typeof deriveBaselineHarness>, { readonly kind: 'Derived' }>;

export type BaselineHarnessRevisionInvalidity =
  | 'SchemaInvalid'
  | 'NonCanonical'
  | 'SaidMismatch'
  | 'CatalogueMismatch'
  | 'CompletionCommandSaidMismatch'
  | 'ToolCommandSaidMismatch'
  | Exclude<ReturnType<typeof deriveBaselineHarness>, { readonly kind: 'Derived' }>['reason'];

export type BaselineHarnessRevisionDecoding =
  | { readonly kind: 'Accepted'; readonly revision: BaselineHarnessRevision }
  | { readonly kind: 'Rejected'; readonly reason: BaselineHarnessRevisionInvalidity };

const instructionInputSchema = Type.Object(
  {
    path: relativePathSchema,
    content: Type.String({ minLength: 1, maxLength: 131_072 }),
  },
  { additionalProperties: false },
);

export type HarnessInstructionIdentification =
  | { readonly kind: 'Identified'; readonly resource: HarnessInstructionResource }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'SaidConstructionFailed' };

export function identifyHarnessInstruction(input: {
  readonly path: string;
  readonly content: string;
}): HarnessInstructionIdentification {
  if (!Value.Check(instructionInputSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  try {
    const [identifier] = Saider.saidify({
      version: 1,
      d: '',
      kind: 'InstructionResource',
      mediaType: 'text/markdown;charset=utf-8',
      content: input.content,
    });
    return {
      kind: 'Identified',
      resource: { path: input.path, contentSaid: identifier.qb64 },
    };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

type TaskCompletionCondition = TaskRevision['completionConditions'][number];

export type HarnessCompletionCommandIdentification =
  | { readonly kind: 'Identified'; readonly command: HarnessCommand }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'SaidConstructionFailed' };

export function identifyHarnessCompletionCommand(
  condition: TaskCompletionCondition,
  executableRealpath: string,
): HarnessCompletionCommandIdentification {
  const input = {
    identity: condition.id,
    contentSaid: `E${'A'.repeat(43)}`,
    executableRealpath,
    argv: condition.argv,
    timeoutSeconds: condition.timeoutSeconds,
    expectedExitCode: condition.expected.code,
  };
  if (!Value.Check(completionCommandSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  try {
    const [identifier] = Saider.saidify({
      version: 1,
      d: '',
      kind: 'CompletionCommand',
      identity: condition.id,
      executableRealpath,
      argv: [...condition.argv],
      timeoutSeconds: condition.timeoutSeconds,
      expectedExitCode: condition.expected.code,
    });
    return {
      kind: 'Identified',
      command: { ...input, contentSaid: identifier.qb64 },
    };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export type HarnessToolCommandIdentification =
  | { readonly kind: 'Identified'; readonly command: HarnessToolCommand }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'SaidConstructionFailed' };

function toolCommandDocument(command: Omit<HarnessToolCommand, 'contentSaid'>, d: string) {
  return {
    version: 1,
    d,
    kind: 'ToolCommand',
    capability: command.capability,
    identity: command.identity,
    executableRealpath: command.executableRealpath,
    argv: [...command.argv],
    timeoutSeconds: command.timeoutSeconds,
    expectedExitCode: command.expectedExitCode,
  };
}

export function identifyHarnessToolCommand(
  declaration: NonNullable<TaskRevision['toolCommands']>[number],
  executableRealpath: string,
): HarnessToolCommandIdentification {
  if (
    !Value.Check(taskToolCommandSchema, declaration) ||
    !Value.Check(absoluteExecutableRealpathSchema, executableRealpath)
  ) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const command = {
    capability: declaration.capability,
    identity: declaration.id,
    executableRealpath,
    argv: [...declaration.argv],
    timeoutSeconds: declaration.timeoutSeconds,
    expectedExitCode: declaration.expected.code,
  };
  try {
    const [identifier] = Saider.saidify(toolCommandDocument(command, ''));
    return { kind: 'Identified', command: { ...command, contentSaid: identifier.qb64 } };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

function rebuildBudgets(budgets: BaselineHarnessRevision['budgetCeilings']['task']) {
  return {
    workAccessAttemptLifetimeSeconds: budgets.workAccessAttemptLifetimeSeconds,
    workAccessGrantLifetimeSeconds: budgets.workAccessGrantLifetimeSeconds,
    nonterminalAttemptsPerUserClient: budgets.nonterminalAttemptsPerUserClient,
    activeGrantsPerUserClient: budgets.activeGrantsPerUserClient,
    publicAttemptCreationsPerMinutePerLoopbackSource:
      budgets.publicAttemptCreationsPerMinutePerLoopbackSource,
    nonterminalAttemptsGlobally: budgets.nonterminalAttemptsGlobally,
    requestsPerGrant: budgets.requestsPerGrant,
    tasksPerAdmittedUser: budgets.tasksPerAdmittedUser,
    runsPerAdmittedUser: budgets.runsPerAdmittedUser,
    activeRunsPerAdmittedUser: budgets.activeRunsPerAdmittedUser,
    hostedWorkTasksGlobally: budgets.hostedWorkTasksGlobally,
    hostedWorkRunsGlobally: budgets.hostedWorkRunsGlobally,
    activeHostedWorkRunsGlobally: budgets.activeHostedWorkRunsGlobally,
    ordinaryJsonRequestBodyBytes: budgets.ordinaryJsonRequestBodyBytes,
    evidenceBatchBodyBytes: budgets.evidenceBatchBodyBytes,
    artifactRequestBodyBytes: budgets.artifactRequestBodyBytes,
    evidencePlusArtifactsPerRunBytes: budgets.evidencePlusArtifactsPerRunBytes,
    acceptedEvidencePlusArtifactsGloballyBytes: budgets.acceptedEvidencePlusArtifactsGloballyBytes,
    runWallTimeSeconds: budgets.runWallTimeSeconds,
    providerRequests: budgets.providerRequests,
    providerInputTokens: budgets.providerInputTokens,
    providerOutputTokens: budgets.providerOutputTokens,
    toolProposals: budgets.toolProposals,
    aggregateChildCommandTimeSeconds: budgets.aggregateChildCommandTimeSeconds,
    oneChildCommandTimeSeconds: budgets.oneChildCommandTimeSeconds,
    changedFiles: budgets.changedFiles,
    changedWorktreeBytes: budgets.changedWorktreeBytes,
    providerSpendMicroUsd: budgets.providerSpendMicroUsd,
  };
}

function rebuildComponent(reference: HarnessComponentReference) {
  return {
    identity: reference.identity,
    version: reference.version,
    contentSaid: reference.contentSaid,
  };
}

function rebuildRevision(manifest: BaselineHarnessManifest, d: string) {
  return {
    version: 1,
    d,
    kind: 'InitialSpecialization',
    template: rebuildComponent(manifest.template),
    task: {
      taskId: manifest.task.taskId,
      revisionSaid: manifest.task.revisionSaid,
      harnessLineageId: manifest.task.harnessLineageId,
      requestedCapabilities: [...manifest.task.requestedCapabilities],
    },
    authority: {
      personalAgentAid: manifest.authority.personalAgentAid,
      taskMandateSaid: manifest.authority.taskMandateSaid,
      allowedCapabilities: [...manifest.authority.allowedCapabilities],
    },
    repository: {
      objectFormat: manifest.repository.objectFormat,
      commit: manifest.repository.commit,
      tree: manifest.repository.tree,
      instructionResources: manifest.repository.instructionResources.map((resource) => ({
        path: resource.path,
        contentSaid: resource.contentSaid,
      })),
    },
    reviewedResources: manifest.reviewedResources.map((resource) => ({
      kind: resource.kind,
      identity: resource.identity,
      version: resource.version,
      contentSaid: resource.contentSaid,
    })),
    orchestrationPolicy: rebuildComponent(manifest.orchestrationPolicy),
    contextSelectionPolicy: rebuildComponent(manifest.contextSelectionPolicy),
    activeTools: manifest.activeTools.map((tool) => ({
      identity: tool.identity,
      version: tool.version,
      contentSaid: tool.contentSaid,
      requiredCapability: tool.requiredCapability,
    })),
    completionCommands: manifest.completionCommands.map((command) => ({
      identity: command.identity,
      contentSaid: command.contentSaid,
      executableRealpath: command.executableRealpath,
      argv: [...command.argv],
      timeoutSeconds: command.timeoutSeconds,
      expectedExitCode: command.expectedExitCode,
    })),
    ...(manifest.toolCommands.length === 0
      ? {}
      : {
          toolCommands: manifest.toolCommands.map((command) => ({
            capability: command.capability,
            identity: command.identity,
            contentSaid: command.contentSaid,
            executableRealpath: command.executableRealpath,
            argv: [...command.argv],
            timeoutSeconds: command.timeoutSeconds,
            expectedExitCode: command.expectedExitCode,
          })),
        }),
    modelCompatibility: {
      provider: manifest.modelCompatibility.provider,
      model: manifest.modelCompatibility.model,
      contextWindowTokens: manifest.modelCompatibility.contextWindowTokens,
      maximumOutputTokens: manifest.modelCompatibility.maximumOutputTokens,
      thinkingLevel: manifest.modelCompatibility.thinkingLevel,
      credentialSource: manifest.modelCompatibility.credentialSource,
      toolCalls: manifest.modelCompatibility.toolCalls,
      usageAccounting: manifest.modelCompatibility.usageAccounting,
    },
    environmentCompatibility: {
      operatingSystem: manifest.environmentCompatibility.operatingSystem,
      architecture: manifest.environmentCompatibility.architecture,
      nodeVersion: manifest.environmentCompatibility.nodeVersion,
      gitVersion: manifest.environmentCompatibility.gitVersion,
      piSdkVersion: manifest.environmentCompatibility.piSdkVersion,
      xstateVersion: manifest.environmentCompatibility.xstateVersion,
    },
    capabilities: {
      available: [...manifest.capabilities.available],
      unavailable: [...manifest.capabilities.unavailable],
    },
    budgetCeilings: {
      task: rebuildBudgets(manifest.budgetCeilings.task),
      server: rebuildBudgets(manifest.budgetCeilings.server),
      mandate: rebuildBudgets(manifest.budgetCeilings.mandate),
    },
    policies: {
      derivation: rebuildComponent(manifest.policies.derivation),
      redaction: rebuildComponent(manifest.policies.redaction),
      toolGateway: rebuildComponent(manifest.policies.toolGateway),
      evidence: rebuildComponent(manifest.policies.evidence),
      verifier: rebuildComponent(manifest.policies.verifier),
    },
  };
}

function derivationInput(input: BaselineHarnessPreparationInput): BaselineHarnessDerivationInput {
  return {
    template: baselineHarnessCatalogue.template,
    task: input.task,
    authority: input.authority,
    repository: input.repository,
    reviewedResources:
      input.toolCommands.length === 0
        ? baselineHarnessCatalogue.reviewedResources
        : reviewedCommandResources,
    orchestrationPolicy: baselineHarnessCatalogue.orchestrationPolicy,
    contextSelectionPolicy: baselineHarnessCatalogue.contextSelectionPolicy,
    toolCatalogue: baselineHarnessCatalogue.toolCatalogue,
    completionCommands: input.completionCommands,
    toolCommands: input.toolCommands,
    modelCompatibility: input.modelCompatibility,
    environmentCompatibility: input.environmentCompatibility,
    capabilities: input.capabilities,
    budgetCeilings: input.budgetCeilings,
    policies: baselineHarnessCatalogue.policies,
  };
}

export function prepareBaselineHarnessRevision(
  input: BaselineHarnessPreparationInput,
): BaselineHarnessPreparation {
  const derived = deriveBaselineHarness(derivationInput(input));
  if (derived.kind === 'Rejected') {
    return derived;
  }
  try {
    const candidate = rebuildRevision(derived.manifest, '');
    const saidified: unknown = Saider.saidify(candidate)[1];
    if (!Value.Check(baselineHarnessRevisionSchema, saidified)) {
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    }
    return { kind: 'Prepared', revision: saidified };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

function referencesEqual(
  left: HarnessComponentReference,
  right: HarnessComponentReference,
): boolean {
  return (
    left.identity === right.identity &&
    left.version === right.version &&
    left.contentSaid === right.contentSaid
  );
}

function catalogueMatches(revision: BaselineHarnessRevision): boolean {
  if (
    !referencesEqual(revision.template, baselineHarnessCatalogue.template) ||
    !referencesEqual(revision.orchestrationPolicy, baselineHarnessCatalogue.orchestrationPolicy) ||
    !referencesEqual(
      revision.contextSelectionPolicy,
      baselineHarnessCatalogue.contextSelectionPolicy,
    )
  ) {
    return false;
  }
  const expectedReviewed =
    revision.toolCommands === undefined
      ? baselineHarnessCatalogue.reviewedResources
      : reviewedCommandResources;
  if (
    revision.reviewedResources.length !== expectedReviewed.length ||
    revision.reviewedResources.some(
      (resource, index) =>
        resource.kind !== expectedReviewed[index]?.kind ||
        !referencesEqual(resource, expectedReviewed[index] ?? resource),
    )
  ) {
    return false;
  }
  return (
    referencesEqual(revision.policies.derivation, baselineHarnessCatalogue.policies.derivation) &&
    referencesEqual(revision.policies.redaction, baselineHarnessCatalogue.policies.redaction) &&
    referencesEqual(revision.policies.toolGateway, baselineHarnessCatalogue.policies.toolGateway) &&
    referencesEqual(revision.policies.evidence, baselineHarnessCatalogue.policies.evidence) &&
    referencesEqual(revision.policies.verifier, baselineHarnessCatalogue.policies.verifier)
  );
}

function completionCommandSaidMatches(command: HarnessCommand): boolean {
  try {
    return new Saider({ qb64: command.contentSaid }).verify(
      {
        version: 1,
        d: command.contentSaid,
        kind: 'CompletionCommand',
        identity: command.identity,
        executableRealpath: command.executableRealpath,
        argv: [...command.argv],
        timeoutSeconds: command.timeoutSeconds,
        expectedExitCode: command.expectedExitCode,
      },
      true,
      false,
    );
  } catch {
    return false;
  }
}

function toolCommandSaidMatches(command: HarnessToolCommand): boolean {
  try {
    return new Saider({ qb64: command.contentSaid }).verify(
      toolCommandDocument(command, command.contentSaid),
      true,
      false,
    );
  } catch {
    return false;
  }
}

function decodedDerivationInput(revision: BaselineHarnessRevision): BaselineHarnessDerivationInput {
  return {
    template: revision.template,
    task: revision.task,
    authority: revision.authority,
    repository: revision.repository,
    reviewedResources: revision.reviewedResources,
    orchestrationPolicy: revision.orchestrationPolicy,
    contextSelectionPolicy: revision.contextSelectionPolicy,
    toolCatalogue: baselineHarnessCatalogue.toolCatalogue,
    completionCommands: revision.completionCommands,
    toolCommands: revision.toolCommands ?? [],
    modelCompatibility: revision.modelCompatibility,
    environmentCompatibility: revision.environmentCompatibility,
    capabilities: revision.capabilities,
    budgetCeilings: revision.budgetCeilings,
    policies: revision.policies,
  };
}

export function decodeBaselineHarnessRevision(input: unknown): BaselineHarnessRevisionDecoding {
  if (!Value.Check(baselineHarnessRevisionSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!catalogueMatches(input)) {
    return { kind: 'Rejected', reason: 'CatalogueMismatch' };
  }
  if (!input.completionCommands.every(completionCommandSaidMatches)) {
    return { kind: 'Rejected', reason: 'CompletionCommandSaidMismatch' };
  }
  if (!(input.toolCommands ?? []).every(toolCommandSaidMatches)) {
    return { kind: 'Rejected', reason: 'ToolCommandSaidMismatch' };
  }
  const derived = deriveBaselineHarness(decodedDerivationInput(input));
  if (derived.kind === 'Rejected') {
    return { kind: 'Rejected', reason: derived.reason };
  }
  const canonical = rebuildRevision(derived.manifest, input.d);
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
