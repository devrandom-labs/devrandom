import { isDeepStrictEqual } from 'node:util';

import {
  acquireFirstRunLease,
  effectiveRunBudget,
  runLeasePolicy,
  taskBudgetNames,
  type Run,
  type RunPurpose,
  type CalibrationRejectionReason,
} from '@devrandom/domain';
import { decodeRunProjection } from '@devrandom/protocol';
import type { RunLeaseReceipt, RunSupervision } from '@devrandom/runtime';

import type { BaselineRunBinding } from '../../run/application/baseline-run-admission.js';
import type { CalibrationCampaignProgressReading } from '../../run/application/calibration-campaign-progress.js';

import type { TaskRunPreparation, TaskRunPreparationOutcome } from './task-run-preparation.js';

export type AdmittedTaskRunPreparation = Extract<
  TaskRunPreparationOutcome,
  { readonly kind: 'RunLeaseAcquired' }
>;

type TaskRunPreparationFailure = Exclude<
  TaskRunPreparationOutcome,
  { readonly kind: 'RunLeaseAcquired' }
>;

export type AdmittedRunBindingRejection =
  | 'RunProjectionRejected'
  | 'PreparationBindingMismatch'
  | 'LeaseRunMismatch'
  | 'LeaseVersionMismatch'
  | 'LeaseIncarnationMismatch'
  | 'LeaseTimeMismatch'
  | 'LeaseTransitionRejected';

export interface AdmittedRunSupervision {
  supervise(
    run: Run,
    lease: RunLeaseReceipt,
    signal: AbortSignal,
    leaseRequestStartedAt: number,
  ): Promise<RunSupervision>;
}

export interface AdmittedRunSupervisionProvision {
  provision(preparation: AdmittedTaskRunPreparation): AdmittedRunSupervision;
}

export type TaskRunExecutionOutcome =
  | {
      readonly kind: 'CalibrationRecoveryRequired';
      readonly runId: string;
      readonly ordinal: 1 | 2 | 3 | 4 | 5;
    }
  | {
      readonly kind: 'CalibrationCampaignClosed';
      readonly runId: string;
      readonly ordinal: 1 | 2 | 3 | 4 | 5;
      readonly reason: CalibrationRejectionReason;
    }
  | { readonly kind: 'RetainedRunAlreadyAdmitted'; readonly runId: string }
  | TaskRunPreparationFailure
  | {
      readonly kind: 'AdmittedRunBindingRejected';
      readonly reason: AdmittedRunBindingRejection;
    }
  | {
      readonly kind: 'CalibrationCampaignUnavailable';
    }
  | {
      readonly kind: 'CalibrationRunUnsettled';
      readonly ordinal: 1 | 2 | 3 | 4 | 5;
      readonly supervision: RunSupervision;
    }
  | {
      readonly kind: 'CalibrationRejected';
      readonly ordinal: 1 | 2 | 3 | 4 | 5;
      readonly supervision: Extract<RunSupervision, { readonly kind: 'Stopped' }>;
    }
  | {
      readonly kind: 'CalibrationInsufficient';
      readonly confirmed: number;
      readonly excluded: number;
    }
  | {
      readonly kind: 'RunSupervised';
      readonly preparation: AdmittedTaskRunPreparation;
      readonly supervision: RunSupervision;
      readonly calibrations: { readonly confirmed: number; readonly excluded: number };
    };

export type PreparedCompatibilityCampaignAcquisition =
  | { readonly kind: 'Acquired'; readonly campaignId: string }
  | { readonly kind: 'BindingConflict' }
  | { readonly kind: 'Unavailable' };

export interface PreparedCompatibilityCampaigns {
  acquire(taskLabel: string): Promise<PreparedCompatibilityCampaignAcquisition>;
}

export interface TaskRunExecutionDependencies {
  readonly campaigns: PreparedCompatibilityCampaigns;
  readonly history: CalibrationCampaignProgressReading;
  readonly preparation: Pick<TaskRunPreparation, 'prepare'>;
  readonly supervision: AdmittedRunSupervisionProvision;
}

interface AdmittedRun {
  readonly run: Run;
  readonly lease: RunLeaseReceipt;
}

type AdmittedRunReconstruction =
  | { readonly kind: 'Reconstructed'; readonly admitted: AdmittedRun }
  | {
      readonly kind: 'Rejected';
      readonly reason: AdmittedRunBindingRejection;
    };

function repositoryMatches(
  left: Run['binding']['repository'],
  right: Run['binding']['repository'],
): boolean {
  return (
    left.objectFormat === right.objectFormat &&
    left.commit === right.commit &&
    left.tree === right.tree
  );
}

function preparationMatchesRun(
  preparation: AdmittedTaskRunPreparation,
  run: Run,
  purpose: RunPurpose,
): boolean {
  const task = preparation.task;
  const harness = preparation.harness.projection;
  const revision = harness.revision;
  const binding = run.binding;
  const expectedBudget = effectiveRunBudget({
    requested: revision.budgetCeilings.task,
    task: task.revision.budgets,
    server: revision.budgetCeilings.server,
    mandate: revision.budgetCeilings.mandate,
  });
  return (
    task.lifecycle.kind === 'Open' &&
    harness.ownerAid === task.ownerAid &&
    revision.task.taskId === task.taskId &&
    revision.task.revisionSaid === task.revisionSaid &&
    revision.task.harnessLineageId === task.harnessLineageId &&
    revision.authority.personalAgentAid === preparation.mandates.personalAgent.aid &&
    revision.authority.taskMandateSaid === preparation.mandates.taskMandate.credentialSaid &&
    binding.ownerAid === task.ownerAid &&
    binding.taskId === task.taskId &&
    binding.taskRevisionSaid === task.revisionSaid &&
    binding.harnessLineageId === task.harnessLineageId &&
    binding.initialHarnessRevisionSaid === revision.d &&
    binding.personalAgentAid === preparation.mandates.personalAgent.aid &&
    binding.taskMandateSaid === preparation.mandates.taskMandate.credentialSaid &&
    binding.governorAid === preparation.mandates.governor.aid &&
    binding.promotionMandateSaid === preparation.mandates.promotionMandate.credentialSaid &&
    isDeepStrictEqual(binding.purpose, purpose) &&
    repositoryMatches(binding.repository, task.revision.repository) &&
    repositoryMatches(binding.repository, revision.repository) &&
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Preparing' &&
    run.submissionVerification.kind === 'NotSubmitted' &&
    run.lease.kind === 'Unassigned' &&
    taskBudgetNames.every(
      (name) => binding.budget[name] === expectedBudget[name] && run.consumedBudget[name] === 0,
    )
  );
}

function reconstructAdmittedRun(
  preparation: AdmittedTaskRunPreparation,
  purpose: RunPurpose,
): AdmittedRunReconstruction {
  const decoded = decodeRunProjection(preparation.run.run);
  if (decoded.kind !== 'Accepted') {
    return { kind: 'Rejected', reason: 'RunProjectionRejected' };
  }
  if (!preparationMatchesRun(preparation, decoded.run, purpose)) {
    return { kind: 'Rejected', reason: 'PreparationBindingMismatch' };
  }
  const lease = preparation.run.lease;
  if (lease.runId !== decoded.run.binding.runId) {
    return { kind: 'Rejected', reason: 'LeaseRunMismatch' };
  }
  if (lease.runVersion !== decoded.run.version + 1) {
    return { kind: 'Rejected', reason: 'LeaseVersionMismatch' };
  }
  const serverTime = Date.parse(lease.serverTime);
  const expiresAt = Date.parse(lease.expiresAt);
  const maximumInterval = runLeasePolicy.leaseSeconds * 1_000;
  const remaining = expiresAt - serverTime;
  if (
    !Number.isSafeInteger(remaining) ||
    remaining <= 0 ||
    remaining > maximumInterval ||
    (lease.disposition === 'Acquired' && remaining !== maximumInterval)
  ) {
    return { kind: 'Rejected', reason: 'LeaseTimeMismatch' };
  }
  const acquiredAt = new Date(expiresAt - maximumInterval).toISOString();
  const acquired = acquireFirstRunLease(decoded.run, {
    incarnationId: lease.incarnationId,
    expectedRunVersion: decoded.run.version,
    serverTime: acquiredAt,
  });
  if (acquired.kind === 'ServerTimeInvalid') {
    return { kind: 'Rejected', reason: 'LeaseTimeMismatch' };
  }
  if (acquired.kind !== 'Acquired') {
    return { kind: 'Rejected', reason: 'LeaseTransitionRejected' };
  }
  if (acquired.run.version !== lease.runVersion) {
    return { kind: 'Rejected', reason: 'LeaseVersionMismatch' };
  }
  if (
    acquired.run.lease.kind !== 'Held' ||
    acquired.run.lease.incarnationId !== lease.incarnationId
  ) {
    return { kind: 'Rejected', reason: 'LeaseIncarnationMismatch' };
  }
  if (
    acquired.run.lease.acquiredAt !== acquiredAt ||
    acquired.run.lease.expiresAt !== lease.expiresAt
  ) {
    return { kind: 'Rejected', reason: 'LeaseTimeMismatch' };
  }
  return {
    kind: 'Reconstructed',
    admitted: {
      run: acquired.run,
      lease: {
        runId: lease.runId,
        incarnationId: lease.incarnationId,
        runVersion: lease.runVersion,
        serverTime: lease.serverTime,
        expiresAt: lease.expiresAt,
      },
    },
  };
}

function continuesCampaign(
  preparation: AdmittedTaskRunPreparation,
  prior: BaselineRunBinding | undefined,
): boolean {
  if (prior === undefined) return true;
  const run = preparation.run.run;
  return isDeepStrictEqual(prior, {
    purpose: prior.purpose,
    ownerAid: run.ownerAid,
    taskId: run.taskId,
    taskRevisionSaid: run.taskRevisionSaid,
    harnessLineageId: run.harnessLineageId,
    harnessRevisionSaid: run.harnessRevisionSaid,
    personalAgentAid: run.personalAgentAid,
    taskMandateSaid: run.taskMandateSaid,
    governorAid: run.governorAid,
    promotionMandateSaid: run.promotionMandateSaid,
    repository: run.repository,
  });
}

export class TaskRunExecution {
  readonly #dependencies: TaskRunExecutionDependencies;

  constructor(dependencies: TaskRunExecutionDependencies) {
    this.#dependencies = dependencies;
  }

  async run(label: string, signal: AbortSignal): Promise<TaskRunExecutionOutcome> {
    const campaign = await this.#dependencies.campaigns.acquire(label);
    if (campaign.kind !== 'Acquired') return { kind: 'CalibrationCampaignUnavailable' };
    const progress = await this.#dependencies.history.inspect(label, campaign.campaignId);
    switch (progress.kind) {
      case 'Unavailable':
        return { kind: 'CalibrationCampaignUnavailable' };
      case 'RecoveryRequired':
        return { ...progress, kind: 'CalibrationRecoveryRequired' };
      case 'Rejected':
        return { ...progress, kind: 'CalibrationCampaignClosed' };
      case 'RetainedRunExists':
        return { kind: 'RetainedRunAlreadyAdmitted', runId: progress.runId };
      case 'Ready':
        break;
    }
    if (
      !Number.isInteger(progress.confirmed) ||
      !Number.isInteger(progress.excluded) ||
      progress.confirmed < 0 ||
      progress.excluded < 0 ||
      progress.confirmed + progress.excluded !== progress.nextOrdinal - 1
    )
      return { kind: 'CalibrationCampaignUnavailable' };
    let confirmed = progress.confirmed;
    let excluded = progress.excluded;
    const ordinals = [1, 2, 3, 4, 5] as const;
    for (const ordinal of ordinals) {
      if (ordinal < progress.nextOrdinal) continue;
      const purpose: RunPurpose = {
        kind: 'PreparedCompatibilityCalibration',
        campaignId: campaign.campaignId,
        ordinal,
      };
      const calibration = await this.#dependencies.preparation.prepare(label, purpose);
      if (calibration.kind !== 'RunLeaseAcquired') return calibration;
      if (!continuesCampaign(calibration, progress.priorBinding))
        return { kind: 'AdmittedRunBindingRejected', reason: 'PreparationBindingMismatch' };
      const reconstructed = reconstructAdmittedRun(calibration, purpose);
      if (reconstructed.kind === 'Rejected') {
        return { kind: 'AdmittedRunBindingRejected', reason: reconstructed.reason };
      }
      const supervision = await this.#dependencies.supervision
        .provision(calibration)
        .supervise(
          reconstructed.admitted.run,
          reconstructed.admitted.lease,
          signal,
          calibration.run.leaseRequestStartedAt,
        );
      if (supervision.kind !== 'Stopped' || supervision.run.lifecycle.kind !== 'Ended') {
        return { kind: 'CalibrationRunUnsettled', ordinal, supervision };
      }
      switch (supervision.run.lifecycle.outcome.kind) {
        case 'CalibrationConfirmed':
          confirmed += 1;
          break;
        case 'CalibrationExcluded':
          excluded += 1;
          break;
        case 'CalibrationRejected':
          return { kind: 'CalibrationRejected', ordinal, supervision };
        case 'Cancelled':
        case 'Submitted':
        case 'Failed':
        case 'AuthorityRevoked':
          return { kind: 'CalibrationRunUnsettled', ordinal, supervision };
      }
    }
    if (confirmed < 4) return { kind: 'CalibrationInsufficient', confirmed, excluded };
    const purpose: RunPurpose = { kind: 'Retained' };
    const preparation = await this.#dependencies.preparation.prepare(label, purpose);
    if (preparation.kind !== 'RunLeaseAcquired') {
      return preparation;
    }
    if (!continuesCampaign(preparation, progress.priorBinding))
      return { kind: 'AdmittedRunBindingRejected', reason: 'PreparationBindingMismatch' };
    const reconstructed = reconstructAdmittedRun(preparation, purpose);
    if (reconstructed.kind === 'Rejected') {
      return {
        kind: 'AdmittedRunBindingRejected',
        reason: reconstructed.reason,
      };
    }
    const supervision = this.#dependencies.supervision.provision(preparation);
    return {
      kind: 'RunSupervised',
      preparation,
      supervision: await supervision.supervise(
        reconstructed.admitted.run,
        reconstructed.admitted.lease,
        signal,
        preparation.run.leaseRequestStartedAt,
      ),
      calibrations: { confirmed, excluded },
    };
  }
}
