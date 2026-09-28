import {
  taskBudgetCeilings,
  type TaskBudgets,
  type TaskToolCapability,
} from '../task/authority.js';

const eightRunQuotaServerCeilings: Readonly<TaskBudgets> = Object.freeze({
  ...taskBudgetCeilings,
  runsPerAdmittedUser: 8,
});

const nineRunQuotaServerCeilings: Readonly<TaskBudgets> = Object.freeze({
  ...taskBudgetCeilings,
  runsPerAdmittedUser: 9,
});

const tenRunQuotaServerCeilings: Readonly<TaskBudgets> = Object.freeze({
  ...taskBudgetCeilings,
  runsPerAdmittedUser: 10,
});

const recoveryQuotaServerCeilings: Readonly<TaskBudgets> = Object.freeze({
  ...taskBudgetCeilings,
  tasksPerAdmittedUser: 5,
  runsPerAdmittedUser: 10,
});

/** Preserve signed old H1 ceilings; a fresh v2 Task must explicitly request the added Run slots. */
export function baselineHarnessServerBudgetCeilings(task: {
  readonly version: 1 | 2;
  readonly budgets: Pick<TaskBudgets, 'runsPerAdmittedUser'> &
    Partial<Pick<TaskBudgets, 'tasksPerAdmittedUser'>>;
}): Readonly<TaskBudgets> {
  return task.version === 2 &&
    task.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser
    ? task.budgets.runsPerAdmittedUser > 9
      ? task.budgets.tasksPerAdmittedUser === 5
        ? recoveryQuotaServerCeilings
        : tenRunQuotaServerCeilings
      : task.budgets.runsPerAdmittedUser > 8
        ? nineRunQuotaServerCeilings
        : eightRunQuotaServerCeilings
    : taskBudgetCeilings;
}

export interface HarnessComponentReference {
  readonly identity: string;
  readonly version: number;
  readonly contentSaid: string;
}

export interface ReviewedHarnessResource extends HarnessComponentReference {
  readonly kind: 'Workflow' | 'Skill';
}

export interface HarnessToolDefinition extends HarnessComponentReference {
  readonly requiredCapability: TaskToolCapability;
}

export interface HarnessInstructionResource {
  readonly path: string;
  readonly contentSaid: string;
}

export interface HarnessCommand {
  readonly identity: string;
  readonly contentSaid: string;
  readonly executableRealpath: string;
  readonly argv: readonly string[];
  readonly timeoutSeconds: number;
  readonly expectedExitCode: number;
}

export interface HarnessToolCommand extends HarnessCommand {
  readonly capability: 'RunFormatter' | 'RunStaticAnalysis';
}

export interface HarnessModelCompatibility {
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly credentialSource: string;
  readonly toolCalls: 'Supported' | 'Unsupported';
  readonly usageAccounting: 'Required' | 'Unsupported';
}

export interface HarnessEnvironmentCompatibility {
  readonly operatingSystem: 'darwin' | 'linux';
  readonly architecture: 'arm64' | 'x64';
  readonly nodeVersion: string;
  readonly gitVersion: string;
  readonly piSdkVersion: string;
  readonly xstateVersion: string;
}

export interface BaselineHarnessDerivationInput {
  readonly template: HarnessComponentReference;
  readonly task: {
    readonly taskId: string;
    readonly revisionSaid: string;
    readonly harnessLineageId: string;
    readonly requestedCapabilities: readonly TaskToolCapability[];
  };
  readonly authority: {
    readonly personalAgentAid: string;
    readonly taskMandateSaid: string;
    readonly allowedCapabilities: readonly TaskToolCapability[];
  };
  readonly repository: {
    readonly objectFormat: 'sha1' | 'sha256';
    readonly commit: string;
    readonly tree: string;
    readonly instructionResources: readonly HarnessInstructionResource[];
  };
  readonly reviewedResources: readonly ReviewedHarnessResource[];
  readonly orchestrationPolicy: HarnessComponentReference;
  readonly contextSelectionPolicy: HarnessComponentReference;
  readonly toolCatalogue: readonly HarnessToolDefinition[];
  readonly completionCommands: readonly HarnessCommand[];
  readonly toolCommands: readonly HarnessToolCommand[];
  readonly modelCompatibility: HarnessModelCompatibility;
  readonly environmentCompatibility: HarnessEnvironmentCompatibility;
  readonly capabilities: {
    readonly available: readonly TaskToolCapability[];
    readonly unavailable: readonly TaskToolCapability[];
  };
  readonly budgetCeilings: {
    readonly task: TaskBudgets;
    readonly server: TaskBudgets;
    readonly mandate: TaskBudgets;
  };
  readonly policies: {
    readonly derivation: HarnessComponentReference;
    readonly redaction: HarnessComponentReference;
    readonly toolGateway: HarnessComponentReference;
    readonly evidence: HarnessComponentReference;
    readonly verifier: HarnessComponentReference;
  };
}

export interface BaselineHarnessManifest {
  readonly version: 1;
  readonly kind: 'InitialSpecialization';
  readonly template: HarnessComponentReference;
  readonly task: BaselineHarnessDerivationInput['task'];
  readonly authority: BaselineHarnessDerivationInput['authority'];
  readonly repository: BaselineHarnessDerivationInput['repository'];
  readonly reviewedResources: readonly ReviewedHarnessResource[];
  readonly orchestrationPolicy: HarnessComponentReference;
  readonly contextSelectionPolicy: HarnessComponentReference;
  readonly activeTools: readonly HarnessToolDefinition[];
  readonly completionCommands: readonly HarnessCommand[];
  readonly toolCommands: readonly HarnessToolCommand[];
  readonly modelCompatibility: HarnessModelCompatibility;
  readonly environmentCompatibility: HarnessEnvironmentCompatibility;
  readonly capabilities: BaselineHarnessDerivationInput['capabilities'];
  readonly budgetCeilings: BaselineHarnessDerivationInput['budgetCeilings'];
  readonly policies: BaselineHarnessDerivationInput['policies'];
}

export type BaselineHarnessDerivation =
  | { readonly kind: 'Derived'; readonly manifest: BaselineHarnessManifest }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'DuplicateInstructionPath'
        | 'DuplicateReviewedResource'
        | 'DuplicateToolIdentity'
        | 'DuplicateCompletionCommand'
        | 'DuplicateToolCommand'
        | 'DerivationLawUnsupported'
        | 'ModelCompatibilityRejected';
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'CapabilityAvailabilityConflict'
        | 'RequestedCapabilityUnavailable'
        | 'RequestedCapabilityUnauthorized'
        | 'RequestedCapabilityUnsupported'
        | 'MissingToolCommand'
        | 'ToolCommandCapabilityMismatch';
      readonly capability: TaskToolCapability;
    };

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

function sorted<Value extends string>(values: readonly Value[]): Value[] {
  return [...values].sort(compareUtf8);
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

function component(reference: HarnessComponentReference): HarnessComponentReference {
  return {
    identity: reference.identity,
    version: reference.version,
    contentSaid: reference.contentSaid,
  };
}

function budgets(budget: TaskBudgets): TaskBudgets {
  return { ...budget };
}

export function deriveBaselineHarness(
  input: BaselineHarnessDerivationInput,
): BaselineHarnessDerivation {
  if (firstDuplicate(input.repository.instructionResources.map(({ path }) => path)) !== undefined) {
    return { kind: 'Rejected', reason: 'DuplicateInstructionPath' };
  }
  if (
    firstDuplicate(input.reviewedResources.map(({ kind, identity }) => `${kind}:${identity}`)) !==
    undefined
  ) {
    return { kind: 'Rejected', reason: 'DuplicateReviewedResource' };
  }
  if (firstDuplicate(input.toolCatalogue.map(({ identity }) => identity)) !== undefined) {
    return { kind: 'Rejected', reason: 'DuplicateToolIdentity' };
  }
  if (firstDuplicate(input.completionCommands.map(({ identity }) => identity)) !== undefined) {
    return { kind: 'Rejected', reason: 'DuplicateCompletionCommand' };
  }
  const commandIds = new Set(input.completionCommands.map(({ identity }) => identity));
  for (const command of input.toolCommands) {
    if (commandIds.has(command.identity))
      return { kind: 'Rejected', reason: 'DuplicateToolCommand' };
    commandIds.add(command.identity);
    if (!input.task.requestedCapabilities.includes(command.capability)) {
      return {
        kind: 'Rejected',
        reason: 'ToolCommandCapabilityMismatch',
        capability: command.capability,
      };
    }
  }

  const available = new Set(input.capabilities.available);
  const unavailable = new Set(input.capabilities.unavailable);
  for (const capability of available) {
    if (unavailable.has(capability)) {
      return { kind: 'Rejected', reason: 'CapabilityAvailabilityConflict', capability };
    }
  }

  const authorized = new Set(input.authority.allowedCapabilities);
  const supported = new Set(
    input.toolCatalogue.map(({ requiredCapability }) => requiredCapability),
  );
  const requestedCapabilities = sorted(input.task.requestedCapabilities);
  for (const capability of requestedCapabilities) {
    if (!available.has(capability) || unavailable.has(capability)) {
      return { kind: 'Rejected', reason: 'RequestedCapabilityUnavailable', capability };
    }
    if (!authorized.has(capability)) {
      return { kind: 'Rejected', reason: 'RequestedCapabilityUnauthorized', capability };
    }
    if (!supported.has(capability)) {
      return { kind: 'Rejected', reason: 'RequestedCapabilityUnsupported', capability };
    }
    if (
      (capability === 'RunFormatter' || capability === 'RunStaticAnalysis') &&
      !input.toolCommands.some((command) => command.capability === capability)
    ) {
      return { kind: 'Rejected', reason: 'MissingToolCommand', capability };
    }
  }
  if (
    input.policies.derivation.identity !== 'h1-derivation' ||
    input.policies.derivation.version !== 1
  ) {
    return { kind: 'Rejected', reason: 'DerivationLawUnsupported' };
  }
  if (
    input.modelCompatibility.toolCalls !== 'Supported' ||
    input.modelCompatibility.usageAccounting !== 'Required'
  ) {
    return { kind: 'Rejected', reason: 'ModelCompatibilityRejected' };
  }

  const activeTools = input.toolCatalogue
    .filter(({ requiredCapability }) => requestedCapabilities.includes(requiredCapability))
    .sort((left, right) => compareUtf8(left.identity, right.identity))
    .map((tool) => ({
      identity: tool.identity,
      version: tool.version,
      contentSaid: tool.contentSaid,
      requiredCapability: tool.requiredCapability,
    }));

  return {
    kind: 'Derived',
    manifest: {
      version: 1,
      kind: 'InitialSpecialization',
      template: component(input.template),
      task: {
        taskId: input.task.taskId,
        revisionSaid: input.task.revisionSaid,
        harnessLineageId: input.task.harnessLineageId,
        requestedCapabilities,
      },
      authority: {
        personalAgentAid: input.authority.personalAgentAid,
        taskMandateSaid: input.authority.taskMandateSaid,
        allowedCapabilities: sorted(input.authority.allowedCapabilities),
      },
      repository: {
        objectFormat: input.repository.objectFormat,
        commit: input.repository.commit,
        tree: input.repository.tree,
        instructionResources: [...input.repository.instructionResources]
          .sort((left, right) => compareUtf8(left.path, right.path))
          .map((resource) => ({ path: resource.path, contentSaid: resource.contentSaid })),
      },
      reviewedResources: input.reviewedResources.map((resource) => ({
        kind: resource.kind,
        identity: resource.identity,
        version: resource.version,
        contentSaid: resource.contentSaid,
      })),
      orchestrationPolicy: component(input.orchestrationPolicy),
      contextSelectionPolicy: component(input.contextSelectionPolicy),
      activeTools,
      completionCommands: input.completionCommands.map((command) => ({
        identity: command.identity,
        contentSaid: command.contentSaid,
        executableRealpath: command.executableRealpath,
        argv: [...command.argv],
        timeoutSeconds: command.timeoutSeconds,
        expectedExitCode: command.expectedExitCode,
      })),
      toolCommands: input.toolCommands.map((command) => ({
        capability: command.capability,
        identity: command.identity,
        contentSaid: command.contentSaid,
        executableRealpath: command.executableRealpath,
        argv: [...command.argv],
        timeoutSeconds: command.timeoutSeconds,
        expectedExitCode: command.expectedExitCode,
      })),
      modelCompatibility: { ...input.modelCompatibility },
      environmentCompatibility: { ...input.environmentCompatibility },
      capabilities: {
        available: sorted(input.capabilities.available),
        unavailable: sorted(input.capabilities.unavailable),
      },
      budgetCeilings: {
        task: budgets(input.budgetCeilings.task),
        server: budgets(input.budgetCeilings.server),
        mandate: budgets(input.budgetCeilings.mandate),
      },
      policies: {
        derivation: component(input.policies.derivation),
        redaction: component(input.policies.redaction),
        toolGateway: component(input.policies.toolGateway),
        evidence: component(input.policies.evidence),
        verifier: component(input.policies.verifier),
      },
    },
  };
}
