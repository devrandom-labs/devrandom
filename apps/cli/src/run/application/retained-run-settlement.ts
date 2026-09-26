import {
  acceptRunSubmission,
  beginRunSubmission,
  rejectRunSubmission,
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
  EvidenceRecording,
  RunSettlement,
  RunSettlementInput,
  RunSupervisionSettlement,
  RunStopCause,
} from '@devrandom/runtime';

import type { SubmittedVerificationCustody } from './run-submissions.js';
import type { PreparedCompatibilityCalibrationConfirmations } from './prepared-compatibility-calibration.js';
import type {
  PreparedCompatibilityFailureCategory,
  PreparedCompatibilityFailures,
} from './prepared-compatibility.js';
import type { RunCheckpointing } from './verified-run-checkpoint.js';
import { evidenceSealingFailure, type RunEvidenceSealing } from './sealed-evidence-settlement.js';
import { settleBlockedRun } from './blocked-run-settlement.js';
import { settleRevokedRun } from './revoked-run-settlement.js';
import type {
  RetainedSubmittedVerification,
  UnresolvedPublicTaskVerification,
} from './public-task-verification.js';

export interface RetainedRunSettlementDependencies {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly evidence: EvidenceRecorder;
  readonly custody: SubmittedVerificationCustody;
  readonly verification: UnresolvedPublicTaskVerification;
  readonly compatibility: PreparedCompatibilityFailures;
  readonly calibration: PreparedCompatibilityCalibrationConfirmations;
  readonly checkpointing: RunCheckpointing;
  readonly sealing: RunEvidenceSealing;
  now(): string;
}

function recordingAccepted(recording: EvidenceRecording): boolean {
  return recording.kind === 'Recorded';
}

function legacyFailureReceipt(
  receipts: readonly PublicVerifierReceipt[],
  category: PreparedCompatibilityFailureCategory,
  classifiedReceiptSaids: readonly string[],
): PublicVerifierReceipt | undefined {
  return receipts.find(
    (receipt) =>
      classifiedReceiptSaids.includes(receipt.d) &&
      receipt.commandSaid === category.legacyCommandSaid &&
      receipt.outcome.kind === 'Rejected' &&
      receipt.outcome.reason.kind === 'UnexpectedExitCode' &&
      receipt.outcome.reason.expected === 0 &&
      receipt.outcome.reason.observed === category.legacyObservedExitCode,
  );
}

function runningBindingsMatch(
  run: Run,
  task: TaskProjection,
  harness: BaselineHarnessRevision,
  evidence: EvidenceRecorder,
): boolean {
  return (
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Running' &&
    run.binding.purpose.kind === 'Retained' &&
    task.lifecycle.kind === 'Open' &&
    run.binding.ownerAid === task.ownerAid &&
    run.binding.taskId === task.taskId &&
    run.binding.taskRevisionSaid === task.revisionSaid &&
    run.binding.harnessLineageId === task.harnessLineageId &&
    run.binding.initialHarnessRevisionSaid === harness.d &&
    run.binding.personalAgentAid === harness.authority.personalAgentAid &&
    run.binding.taskMandateSaid === harness.authority.taskMandateSaid &&
    evidence.run.binding.runId === run.binding.runId &&
    (evidence.run.currentExecution?.evidenceStreamId ?? evidence.run.binding.evidenceStreamId) ===
      (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId)
  );
}

function interruptionReason(
  cause: RunStopCause,
): Exclude<RunBlockedReason, 'HarnessCompatibilityFailure' | 'ProcessLost'> | undefined {
  switch (cause.kind) {
    case 'UserInterrupted':
      return 'UserInterrupted';
    case 'PreparationRejected':
    case 'SupervisorIntegrityFailure':
      return undefined;
    case 'LeaseKeeperSettled':
      return cause.disposition.kind === 'StoppedBySupervisor' ? undefined : 'LeaseLost';
    case 'ExecutorSettled':
      switch (cause.disposition.kind) {
        case 'ApprovalRequired':
        case 'BudgetExhausted':
        case 'ContextLimitReached':
        case 'TaskMandateExpired':
        case 'OutboxBackpressure':
        case 'SecretDetected':
        case 'LeaseLost':
        case 'DependencyUnavailable':
          return cause.disposition.kind;
        case 'ProviderUnavailable':
        case 'ModelConfigurationRequired':
        case 'ModelCredentialUnavailable':
        case 'ModelUsageUnavailable':
          return 'DependencyUnavailable';
        case 'Aborted':
        case 'Completed':
        case 'AuthorityRevoked':
        case 'EvidenceUnavailable':
        case 'EvidenceIntegrityFailure':
          return undefined;
      }
  }
}

export class RetainedRunSettlement implements RunSupervisionSettlement {
  readonly #dependencies: RetainedRunSettlementDependencies;

  constructor(dependencies: RetainedRunSettlementDependencies) {
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
    if (!runningBindingsMatch(input.run, task, harness, evidence)) {
      return { kind: 'Unavailable' };
    }
    if (
      input.cause.kind === 'ExecutorSettled' &&
      input.cause.disposition.kind === 'AuthorityRevoked'
    ) {
      return settleRevokedRun(input.run, this.#dependencies);
    }
    const reason = interruptionReason(input.cause);
    if (reason !== undefined) {
      const transferred = this.#dependencies.custody.transferSubmittedVerification();
      if (transferred.kind === 'AlreadyTransferred') return { kind: 'Unavailable' };
      let blockingRun = input.run;
      if (transferred.kind === 'Transferred' && transferred.verification.kind === 'Rejected') {
        const pending = beginRunSubmission(blockingRun);
        if (pending.kind !== 'Pending') return { kind: 'Unavailable' };
        const rejected = rejectRunSubmission(pending.run);
        if (rejected.kind !== 'Rejected') return { kind: 'Unavailable' };
        blockingRun = rejected.run;
      }
      const receipts =
        transferred.kind === 'Transferred'
          ? transferred.verification.receipts
          : this.#dependencies.verification.unresolvedReceipts('RunBlocked');
      if (receipts === undefined) return { kind: 'Unavailable' };
      return settleBlockedRun(
        {
          run: blockingRun,
          reason,
          verifierReceipts: receipts,
          outputArtifactSaids:
            transferred.kind === 'Transferred' ? transferred.verification.outputArtifactSaids : [],
        },
        this.#dependencies,
      );
    }
    if (input.cause.kind !== 'ExecutorSettled' || input.cause.disposition.kind !== 'Completed') {
      return { kind: 'Unavailable' };
    }
    const transferred = this.#dependencies.custody.transferSubmittedVerification();
    if (transferred.kind !== 'Transferred') {
      return { kind: 'Unavailable' };
    }
    if (transferred.verification.kind === 'Accepted') {
      return this.#submit(input.run, transferred.verification);
    }
    if (transferred.verification.kind !== 'Rejected') return { kind: 'Unavailable' };
    const classification = this.#dependencies.compatibility.classify({
      task,
      harness,
      run: input.run,
      verification: transferred.verification,
    });
    if (classification.kind !== 'Confirmed') {
      return { kind: 'Unavailable' };
    }
    const calibration = await this.#dependencies.calibration.confirm(classification.category);
    if (calibration.kind !== 'Confirmed') {
      return { kind: 'Unavailable' };
    }
    const legacyReceipt = legacyFailureReceipt(
      transferred.verification.receipts,
      classification.category,
      classification.verifierReceiptSaids,
    );
    if (legacyReceipt === undefined) {
      return { kind: 'Unavailable' };
    }
    const observed = evidence.record({
      occurredAt: this.#dependencies.now(),
      producer: { kind: 'RunSupervisor' },
      event: {
        kind: 'FailureObserved',
        failure: 'HarnessCompatibilityFailure',
        receiptSaid: legacyReceipt.d,
      },
    });
    if (!recordingAccepted(observed)) {
      return { kind: 'Unavailable' };
    }
    const pending = beginRunSubmission(input.run);
    if (pending.kind !== 'Pending') {
      return { kind: 'Unavailable' };
    }
    const rejected = rejectRunSubmission(pending.run);
    if (rejected.kind !== 'Rejected') {
      return { kind: 'Unavailable' };
    }
    return settleBlockedRun(
      {
        run: rejected.run,
        reason: 'HarnessCompatibilityFailure',
        verifierReceipts: transferred.verification.receipts,
        outputArtifactSaids: transferred.verification.outputArtifactSaids,
      },
      this.#dependencies,
    );
  }

  async #submit(
    run: Run,
    verification: Extract<RetainedSubmittedVerification, { readonly kind: 'Accepted' }>,
  ): Promise<RunSettlement> {
    const pending = beginRunSubmission(run);
    if (pending.kind !== 'Pending') return { kind: 'Unavailable' };
    const materialized = await this.#dependencies.checkpointing.materialize({
      run: pending.run,
      verifierReceipts: verification.receipts,
      outputArtifactSaids: verification.outputArtifactSaids,
      disposition: {
        runState: {
          kind: 'Ended',
          outcome: { kind: 'Submitted' },
          verification: { kind: 'Accepted' },
        },
        continuation: { kind: 'NoContinuation' },
      },
    });
    if (materialized.kind !== 'Materialized') return { kind: 'Unavailable' };
    const accepted = acceptRunSubmission(pending.run, {
      checkpointSaid: materialized.checkpoint.d,
    });
    if (accepted.kind !== 'Accepted') return { kind: 'Unavailable' };
    const sealed = await this.#dependencies.sealing.settle(
      this.#dependencies.evidence,
      materialized.checkpoint.d,
    );
    return sealed.kind === 'Sealed'
      ? { kind: 'Settled', run: accepted.run }
      : { kind: 'EvidenceSealingFailed', failure: evidenceSealingFailure(sealed) };
  }
}
