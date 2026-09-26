import type {
  HarnessEnvironmentCompatibility,
  HarnessCommand,
  HarnessToolCommand,
  HarnessInstructionResource,
  HarnessModelCompatibility,
  TaskBudgets,
  TaskToolCapability,
  ProtectedCredentials,
} from '@devrandom/domain';
import type { PiCredentialSource, PiCredentialAcquisition } from '@devrandom/runtime';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessToolCommand,
  prepareBaselineHarnessRevision,
  taskBudgetCeilings,
  type AdmitBaselineHarnessBody,
  type BaselineHarnessProjection,
  type HarnessProblem,
  type TaskProjection,
} from '@devrandom/protocol';

const requestRetryLimit = 3;
const retryIntervalMilliseconds = 1_000;

export type BaselineHarnessInspectionOutcome =
  | {
      readonly kind: 'Inspected';
      readonly snapshot: {
        readonly repository: TaskProjection['revision']['repository'] & {
          readonly instructionResources: readonly HarnessInstructionResource[];
        };
        readonly commandExecutables: readonly {
          readonly commandId: string;
          readonly executableRealpath: string;
        }[];
        readonly environmentCompatibility: HarnessEnvironmentCompatibility;
      };
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'RepositoryUnavailable'
        | 'WorktreeDirty'
        | 'RepositoryBindingChanged'
        | 'InstructionInventoryTooLarge'
        | 'InstructionInvalid'
        | 'SecretDetected'
        | 'CommandExecutableUnavailable'
        | 'EnvironmentUnsupported';
    };

export interface BaselineHarnessInspection {
  inspect(
    task: TaskProjection,
    protectedCredentials: ProtectedCredentials,
  ): Promise<BaselineHarnessInspectionOutcome>;
}

export type BaselineHarnessModelInspectionOutcome =
  | { readonly kind: 'Compatible'; readonly compatibility: HarnessModelCompatibility }
  | {
      readonly kind:
        | 'ModelConfigurationRequired'
        | 'ProviderUnknown'
        | 'ModelUnknown'
        | 'TextInputUnsupported'
        | 'ThinkingLevelUnsupported'
        | 'MaximumOutputTokensUnsupported'
        | 'ToolProtocolUnsupported'
        | 'UsageAccountingUnsupported'
        | 'InvalidModelMetadata'
        | 'PiCatalogueUnavailable';
    };

export interface BaselineHarnessModelInspection {
  inspect(): Promise<BaselineHarnessModelInspectionOutcome>;
}

export interface BaselineHarnessAdmissionBinding {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessSaid: string;
}

export type BaselineHarnessAdmissionAcquisition =
  | { readonly kind: 'Acquired'; readonly commandId: string }
  | { readonly kind: 'BindingConflict' }
  | { readonly kind: 'Unavailable' };

export type BaselineHarnessAdmissionAcknowledgement =
  | { readonly kind: 'Acknowledged' }
  | { readonly kind: 'BindingConflict' }
  | { readonly kind: 'Unavailable' };

export interface BaselineHarnessAdmissions {
  acquire(binding: BaselineHarnessAdmissionBinding): Promise<BaselineHarnessAdmissionAcquisition>;
  acknowledge(
    binding: BaselineHarnessAdmissionBinding,
    projection: BaselineHarnessProjection,
  ): Promise<BaselineHarnessAdmissionAcknowledgement>;
}

export type HostedBaselineHarnessAdmission =
  | { readonly kind: 'Created'; readonly projection: BaselineHarnessProjection }
  | { readonly kind: 'Reconciled'; readonly projection: BaselineHarnessProjection }
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: HarnessProblem };

export interface HostedBaselineHarnesses {
  admit(command: AdmitBaselineHarnessBody): Promise<HostedBaselineHarnessAdmission>;
}

export interface BaselineHarnessAuthority {
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly allowedCapabilities: readonly TaskToolCapability[];
  readonly mandateBudgets: TaskBudgets;
}

export interface BaselineHarnessPreparationInput {
  readonly protectedCredentials: ProtectedCredentials;
  readonly task: TaskProjection;
  readonly authority: BaselineHarnessAuthority;
  readonly hosted: HostedBaselineHarnesses;
}

export type BaselineHarnessPreparationOutcome =
  | { readonly kind: 'ModelCredentialUnavailable' }
  | {
      readonly kind: 'HarnessAdmitted';
      readonly admission: 'Created' | 'Reconciled';
      readonly projection: BaselineHarnessProjection;
    }
  | {
      readonly kind: 'RepositoryInspectionRejected';
      readonly reason: Extract<
        BaselineHarnessInspectionOutcome,
        { readonly kind: 'Rejected' }
      >['reason'];
    }
  | {
      readonly kind: 'ModelInspectionRejected';
      readonly reason: Exclude<
        BaselineHarnessModelInspectionOutcome,
        { readonly kind: 'Compatible' }
      >['kind'];
    }
  | {
      readonly kind: 'HarnessPreparationRejected';
      readonly reason:
        | 'SchemaInvalid'
        | 'SaidConstructionFailed'
        | 'DuplicateInstructionPath'
        | 'DuplicateReviewedResource'
        | 'DuplicateToolIdentity'
        | 'DuplicateCompletionCommand'
        | 'DuplicateToolCommand'
        | 'MissingToolCommand'
        | 'ToolCommandCapabilityMismatch'
        | 'DerivationLawUnsupported'
        | 'ModelCompatibilityRejected'
        | 'CapabilityAvailabilityConflict'
        | 'RequestedCapabilityUnavailable'
        | 'RequestedCapabilityUnauthorized'
        | 'RequestedCapabilityUnsupported';
    }
  | { readonly kind: 'HarnessAdmissionBindingConflict' }
  | { readonly kind: 'HarnessAdmissionStateUnavailable' }
  | { readonly kind: 'HarnessAdmissionRejected'; readonly outcome: HostedBaselineHarnessAdmission };

export interface BaselineHarnessPreparationDependencies {
  readonly availableCapabilities: readonly TaskToolCapability[];
  readonly repository: BaselineHarnessInspection;
  readonly model: BaselineHarnessModelInspection;
  readonly modelCredential: PiCredentialSource;
  readonly admissions: BaselineHarnessAdmissions;
  wait(milliseconds: number): Promise<void>;
}

export class BaselineHarnessPreparation {
  readonly #dependencies: BaselineHarnessPreparationDependencies;

  constructor(dependencies: BaselineHarnessPreparationDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(
    input: BaselineHarnessPreparationInput,
  ): Promise<BaselineHarnessPreparationOutcome> {
    const model = await this.#dependencies.model.inspect();
    if (model.kind !== 'Compatible') {
      return { kind: 'ModelInspectionRejected', reason: model.kind };
    }
    let credential: PiCredentialAcquisition;
    try {
      credential = await this.#dependencies.modelCredential.acquire(model.compatibility);
    } catch {
      return { kind: 'ModelCredentialUnavailable' };
    }
    if (credential.kind !== 'Available') return { kind: 'ModelCredentialUnavailable' };
    input.protectedCredentials.protect(credential.secret);
    const inspection = await this.#dependencies.repository.inspect(
      input.task,
      input.protectedCredentials,
    );
    if (inspection.kind === 'Rejected') {
      return { kind: 'RepositoryInspectionRejected', reason: inspection.reason };
    }
    const completionCommands: HarnessCommand[] = [];
    for (const condition of input.task.revision.completionConditions) {
      const executable = inspection.snapshot.commandExecutables.find(
        ({ commandId }) => commandId === condition.id,
      );
      if (executable === undefined) {
        return { kind: 'HarnessPreparationRejected', reason: 'SchemaInvalid' };
      }
      const identified = identifyHarnessCompletionCommand(condition, executable.executableRealpath);
      if (identified.kind !== 'Identified') {
        return { kind: 'HarnessPreparationRejected', reason: identified.reason };
      }
      completionCommands.push(identified.command);
    }
    const toolCommands: HarnessToolCommand[] = [];
    for (const declaration of input.task.revision.toolCommands ?? []) {
      const executable = inspection.snapshot.commandExecutables.find(
        ({ commandId }) => commandId === declaration.id,
      );
      if (executable === undefined) {
        return { kind: 'HarnessPreparationRejected', reason: 'SchemaInvalid' };
      }
      const identified = identifyHarnessToolCommand(declaration, executable.executableRealpath);
      if (identified.kind !== 'Identified') {
        return { kind: 'HarnessPreparationRejected', reason: identified.reason };
      }
      toolCommands.push(identified.command);
    }
    const prepared = prepareBaselineHarnessRevision({
      toolCommands,
      task: {
        taskId: input.task.taskId,
        revisionSaid: input.task.revisionSaid,
        harnessLineageId: input.task.harnessLineageId,
        requestedCapabilities: input.task.revision.requestedCapabilities,
      },
      authority: {
        personalAgentAid: input.authority.personalAgentAid,
        taskMandateSaid: input.authority.taskMandateSaid,
        allowedCapabilities: input.authority.allowedCapabilities,
      },
      repository: inspection.snapshot.repository,
      completionCommands,
      modelCompatibility: model.compatibility,
      environmentCompatibility: inspection.snapshot.environmentCompatibility,
      capabilities: {
        available: input.task.revision.requestedCapabilities.filter((capability) =>
          this.#dependencies.availableCapabilities.includes(capability),
        ),
        unavailable: input.task.revision.unavailableCapabilities,
      },
      budgetCeilings: {
        task: input.task.revision.budgets,
        server: taskBudgetCeilings,
        mandate: input.authority.mandateBudgets,
      },
    });
    if (prepared.kind !== 'Prepared') {
      return { kind: 'HarnessPreparationRejected', reason: prepared.reason };
    }
    const binding = {
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessSaid: prepared.revision.d,
    };
    const acquisition = await this.#dependencies.admissions.acquire(binding);
    if (acquisition.kind === 'BindingConflict') {
      return { kind: 'HarnessAdmissionBindingConflict' };
    }
    if (acquisition.kind === 'Unavailable') {
      return { kind: 'HarnessAdmissionStateUnavailable' };
    }
    const hosted = await retryAdmission(
      () =>
        input.hosted.admit({
          version: 1,
          commandId: acquisition.commandId,
          revision: prepared.revision,
        }),
      (milliseconds) => this.#dependencies.wait(milliseconds),
    );
    if (hosted.kind !== 'Created' && hosted.kind !== 'Reconciled') {
      return { kind: 'HarnessAdmissionRejected', outcome: hosted };
    }
    if (
      hosted.projection.ownerAid !== input.task.ownerAid ||
      hosted.projection.commandId !== acquisition.commandId ||
      hosted.projection.revision.d !== prepared.revision.d
    ) {
      return { kind: 'HarnessAdmissionRejected', outcome: { kind: 'ResponseInvalid' } };
    }
    const acknowledgement = await this.#dependencies.admissions.acknowledge(
      binding,
      hosted.projection,
    );
    if (acknowledgement.kind === 'BindingConflict') {
      return { kind: 'HarnessAdmissionBindingConflict' };
    }
    if (acknowledgement.kind === 'Unavailable') {
      return { kind: 'HarnessAdmissionStateUnavailable' };
    }
    return {
      kind: 'HarnessAdmitted',
      admission: hosted.kind,
      projection: hosted.projection,
    };
  }
}

async function retryAdmission(
  request: () => Promise<HostedBaselineHarnessAdmission>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<HostedBaselineHarnessAdmission> {
  let outcome = await request();
  for (
    let requestCount = 1;
    requestCount < requestRetryLimit && outcome.kind === 'ServerUnavailable';
    requestCount += 1
  ) {
    await wait(retryIntervalMilliseconds);
    outcome = await request();
  }
  return outcome;
}
