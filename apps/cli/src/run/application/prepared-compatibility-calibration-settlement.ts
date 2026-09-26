import {
  planRunCalibration,
  recordRunCalibration,
  type CalibrationExclusionReason,
  type Run,
  type RunBlockedReason,
} from '@devrandom/domain';
import type {
  BaselineHarnessRevision,
  PublicVerifierReceipt,
  TaskProjection,
} from '@devrandom/protocol';
import type {
  EvidenceRecorder,
  RunSettlement,
  RunSettlementInput,
  RunSupervisionSettlement,
  RunStopCause,
} from '@devrandom/runtime';

import type { SubmittedVerificationCustody } from './run-submissions.js';
import type { UnresolvedPublicTaskVerification } from './public-task-verification.js';
import type {
  PreparedCompatibilityCalibrationAttempt,
  PreparedCompatibilityCalibrationSettlements,
  PreparedCompatibilityProviderProof,
} from './prepared-compatibility-calibration.js';
import type { PreparedCompatibilityFailures } from './prepared-compatibility.js';
import type { RunCheckpointing } from './verified-run-checkpoint.js';
import { evidenceSealingFailure, type RunEvidenceSealing } from './sealed-evidence-settlement.js';
import { settleBlockedRun } from './blocked-run-settlement.js';
import { settleRevokedRun } from './revoked-run-settlement.js';

export type PreparedCompatibilityProviderProofReading =
  | { readonly kind: 'Proved'; readonly proof: PreparedCompatibilityProviderProof }
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'Corrupt' }
  | { readonly kind: 'Unavailable' };

export interface PreparedCompatibilityProviderProofs {
  read(run: Run): PreparedCompatibilityProviderProofReading;
}

export interface PreparedCompatibilityEvidence
  extends EvidenceRecorder, PreparedCompatibilityProviderProofs {}

export interface PreparedCompatibilityCalibrationSettlementDependencies {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly evidence: PreparedCompatibilityEvidence;
  readonly custody: SubmittedVerificationCustody;
  readonly verification: UnresolvedPublicTaskVerification;
  readonly compatibility: PreparedCompatibilityFailures;
  readonly calibration: PreparedCompatibilityCalibrationSettlements;
  readonly checkpointing: RunCheckpointing;
  readonly sealing: RunEvidenceSealing;
  now(): string;
}

function exclusionReason(input: RunSettlementInput): CalibrationExclusionReason | undefined {
  if (input.cause.kind !== 'ExecutorSettled') return undefined;
  switch (input.cause.disposition.kind) {
    case 'ProviderUnavailable':
    case 'ModelCredentialUnavailable':
    case 'ModelConfigurationRequired':
    case 'ModelUsageUnavailable':
    case 'BudgetExhausted':
    case 'OutboxBackpressure':
      return input.cause.disposition.kind;
    case 'Aborted':
      return 'EffectAborted';
    case 'Completed':
    case 'ApprovalRequired':
    case 'DependencyUnavailable':
    case 'ContextLimitReached':
    case 'TaskMandateExpired':
    case 'LeaseLost':
    case 'SecretDetected':
    case 'EvidenceIntegrityFailure':
    case 'AuthorityRevoked':
    case 'EvidenceUnavailable':
      return undefined;
  }
}

function blockingReason(
  cause: RunStopCause,
): Exclude<RunBlockedReason, 'HarnessCompatibilityFailure' | 'ProcessLost'> | undefined {
  switch (cause.kind) {
    case 'UserInterrupted':
      return 'UserInterrupted';
    case 'LeaseKeeperSettled':
      return cause.disposition.kind === 'StoppedBySupervisor' ? undefined : 'LeaseLost';
    case 'PreparationRejected':
    case 'SupervisorIntegrityFailure':
      return undefined;
    case 'ExecutorSettled':
      switch (cause.disposition.kind) {
        case 'SecretDetected':
        case 'ApprovalRequired':
        case 'ContextLimitReached':
        case 'TaskMandateExpired':
        case 'LeaseLost':
        case 'DependencyUnavailable':
          return cause.disposition.kind;
        case 'ProviderUnavailable':
        case 'ModelCredentialUnavailable':
        case 'ModelConfigurationRequired':
        case 'ModelUsageUnavailable':
        case 'BudgetExhausted':
        case 'OutboxBackpressure':
        case 'Aborted':
        case 'Completed':
        case 'AuthorityRevoked':
        case 'EvidenceUnavailable':
        case 'EvidenceIntegrityFailure':
          return undefined;
      }
  }
}

export class PreparedCompatibilityCalibrationSettlement implements RunSupervisionSettlement {
  readonly #dependencies: PreparedCompatibilityCalibrationSettlementDependencies;

  constructor(dependencies: PreparedCompatibilityCalibrationSettlementDependencies) {
    this.#dependencies = dependencies;
  }

  async settle(input: RunSettlementInput): Promise<RunSettlement> {
    try {
      return await this.#settle(input);
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      this.#dependencies.evidence.close();
    }
  }

  async #settle(input: RunSettlementInput): Promise<RunSettlement> {
    const { task, harness, evidence } = this.#dependencies;
    const run = input.run;
    if (
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      run.lifecycle.kind !== 'Active' ||
      run.lifecycle.phase.kind !== 'Running' ||
      task.lifecycle.kind !== 'Open' ||
      run.binding.ownerAid !== task.ownerAid ||
      run.binding.taskId !== task.taskId ||
      run.binding.taskRevisionSaid !== task.revisionSaid ||
      run.binding.harnessLineageId !== task.harnessLineageId ||
      run.binding.initialHarnessRevisionSaid !== harness.d ||
      run.binding.personalAgentAid !== harness.authority.personalAgentAid ||
      run.binding.taskMandateSaid !== harness.authority.taskMandateSaid ||
      evidence.run.binding.runId !== run.binding.runId ||
      evidence.run.binding.evidenceStreamId !== run.binding.evidenceStreamId
    )
      return { kind: 'Unavailable' };

    if (
      input.cause.kind === 'ExecutorSettled' &&
      input.cause.disposition.kind === 'AuthorityRevoked'
    ) {
      return settleRevokedRun(run, this.#dependencies);
    }
    const reason = blockingReason(input.cause);
    if (reason !== undefined) {
      const transferred = this.#dependencies.custody.transferSubmittedVerification();
      if (transferred.kind === 'AlreadyTransferred') return { kind: 'Unavailable' };
      const receipts =
        transferred.kind === 'Transferred'
          ? transferred.verification.receipts
          : this.#dependencies.verification.unresolvedReceipts('RunBlocked');
      if (receipts === undefined) return { kind: 'Unavailable' };
      return settleBlockedRun(
        {
          run,
          reason,
          verifierReceipts: receipts,
          outputArtifactSaids:
            transferred.kind === 'Transferred' ? transferred.verification.outputArtifactSaids : [],
        },
        this.#dependencies,
      );
    }

    let attempt: PreparedCompatibilityCalibrationAttempt;
    let verifierReceipts: readonly PublicVerifierReceipt[];
    let outputArtifactSaids: readonly string[];
    const excluded = exclusionReason(input);
    if (excluded !== undefined) {
      const unresolved = this.#dependencies.verification.unresolvedReceipts('NotAttempted');
      if (unresolved === undefined) return { kind: 'Unavailable' };
      verifierReceipts = unresolved;
      outputArtifactSaids = [];
      attempt = { kind: 'ExcludedRun', runId: run.binding.runId, reason: excluded };
    } else {
      if (input.cause.kind !== 'ExecutorSettled' || input.cause.disposition.kind !== 'Completed') {
        return { kind: 'Unavailable' };
      }
      const transferred = this.#dependencies.custody.transferSubmittedVerification();
      if (transferred.kind !== 'Transferred') return { kind: 'Unavailable' };
      verifierReceipts = transferred.verification.receipts;
      outputArtifactSaids = transferred.verification.outputArtifactSaids;
      const classification = this.#dependencies.compatibility.classify({
        task,
        harness,
        run,
        verification: transferred.verification,
      });
      if (classification.kind === 'SecretDetected') {
        return settleBlockedRun(
          { run, reason: 'SecretDetected', verifierReceipts, outputArtifactSaids },
          this.#dependencies,
        );
      }
      if (classification.kind === 'InfrastructureFailure') {
        attempt = { kind: 'ExcludedRun', runId: run.binding.runId, reason: classification.reason };
      } else {
        const provider = evidence.read(run);
        if (provider.kind !== 'Proved') return { kind: 'Unavailable' };
        attempt = {
          kind: 'ClassifiedRealProviderRun',
          runId: run.binding.runId,
          classification,
          providerProof: provider.proof,
        };
      }
    }
    const assessment = await this.#dependencies.calibration.assess(attempt);
    if (assessment.kind !== 'Accepted') return { kind: 'Unavailable' };
    const plan = planRunCalibration(run, assessment.disposition);
    if (plan.kind !== 'Planned') return { kind: 'Unavailable' };
    if (assessment.disposition.kind === 'Confirmed') {
      const category = assessment.disposition.category;
      const receipt = verifierReceipts.find(
        (candidate) =>
          candidate.commandSaid === category.legacyCommandSaid &&
          candidate.outcome.kind === 'Rejected' &&
          candidate.outcome.reason.kind === 'UnexpectedExitCode' &&
          candidate.outcome.reason.expected === 0 &&
          candidate.outcome.reason.observed === category.legacyObservedExitCode,
      );
      if (
        receipt === undefined ||
        evidence.record({
          occurredAt: this.#dependencies.now(),
          producer: { kind: 'RunSupervisor' },
          event: {
            kind: 'FailureObserved',
            failure: 'HarnessCompatibilityFailure',
            receiptSaid: receipt.d,
          },
        }).kind !== 'Recorded'
      )
        return { kind: 'Unavailable' };
    }
    const checkpoint = await this.#dependencies.checkpointing.materialize({
      run,
      verifierReceipts,
      outputArtifactSaids,
      disposition: {
        runState: {
          kind: 'Ended',
          outcome: plan.state.outcome,
          verification: plan.state.submissionVerification,
        },
        continuation: { kind: 'NoContinuation' },
      },
    });
    if (checkpoint.kind !== 'Materialized') return { kind: 'Unavailable' };
    const recorded = recordRunCalibration(run, {
      checkpointSaid: checkpoint.checkpoint.d,
      disposition: assessment.disposition,
    });
    if (recorded.kind !== 'Recorded') return { kind: 'Unavailable' };
    if (
      evidence.record({
        occurredAt: this.#dependencies.now(),
        producer: { kind: 'RunSupervisor' },
        event: {
          kind: 'RunCalibrationRecorded',
          checkpointSaid: checkpoint.checkpoint.d,
          disposition: assessment.disposition,
        },
      }).kind !== 'Recorded'
    )
      return { kind: 'Unavailable' };
    const sealed = await this.#dependencies.sealing.settle(evidence, checkpoint.checkpoint.d);
    if (sealed.kind !== 'Sealed') {
      return { kind: 'EvidenceSealingFailed', failure: evidenceSealingFailure(sealed) };
    }
    const committed = await this.#dependencies.calibration.record(attempt);
    return committed.kind === 'Recorded'
      ? { kind: 'Settled', run: recorded.run }
      : { kind: 'Unavailable' };
  }
}
