import type { Run } from '@devrandom/domain';
import type { BaselineHarnessRevision, EvaluationExecutionProfile } from '@devrandom/protocol';
import {
  inspectRunExecutionProfileBinding,
  runInstructionPrompt,
  type RunExecutionProfileInspection,
} from '@devrandom/runtime';

import type { BaselineExecutionInputs } from './baseline-execution-inputs.js';
import type { PreparedRunWorktree } from './run-worktree.js';

export type LinuxRunProfilePreflight =
  | { readonly kind: 'Ready'; readonly executableRealpaths: readonly string[] }
  | {
      readonly kind: 'ProfileDrift';
      readonly reason:
        | 'HarnessBindingMismatch'
        | 'EnvironmentBindingMismatch'
        | 'ModelBindingMismatch'
        | 'ExecutableInventoryEmpty'
        | 'ExecutableInventoryInvalid'
        | Extract<RunExecutionProfileInspection, { readonly kind: 'Rejected' }>['reason'];
    };

/** Caller-facing exact H1/profile check before any contained Pi or native effect. */
export function inspectLinuxRunProfile(input: {
  readonly run: Run;
  readonly worktree: PreparedRunWorktree;
  readonly harness: BaselineHarnessRevision;
  readonly inputs: BaselineExecutionInputs;
  readonly profile: EvaluationExecutionProfile;
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
}): LinuxRunProfilePreflight {
  const { run, worktree, harness, profile } = input;
  if (
    run.binding.initialHarnessRevisionSaid !== harness.d ||
    input.inputs.harness.d !== harness.d ||
    worktree.branch !== `devrandom/run/${run.binding.runId}` ||
    worktree.repository.commit !== run.binding.repository.commit ||
    worktree.repository.tree !== run.binding.repository.tree
  )
    return { kind: 'ProfileDrift', reason: 'HarnessBindingMismatch' };
  if (
    harness.environmentCompatibility.operatingSystem !== 'linux' ||
    harness.environmentCompatibility.architecture !==
      (profile.architecture === 'aarch64' ? 'arm64' : 'x64')
  )
    return { kind: 'ProfileDrift', reason: 'EnvironmentBindingMismatch' };
  if (
    profile.modelProvider !== harness.modelCompatibility.provider ||
    profile.modelId !== harness.modelCompatibility.model ||
    profile.thinkingLevel !== harness.modelCompatibility.thinkingLevel ||
    profile.maximumOutputTokens !== harness.modelCompatibility.maximumOutputTokens
  )
    return { kind: 'ProfileDrift', reason: 'ModelBindingMismatch' };
  const inspected = inspectRunExecutionProfileBinding({
    profile,
    instructions: input.inputs.instructions,
    instructionResources: harness.repository.instructionResources,
    systemPrompt: runInstructionPrompt(input.inputs.instructions),
    taskPrompt: input.inputs.prompt,
    effectiveLimitsReceipt: input.effectiveLimitsReceipt,
    parentDeathCleanupReceipt: input.parentDeathCleanupReceipt,
    worktreeBranch: worktree.branch,
    run,
  });
  if (inspected.kind !== 'Compatible') return { kind: 'ProfileDrift', reason: inspected.reason };
  const executableRealpaths = [
    ...harness.completionCommands.map((command) => command.executableRealpath),
    ...(harness.toolCommands ?? []).map((command) => command.executableRealpath),
  ];
  if (executableRealpaths.length === 0)
    return { kind: 'ProfileDrift', reason: 'ExecutableInventoryEmpty' };
  if (executableRealpaths.some((path) => !path.startsWith('/') || path.includes('\u0000')))
    return { kind: 'ProfileDrift', reason: 'ExecutableInventoryInvalid' };
  return { kind: 'Ready', executableRealpaths: [...new Set(executableRealpaths)].sort() };
}
