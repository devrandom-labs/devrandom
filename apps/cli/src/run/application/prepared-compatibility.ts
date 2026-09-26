import type { PreparedCompatibilityFailureCategory, Run } from '@devrandom/domain';
export type { PreparedCompatibilityFailureCategory } from '@devrandom/domain';
import {
  decodeBaselineHarnessRevision,
  decodePublicVerifierReceipt,
  decodeTaskRevision,
  type BaselineHarnessRevision,
  type PublicVerifierReceipt,
  type TaskProjection,
} from '@devrandom/protocol';

import type { RetainedSubmittedVerification } from './public-task-verification.js';

export interface PreparedCompatibilityFailureInput {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly run: Run;
  readonly verification: RetainedSubmittedVerification;
}

export type PreparedCompatibilityFailureClassification =
  | {
      readonly kind: 'Confirmed';
      readonly category: PreparedCompatibilityFailureCategory;
      readonly verifierReceiptSaids: readonly string[];
    }
  | {
      readonly kind: 'NotConfirmed';
      readonly reason: 'H1Passed' | 'ReceiptPatternMismatch' | 'FixtureBindingMismatch';
    }
  | {
      readonly kind: 'InfrastructureFailure';
      readonly reason: 'EffectAborted' | 'BudgetExhausted' | 'OutboxBackpressure';
    }
  | { readonly kind: 'SecretDetected' };

export interface PreparedCompatibilityFailures {
  classify(input: PreparedCompatibilityFailureInput): PreparedCompatibilityFailureClassification;
}

interface FixtureCommands {
  readonly current: BaselineHarnessRevision['completionCommands'][number];
  readonly tamper: BaselineHarnessRevision['completionCommands'][number];
  readonly legacy: BaselineHarnessRevision['completionCommands'][number];
}

const fixtureConditions = [
  {
    id: 'cesr-current',
    argv: ['cargo', 'test', '--locked', '--test', 'cesr-current'],
  },
  {
    id: 'cesr-tamper',
    argv: ['cargo', 'test', '--locked', '--test', 'cesr-tamper'],
  },
  {
    id: 'cesr-legacy',
    argv: ['cargo', 'test', '--locked', '--test', 'cesr-legacy'],
  },
] as const;

const verifierReadOnlyPaths: readonly string[] = Object.freeze([
  'Cargo.toml',
  'Cargo.lock',
  'AGENTS.md',
  'build.rs',
  '.cargo',
  'rust-toolchain',
  'rust-toolchain.toml',
  'tests',
]);

export function preparedCompatibilityVerifierReadOnlyPaths(
  task: TaskProjection,
): readonly string[] {
  if (
    task.label !== 'cesr-compat' ||
    decodeTaskRevision(task.revision).kind !== 'Accepted' ||
    task.revision.completionConditions.length !== fixtureConditions.length ||
    !fixtureConditions.every((expected, index) => {
      const condition = task.revision.completionConditions[index];
      return (
        condition?.id === expected.id &&
        arraysEqual(condition.argv, expected.argv) &&
        condition.expected.code === 0
      );
    })
  ) {
    return [];
  }
  return verifierReadOnlyPaths;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fixtureCommands(input: PreparedCompatibilityFailureInput): FixtureCommands | undefined {
  const { task, harness, run } = input;
  if (
    decodeTaskRevision(task.revision).kind !== 'Accepted' ||
    decodeBaselineHarnessRevision(harness).kind !== 'Accepted' ||
    task.label !== 'cesr-compat' ||
    task.lifecycle.kind !== 'Open' ||
    task.revisionSaid !== task.revision.d ||
    task.revision.completionConditions.length !== fixtureConditions.length ||
    harness.completionCommands.length !== fixtureConditions.length ||
    harness.task.taskId !== task.taskId ||
    harness.task.revisionSaid !== task.revisionSaid ||
    harness.task.harnessLineageId !== task.harnessLineageId ||
    !arraysEqual(harness.task.requestedCapabilities, task.revision.requestedCapabilities) ||
    harness.repository.objectFormat !== task.revision.repository.objectFormat ||
    harness.repository.commit !== task.revision.repository.commit ||
    harness.repository.tree !== task.revision.repository.tree ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Running' ||
    run.lease.kind !== 'Held' ||
    run.binding.ownerAid !== task.ownerAid ||
    run.binding.taskId !== task.taskId ||
    run.binding.taskRevisionSaid !== task.revisionSaid ||
    run.binding.harnessLineageId !== task.harnessLineageId ||
    run.binding.initialHarnessRevisionSaid !== harness.d ||
    run.binding.personalAgentAid !== harness.authority.personalAgentAid ||
    run.binding.taskMandateSaid !== harness.authority.taskMandateSaid ||
    run.binding.repository.objectFormat !== task.revision.repository.objectFormat ||
    run.binding.repository.commit !== task.revision.repository.commit ||
    run.binding.repository.tree !== task.revision.repository.tree
  ) {
    return undefined;
  }
  for (let index = 0; index < fixtureConditions.length; index += 1) {
    const expected = fixtureConditions[index];
    const condition = task.revision.completionConditions[index];
    const command = harness.completionCommands[index];
    if (
      expected === undefined ||
      condition === undefined ||
      command === undefined ||
      condition.id !== expected.id ||
      !arraysEqual(condition.argv, expected.argv) ||
      condition.expected.code !== 0 ||
      command.identity !== condition.id ||
      !arraysEqual(command.argv, condition.argv) ||
      command.expectedExitCode !== condition.expected.code ||
      command.timeoutSeconds !== condition.timeoutSeconds
    ) {
      return undefined;
    }
  }
  const [current, tamper, legacy] = harness.completionCommands;
  return current === undefined || tamper === undefined || legacy === undefined
    ? undefined
    : { current, tamper, legacy };
}

function receiptMatches(
  receipt: PublicVerifierReceipt,
  command: BaselineHarnessRevision['completionCommands'][number],
): boolean {
  return (
    decodePublicVerifierReceipt(receipt).kind === 'Accepted' &&
    receipt.completionConditionId === command.identity &&
    receipt.commandSaid === command.contentSaid
  );
}

function accepted(receipt: PublicVerifierReceipt): boolean {
  return receipt.outcome.kind === 'Accepted' && receipt.outcome.observedExitCode === 0;
}

export class PreparedCompatibilityClassifier implements PreparedCompatibilityFailures {
  classify(input: PreparedCompatibilityFailureInput): PreparedCompatibilityFailureClassification {
    if (input.verification.kind === 'Blocked') {
      if (input.verification.reason === 'SecretDetected') return { kind: 'SecretDetected' };
      if (fixtureCommands(input) === undefined)
        return { kind: 'NotConfirmed', reason: 'FixtureBindingMismatch' };
      return { kind: 'InfrastructureFailure', reason: input.verification.reason };
    }
    const commands = fixtureCommands(input);
    if (commands === undefined) return { kind: 'NotConfirmed', reason: 'FixtureBindingMismatch' };
    const [current, tamper, legacy] = input.verification.receipts;
    if (
      input.verification.receipts.length !== 3 ||
      current === undefined ||
      tamper === undefined ||
      legacy === undefined ||
      !receiptMatches(current, commands.current) ||
      !receiptMatches(tamper, commands.tamper) ||
      !receiptMatches(legacy, commands.legacy)
    ) {
      return { kind: 'NotConfirmed', reason: 'ReceiptPatternMismatch' };
    }
    if (input.verification.kind === 'Accepted') {
      return accepted(current) && accepted(tamper) && accepted(legacy)
        ? { kind: 'NotConfirmed', reason: 'H1Passed' }
        : { kind: 'NotConfirmed', reason: 'ReceiptPatternMismatch' };
    }
    if (
      accepted(current) &&
      accepted(tamper) &&
      legacy.outcome.kind === 'Rejected' &&
      legacy.outcome.reason.kind === 'UnexpectedExitCode' &&
      legacy.outcome.reason.expected === 0 &&
      legacy.outcome.reason.observed === 101
    ) {
      return {
        kind: 'Confirmed',
        category: {
          version: 1,
          taskId: input.task.taskId,
          taskRevisionSaid: input.task.revisionSaid,
          harnessRevisionSaid: input.harness.d,
          currentCommandSaid: commands.current.contentSaid,
          tamperCommandSaid: commands.tamper.contentSaid,
          legacyCommandSaid: commands.legacy.contentSaid,
          legacyObservedExitCode: 101,
        },
        verifierReceiptSaids: input.verification.receipts.map(({ d }) => d),
      };
    }
    return { kind: 'NotConfirmed', reason: 'ReceiptPatternMismatch' };
  }
}
