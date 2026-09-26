import type { RunWorkAccessRenewal } from '../../work-access/application/run-work-access.js';
import type {
  AdmittedUser,
  ProtectedCredentials,
  PromotionEvidenceClass,
  RunPurpose,
  TaskBudgets,
  TaskEvolutionClass,
  TaskToolCapability,
} from '@devrandom/domain';
import type {
  LocalEvidenceSealExchange,
  LocalMandateCustody,
  PersonalAgentAid,
} from '@devrandom/identity';
import type { TaskProjection } from '@devrandom/protocol';

import type {
  BaselineHarnessAuthority,
  BaselineHarnessPreparation,
  BaselineHarnessPreparationOutcome,
  HostedBaselineHarnesses,
} from '../../harness/application/baseline-harness-preparation.js';
import type { HostedMandatePresentations } from '../../mandate/application/hosted-mandate-presentations.js';
import type {
  BaselineRunAdmission,
  BaselineRunAdmissionOutcome,
  HostedRuns,
  PersonalAgentRunAuthority,
} from '../../run/application/baseline-run-admission.js';
import type { TaskMandateAuthorizationOutcome } from '../../mandate/application/task-mandate-authorization.js';
import type { HostedTaskFailure, HostedTasks, TaskAuthorityAcquisition } from './user-tasks.js';

export interface MandateAdmissionSummary {
  readonly credentialSaid: string;
  readonly holderGrantSaid: string;
  readonly holderAdmissionSaid: string;
  readonly serverGrantSaid: string;
  readonly expiresAt: string;
  readonly admittedAt: string;
}

export interface TaskMandateSummary {
  readonly personalAgent: {
    readonly aid: string;
    readonly origin: 'principal-provisioned' | 'existing-principal-verified';
  };
  readonly governor: {
    readonly aid: string;
    readonly origin: 'principal-provisioned' | 'existing-principal-verified';
  };
  readonly mandateRegistryId: string;
  readonly taskMandate: MandateAdmissionSummary & {
    readonly allowedCapabilities: readonly TaskToolCapability[];
    readonly budgets: TaskBudgets;
    readonly allowedEvolutionClasses: readonly TaskEvolutionClass[];
  };
  readonly promotionMandate: MandateAdmissionSummary & {
    readonly capabilityCeiling: readonly TaskToolCapability[];
    readonly budgetCeiling: TaskBudgets;
    readonly evolutionClassCeiling: readonly TaskEvolutionClass[];
    readonly requiredEvidenceClasses: readonly PromotionEvidenceClass[];
  };
}

type TaskAuthorityFailure = Exclude<TaskAuthorityAcquisition, { readonly kind: 'Authorized' }>;

export type TaskRunWorkAcquisition =
  | {
      readonly kind: 'Authorized';
      readonly user: AdmittedUser;
      readonly tasks: HostedTasks;
      readonly presentations: HostedMandatePresentations;
      readonly harnesses: HostedBaselineHarnesses;
      readonly runs: HostedRuns;
      readonly protectedCredentials: ProtectedCredentials;
      readonly grantExpiresAt: string;
      readonly workAccessRenewal: RunWorkAccessRenewal;
    }
  | TaskAuthorityFailure;

export interface TaskRunWorkAuthority {
  acquireHostedWork(): Promise<TaskRunWorkAcquisition>;
}

export interface LocalTaskMandateInput {
  readonly user: AdmittedUser;
  readonly task: TaskProjection;
  readonly presentations: HostedMandatePresentations;
  readonly grantExpiresAt: string;
}

export type LocalTaskMandatePreparation =
  | {
      readonly kind: 'Prepared';
      readonly summary: TaskMandateSummary;
      readonly harnessAuthority: BaselineHarnessAuthority;
      readonly runAuthority: PersonalAgentRunAuthority;
      readonly executionAuthority: {
        readonly personalAgentAid: PersonalAgentAid;
        readonly taskMandateCustody: Pick<LocalMandateCustody, 'inspectCredential'>;
        readonly evidenceSealExchange: LocalEvidenceSealExchange;
      };
    }
  | { readonly kind: 'CustodyUnavailable' }
  | {
      readonly kind: 'GovernanceRejected';
      readonly reason: 'UserCustodyChanged' | 'ManagedPrincipalChanged' | 'MandateRegistryChanged';
    }
  | {
      readonly kind: 'AuthorizationRejected';
      readonly outcome: Exclude<TaskMandateAuthorizationOutcome, { readonly kind: 'Ready' }>;
    };

export interface LocalTaskMandates {
  prepare(input: LocalTaskMandateInput): Promise<LocalTaskMandatePreparation>;
}

export type TaskRunPreparationOutcome =
  | {
      readonly kind: 'RunLeaseAcquired';
      readonly task: TaskProjection;
      readonly mandates: TaskMandateSummary;
      readonly harness: Extract<
        BaselineHarnessPreparationOutcome,
        { readonly kind: 'HarnessAdmitted' }
      >;
      readonly run: Extract<BaselineRunAdmissionOutcome, { readonly kind: 'RunLeaseAcquired' }>;
      readonly protectedCredentials: ProtectedCredentials;
      readonly workAccessRenewal: RunWorkAccessRenewal;
      readonly executionAuthority: Extract<
        LocalTaskMandatePreparation,
        { readonly kind: 'Prepared' }
      >['executionAuthority'];
    }
  | TaskAuthorityFailure
  | { readonly kind: 'TaskInspectionRejected'; readonly failure: HostedTaskFailure }
  | Exclude<LocalTaskMandatePreparation, { readonly kind: 'Prepared' }>
  | Exclude<BaselineHarnessPreparationOutcome, { readonly kind: 'HarnessAdmitted' }>
  | Exclude<BaselineRunAdmissionOutcome, { readonly kind: 'RunLeaseAcquired' }>;

export interface TaskRunPreparationDependencies {
  readonly authority: TaskRunWorkAuthority;
  readonly localMandates: LocalTaskMandates;
  readonly localHarness: Pick<BaselineHarnessPreparation, 'prepare'>;
  readonly localRun: Pick<BaselineRunAdmission, 'admit'>;
}

export class TaskRunPreparation {
  readonly #dependencies: TaskRunPreparationDependencies;

  constructor(dependencies: TaskRunPreparationDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(label: string, purpose: RunPurpose): Promise<TaskRunPreparationOutcome> {
    const authority = await this.#dependencies.authority.acquireHostedWork();
    if (authority.kind !== 'Authorized') {
      return authority;
    }
    const inspection = await authority.tasks.inspect(label);
    if (inspection.kind !== 'Inspected') {
      return { kind: 'TaskInspectionRejected', failure: inspection };
    }
    const preparation = await this.#dependencies.localMandates.prepare({
      user: authority.user,
      task: inspection.task,
      presentations: authority.presentations,
      grantExpiresAt: authority.grantExpiresAt,
    });
    if (preparation.kind !== 'Prepared') {
      return preparation;
    }
    const harness = await this.#dependencies.localHarness.prepare({
      protectedCredentials: authority.protectedCredentials,
      task: inspection.task,
      authority: preparation.harnessAuthority,
      hosted: authority.harnesses,
    });
    if (harness.kind !== 'HarnessAdmitted') {
      return harness;
    }
    const run = await this.#dependencies.localRun.admit({
      task: inspection.task,
      harness: harness.projection,
      personalAgentAid: preparation.runAuthority.personalAgentAid,
      governorAid: preparation.runAuthority.governorAid,
      promotionMandateSaid: preparation.summary.promotionMandate.credentialSaid,
      purpose,
      requestedBudget: harness.projection.revision.budgetCeilings.task,
      exchange: preparation.runAuthority.exchange,
      hosted: authority.runs,
    });
    return run.kind === 'RunLeaseAcquired'
      ? {
          kind: 'RunLeaseAcquired',
          task: inspection.task,
          mandates: preparation.summary,
          harness,
          run,
          protectedCredentials: authority.protectedCredentials,
          workAccessRenewal: authority.workAccessRenewal,
          executionAuthority: preparation.executionAuthority,
        }
      : run;
  }
}
