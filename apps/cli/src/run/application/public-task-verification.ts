import type { Run } from '@devrandom/domain';
import {
  preparePublicVerifierReceipt,
  type BaselineHarnessRevision,
  type PublicVerifierReceipt,
  type TaskProjection,
} from '@devrandom/protocol';
import type { EvidenceObservation, EvidenceRecorder, EvidenceRecording } from '@devrandom/runtime';

import type { ExactChildCommandOutcome, ExactChildCommands } from './exact-child-command.js';
import type { ProcessOutputEvidence } from './process-output-evidence.js';

export interface SubmittedResultVerificationInput {
  readonly artifactSaids: readonly string[];
}

interface CompletedVerification {
  readonly receipts: readonly PublicVerifierReceipt[];
  readonly outputArtifactSaids: readonly string[];
}

export type SubmittedResultVerificationOutcome =
  | ({ readonly kind: 'Accepted' } & CompletedVerification)
  | ({ readonly kind: 'Rejected'; readonly feedback: string } & CompletedVerification)
  | ({
      readonly kind: 'Blocked';
      readonly reason:
        'EffectAborted' | 'BudgetExhausted' | 'OutboxBackpressure' | 'SecretDetected';
    } & CompletedVerification)
  | { readonly kind: 'DependencyUnavailable' }
  | { readonly kind: 'ArtifactUnavailable' }
  | { readonly kind: 'EvidenceIntegrityFailure' };

export type RetainedSubmittedVerification = Extract<
  SubmittedResultVerificationOutcome,
  { readonly kind: 'Accepted' | 'Rejected' | 'Blocked' }
>;

export interface SubmittedResultVerification {
  verify(
    input: SubmittedResultVerificationInput,
    signal: AbortSignal,
  ): Promise<SubmittedResultVerificationOutcome>;
}

export interface UnresolvedPublicTaskVerification {
  unresolvedReceipts(
    reason: 'NotAttempted' | 'RunBlocked',
  ): readonly PublicVerifierReceipt[] | undefined;
}

export interface PublicTaskVerificationDependencies {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly evidence: EvidenceRecorder;
  readonly commands: ExactChildCommands;
  readonly processOutput: ProcessOutputEvidence;
  now(): string;
}

type ReceiptOutcome = PublicVerifierReceipt['outcome'];
type RejectedReceiptOutcome = Extract<ReceiptOutcome, { readonly kind: 'Rejected' }>;

type RecordedOutput =
  | {
      readonly kind: 'Recorded';
      readonly artifactSaids: readonly string[];
      readonly feedback: string;
    }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'DependencyUnavailable' }
  | { readonly kind: 'OutboxBackpressure' };

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function repositoryMatches(
  run: Run,
  task: TaskProjection,
  harness: BaselineHarnessRevision,
): boolean {
  return (
    run.binding.repository.objectFormat === task.revision.repository.objectFormat &&
    run.binding.repository.commit === task.revision.repository.commit &&
    run.binding.repository.tree === task.revision.repository.tree &&
    harness.repository.objectFormat === task.revision.repository.objectFormat &&
    harness.repository.commit === task.revision.repository.commit &&
    harness.repository.tree === task.revision.repository.tree
  );
}

function completionCommandsMatch(task: TaskProjection, harness: BaselineHarnessRevision): boolean {
  if (task.revision.completionConditions.length !== harness.completionCommands.length) {
    return false;
  }
  return task.revision.completionConditions.every((condition, index) => {
    const command = harness.completionCommands[index];
    return (
      command !== undefined &&
      command.identity === condition.id &&
      arraysEqual(command.argv, condition.argv) &&
      command.timeoutSeconds === condition.timeoutSeconds &&
      command.expectedExitCode === condition.expected.code
    );
  });
}

function exactBindingMatches(dependencies: PublicTaskVerificationDependencies): boolean {
  const { task, harness, evidence } = dependencies;
  const run = evidence.run;
  return (
    task.lifecycle.kind === 'Open' &&
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Running' &&
    run.lease.kind === 'Held' &&
    run.binding.ownerAid === task.ownerAid &&
    run.binding.taskId === task.taskId &&
    run.binding.taskRevisionSaid === task.revisionSaid &&
    run.binding.harnessLineageId === task.harnessLineageId &&
    run.binding.initialHarnessRevisionSaid === harness.d &&
    run.binding.personalAgentAid === harness.authority.personalAgentAid &&
    run.binding.taskMandateSaid === harness.authority.taskMandateSaid &&
    harness.task.taskId === task.taskId &&
    harness.task.revisionSaid === task.revisionSaid &&
    harness.task.harnessLineageId === task.harnessLineageId &&
    arraysEqual(
      harness.task.requestedCapabilities,
      task.revision.requestedCapabilities.filter((capability) => capability !== 'ReadTaskMemory'),
    ) &&
    repositoryMatches(run, task, harness) &&
    completionCommandsMatch(task, harness)
  );
}

function uniqueSaids(saids: readonly string[]): readonly string[] {
  return [...new Set(saids)];
}

function recordingDisposition(recording: EvidenceRecording): RecordedOutput['kind'] | 'Recorded' {
  switch (recording.kind) {
    case 'SecretDetected':
      return 'SecretDetected';
    case 'Recorded':
      return 'Recorded';
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return 'OutboxBackpressure';
    case 'Unavailable':
      return 'DependencyUnavailable';
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return 'EvidenceIntegrityFailure';
  }
}

export class PublicTaskVerification
  implements SubmittedResultVerification, UnresolvedPublicTaskVerification
{
  readonly #dependencies: PublicTaskVerificationDependencies;

  constructor(dependencies: PublicTaskVerificationDependencies) {
    this.#dependencies = dependencies;
  }

  unresolvedReceipts(
    reason: 'NotAttempted' | 'RunBlocked',
  ): readonly PublicVerifierReceipt[] | undefined {
    return exactBindingMatches(this.#dependencies)
      ? this.#unresolvedReceipts(0, reason)
      : undefined;
  }

  async verify(
    input: SubmittedResultVerificationInput,
    signal: AbortSignal,
  ): Promise<SubmittedResultVerificationOutcome> {
    if (!exactBindingMatches(this.#dependencies)) {
      return { kind: 'DependencyUnavailable' };
    }
    for (const artifactSaid of uniqueSaids(input.artifactSaids)) {
      const artifact = this.#dependencies.evidence.artifact(artifactSaid);
      switch (artifact.kind) {
        case 'ArtifactNotFound':
          return { kind: 'ArtifactUnavailable' };
        case 'LocalStateCorruption':
          return { kind: 'EvidenceIntegrityFailure' };
        case 'Unavailable':
          return { kind: 'DependencyUnavailable' };
        case 'Read':
          break;
      }
    }
    const submission = this.#record({
      kind: 'ResultSubmitted',
      artifactSaids: [...input.artifactSaids],
    });
    if (submission !== 'Recorded') {
      return this.#recordingFailure(submission, [], []);
    }

    const receipts: PublicVerifierReceipt[] = [];
    const outputArtifactSaids: string[] = [];
    for (let index = 0; index < this.#dependencies.harness.completionCommands.length; index += 1) {
      const command = this.#dependencies.harness.completionCommands[index];
      if (command === undefined) {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      let outcome: ExactChildCommandOutcome;
      try {
        outcome = await this.#dependencies.commands.run(
          {
            executableRealpath: command.executableRealpath,
            arguments: command.argv.slice(1),
            timeoutSeconds: command.timeoutSeconds,
            expectedExitCode: command.expectedExitCode,
            budgetProducer: { kind: 'PublicTaskVerifier' },
          },
          signal,
        );
      } catch {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      const adjudication = await this.#adjudicate(command, outcome);
      if (adjudication.kind === 'EvidenceIntegrityFailure') {
        return adjudication;
      }
      if (adjudication.kind === 'DependencyUnavailable') {
        return { kind: 'DependencyUnavailable' };
      }
      if (adjudication.kind === 'SecretDetected')
        return this.#blocked(receipts, outputArtifactSaids, index, 'SecretDetected');
      if (adjudication.kind === 'OutboxBackpressure') {
        return this.#blocked(receipts, outputArtifactSaids, index, 'OutboxBackpressure');
      }
      outputArtifactSaids.push(...adjudication.outputArtifactSaids);
      if (adjudication.kind === 'Blocked') {
        return this.#blocked(receipts, outputArtifactSaids, index, adjudication.reason);
      }
      const receipt = this.#receipt(command.identity, command.contentSaid, adjudication.outcome);
      if (receipt === undefined) {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      receipts.push(receipt);
      let verificationEvent: EvidenceObservation['event'];
      if (adjudication.outcome.kind === 'Accepted') {
        verificationEvent = {
          kind: 'TaskVerificationAccepted',
          completionConditionId: command.identity,
          receiptSaid: receipt.d,
        };
      } else if (adjudication.outcome.kind === 'Rejected') {
        verificationEvent = {
          kind: 'TaskVerificationRejected',
          completionConditionId: command.identity,
          receiptSaid: receipt.d,
          reason: adjudication.outcome.reason.kind,
        };
      } else {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      const verificationRecording = this.#record(verificationEvent);
      if (verificationRecording !== 'Recorded') {
        return this.#recordingFailure(verificationRecording, receipts, outputArtifactSaids);
      }
      if (adjudication.outcome.kind === 'Rejected') {
        const unresolved = this.#unresolvedReceipts(index + 1, 'EarlierConditionRejected');
        if (unresolved === undefined) {
          return { kind: 'EvidenceIntegrityFailure' };
        }
        return {
          kind: 'Rejected',
          feedback: `Completion condition ${command.identity} rejected: ${JSON.stringify(adjudication.outcome.reason)}.\n${adjudication.feedback}`,
          receipts: [...receipts, ...unresolved],
          outputArtifactSaids: uniqueSaids(outputArtifactSaids),
        };
      }
    }
    return {
      kind: 'Accepted',
      receipts,
      outputArtifactSaids: uniqueSaids(outputArtifactSaids),
    };
  }

  async #adjudicate(
    command: BaselineHarnessRevision['completionCommands'][number],
    reported: ExactChildCommandOutcome,
  ): Promise<
    | {
        readonly kind: 'Receipt';
        readonly outcome: ReceiptOutcome;
        readonly feedback: string;
        readonly outputArtifactSaids: readonly string[];
      }
    | {
        readonly kind: 'Blocked';
        readonly reason: 'EffectAborted' | 'BudgetExhausted';
        readonly outputArtifactSaids: readonly string[];
      }
    | { readonly kind: 'OutboxBackpressure' }
    | { readonly kind: 'SecretDetected' }
    | { readonly kind: 'EvidenceIntegrityFailure' }
    | { readonly kind: 'DependencyUnavailable' }
  > {
    if (reported.kind === 'WorktreeAdmissionRejected') {
      return reported.failure === 'BudgetExhausted'
        ? { kind: 'Blocked', reason: 'BudgetExhausted', outputArtifactSaids: [] }
        : { kind: reported.failure };
    }
    const outcome =
      reported.kind === 'WorktreeReconciliationFailed' ? reported.execution : reported;
    switch (outcome.kind) {
      case 'AbortedBeforeStart':
        return { kind: 'Blocked', reason: 'EffectAborted', outputArtifactSaids: [] };
      case 'ExecutableUnavailable':
        return {
          kind: 'Receipt',
          outcome: this.#rejected({ kind: 'ExecutableUnavailable' }, 0, []),
          feedback: 'The exact admitted executable is unavailable; no command output was produced.',
          outputArtifactSaids: [],
        };
      case 'BudgetExhausted':
        return { kind: 'Blocked', reason: 'BudgetExhausted', outputArtifactSaids: [] };
      case 'DependencyUnavailable':
        return { kind: 'DependencyUnavailable' };
      case 'Completed':
      case 'ExitCodeMismatch':
      case 'TimedOut':
      case 'OutputLimitExceeded':
      case 'Aborted':
      case 'SecretDetected':
      case 'ProcessGroupSurvived':
      case 'ProcessCleanupUnconfirmed':
      case 'BudgetCommitmentFailed': {
        const output = await this.#recordOutput(outcome.output);
        if (output.kind !== 'Recorded') {
          return output;
        }
        if (outcome.kind === 'SecretDetected') return { kind: 'EvidenceIntegrityFailure' };
        if (
          outcome.kind === 'ProcessGroupSurvived' ||
          outcome.kind === 'ProcessCleanupUnconfirmed'
        ) {
          const security = this.#record({
            kind: 'SecurityViolation',
            violation:
              outcome.kind === 'ProcessGroupSurvived'
                ? 'ProcessSurvivedTermination'
                : 'ProcessCleanupUnconfirmed',
          });
          return security === 'Recorded'
            ? { kind: 'EvidenceIntegrityFailure' }
            : this.#recordingFailureWithoutReceipts(security);
        }
        if (reported.kind === 'WorktreeReconciliationFailed') {
          return reported.failure === 'BudgetExhausted'
            ? {
                kind: 'Blocked',
                reason: 'BudgetExhausted',
                outputArtifactSaids: output.artifactSaids,
              }
            : { kind: reported.failure };
        }
        if (outcome.kind === 'BudgetCommitmentFailed') {
          return outcome.failure === 'BudgetExhausted'
            ? {
                kind: 'Blocked',
                reason: 'BudgetExhausted',
                outputArtifactSaids: output.artifactSaids,
              }
            : { kind: outcome.failure };
        }
        if (outcome.kind === 'Aborted') {
          return {
            kind: 'Blocked',
            reason: 'EffectAborted',
            outputArtifactSaids: output.artifactSaids,
          };
        }
        const receiptOutcome: ReceiptOutcome =
          outcome.kind === 'Completed'
            ? {
                kind: 'Accepted',
                observedExitCode: outcome.exitCode,
                elapsedMilliseconds: outcome.elapsedMilliseconds,
                outputArtifactSaids: [...output.artifactSaids],
              }
            : this.#rejected(
                outcome.kind === 'ExitCodeMismatch'
                  ? {
                      kind: 'UnexpectedExitCode',
                      expected: command.expectedExitCode,
                      observed: outcome.exitCode,
                    }
                  : { kind: outcome.kind },
                outcome.elapsedMilliseconds,
                output.artifactSaids,
              );
        return {
          kind: 'Receipt',
          outcome: receiptOutcome,
          feedback: output.feedback,
          outputArtifactSaids: output.artifactSaids,
        };
      }
    }
  }

  #rejected(
    reason: RejectedReceiptOutcome['reason'],
    elapsed: number,
    outputArtifactSaids: readonly string[],
  ): RejectedReceiptOutcome {
    return {
      kind: 'Rejected',
      reason,
      elapsedMilliseconds: elapsed,
      outputArtifactSaids: [...uniqueSaids(outputArtifactSaids)],
    };
  }

  async #recordOutput(
    output: Extract<ExactChildCommandOutcome, { readonly output: object }>['output'],
  ): Promise<RecordedOutput> {
    let recorded;
    try {
      recorded = await this.#dependencies.processOutput.record(output);
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
    switch (recorded.kind) {
      case 'SecretDetected':
      case 'EvidenceIntegrityFailure':
        return recorded;
      case 'CleanupUnavailable':
      case 'DependencyUnavailable':
        return { kind: 'DependencyUnavailable' };
      case 'Recorded': {
        const artifactSaids = uniqueSaids([
          recorded.stdoutArtifactSaid,
          recorded.stderrArtifactSaid,
        ]);
        for (const artifactSaid of [recorded.stdoutArtifactSaid, recorded.stderrArtifactSaid]) {
          const observation = this.#record({
            kind: 'Observation',
            source: 'Verifier',
            artifactSaid,
          });
          if (observation !== 'Recorded') {
            return this.#recordingFailureWithoutReceipts(observation);
          }
        }
        return { kind: 'Recorded', artifactSaids, feedback: recorded.feedback };
      }
    }
  }

  #receipt(
    completionConditionId: string,
    commandSaid: string,
    outcome: ReceiptOutcome,
  ): PublicVerifierReceipt | undefined {
    const prepared = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId,
      commandSaid,
      recordedAt: this.#dependencies.now(),
      outcome,
    });
    return prepared.kind === 'Prepared' ? prepared.receipt : undefined;
  }

  #unresolvedReceipts(
    startIndex: number,
    reason: 'NotAttempted' | 'EarlierConditionRejected' | 'RunBlocked',
  ): readonly PublicVerifierReceipt[] | undefined {
    const receipts: PublicVerifierReceipt[] = [];
    for (
      let index = startIndex;
      index < this.#dependencies.harness.completionCommands.length;
      index += 1
    ) {
      const command = this.#dependencies.harness.completionCommands[index];
      if (command === undefined) return undefined;
      const receipt = this.#receipt(command.identity, command.contentSaid, {
        kind: 'Unresolved',
        reason,
      });
      if (receipt === undefined) return undefined;
      receipts.push(receipt);
    }
    return receipts;
  }

  #blocked(
    receipts: readonly PublicVerifierReceipt[],
    outputArtifactSaids: readonly string[],
    conditionIndex: number,
    reason: 'EffectAborted' | 'BudgetExhausted' | 'OutboxBackpressure' | 'SecretDetected',
  ): SubmittedResultVerificationOutcome {
    const unresolved = this.#unresolvedReceipts(conditionIndex, 'RunBlocked');
    return unresolved === undefined
      ? { kind: 'EvidenceIntegrityFailure' }
      : {
          kind: 'Blocked',
          reason,
          receipts: [...receipts, ...unresolved],
          outputArtifactSaids: uniqueSaids(outputArtifactSaids),
        };
  }

  #record(event: EvidenceObservation['event']): RecordedOutput['kind'] | 'Recorded' {
    return recordingDisposition(
      this.#dependencies.evidence.record({
        occurredAt: this.#dependencies.now(),
        producer: { kind: 'PublicTaskVerifier' },
        event,
      }),
    );
  }

  #recordingFailure(
    disposition: Exclude<RecordedOutput['kind'], 'Recorded'>,
    receipts: readonly PublicVerifierReceipt[],
    outputArtifactSaids: readonly string[],
  ): SubmittedResultVerificationOutcome {
    if (disposition === 'OutboxBackpressure' || disposition === 'SecretDetected') {
      return {
        kind: 'Blocked',
        reason: disposition,
        receipts,
        outputArtifactSaids: uniqueSaids(outputArtifactSaids),
      };
    }
    if (disposition === 'DependencyUnavailable') {
      return { kind: 'DependencyUnavailable' };
    }
    return { kind: 'EvidenceIntegrityFailure' };
  }

  #recordingFailureWithoutReceipts(
    disposition: Exclude<RecordedOutput['kind'], 'Recorded'>,
  ): Exclude<RecordedOutput, { readonly kind: 'Recorded' }> {
    return { kind: disposition };
  }
}
