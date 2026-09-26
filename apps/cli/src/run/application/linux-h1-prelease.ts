import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvaluationExecutionProfile,
  identifyHarnessCompletionCommand,
  identifyHarnessToolCommand,
  prepareEvidenceArtifact,
  type BaselineHarnessRevision,
  type EvaluationExecutionProfile,
  type TaskProjection,
} from '@devrandom/protocol';
import {
  digestRunRuntimePrompt,
  identifyRunH1InstructionInventory,
  inspectRunParentDeathCleanupReceipt,
  runInstructionPrompt,
} from '@devrandom/runtime';

import { baselineTaskPrompt, type MaterializedInstruction } from './baseline-execution-inputs.js';

export interface LinuxH1PreLeaseInput {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly profile: EvaluationExecutionProfile;
  readonly instructions: readonly MaterializedInstruction[];
  readonly limits: Uint8Array;
  readonly cleanup: Uint8Array;
  readonly cargoRealpath: string;
}

function artifactSaid(bytes: Uint8Array): string | undefined {
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  return prepared.kind === 'Prepared' ? prepared.artifact.d : undefined;
}

/** Exact H1/profile binding that must hold before any Run lease is requested. */
export function inspectLinuxH1PreLease(
  input: LinuxH1PreLeaseInput,
): { readonly kind: 'Compatible' } | { readonly kind: 'Rejected' } {
  const { task, harness, profile } = input;
  if (decodeEvaluationExecutionProfile(profile).kind !== 'Accepted') return { kind: 'Rejected' };
  const completions = task.revision.completionConditions;
  const tools = task.revision.toolCommands ?? [];
  if (
    task.lifecycle.kind !== 'Open' ||
    task.revision.repository.objectFormat !== 'sha1' ||
    harness.repository.objectFormat !== 'sha1' ||
    harness.task.taskId !== task.taskId ||
    harness.task.revisionSaid !== task.revisionSaid ||
    harness.task.harnessLineageId !== task.harnessLineageId ||
    harness.repository.commit !== task.revision.repository.commit ||
    harness.repository.tree !== task.revision.repository.tree ||
    profile.sourceGitCommit !== task.revision.repository.commit ||
    profile.sourceGitTree !== task.revision.repository.tree ||
    harness.environmentCompatibility.operatingSystem !== 'linux' ||
    harness.environmentCompatibility.architecture !==
      (profile.architecture === 'aarch64' ? 'arm64' : 'x64') ||
    harness.modelCompatibility.provider !== profile.modelProvider ||
    harness.modelCompatibility.model !== profile.modelId ||
    harness.modelCompatibility.thinkingLevel !== profile.thinkingLevel ||
    harness.modelCompatibility.maximumOutputTokens !== profile.maximumOutputTokens ||
    input.cargoRealpath !==
      `/usr/local/rustup/toolchains/1.98.1-${profile.architecture}-unknown-linux-gnu/bin/cargo` ||
    completions.length === 0 ||
    harness.completionCommands.length !== completions.length ||
    (harness.toolCommands ?? []).length !== tools.length ||
    harness.completionCommands.some((command, index) => {
      const declared = completions[index];
      const identified =
        declared === undefined
          ? undefined
          : identifyHarnessCompletionCommand(declared, input.cargoRealpath);
      return (
        declared === undefined ||
        declared.argv[0] !== 'cargo' ||
        identified?.kind !== 'Identified' ||
        !isDeepStrictEqual(command, identified.command)
      );
    }) ||
    (harness.toolCommands ?? []).some((command, index) => {
      const declared = tools[index];
      const identified =
        declared === undefined
          ? undefined
          : identifyHarnessToolCommand(declared, input.cargoRealpath);
      return (
        declared === undefined ||
        declared.argv[0] !== 'cargo' ||
        identified?.kind !== 'Identified' ||
        !isDeepStrictEqual(command, identified.command)
      );
    })
  )
    return { kind: 'Rejected' };
  const inventory = identifyRunH1InstructionInventory(
    input.instructions,
    harness.repository.instructionResources,
  );
  if (
    inventory === undefined ||
    artifactSaid(inventory) !== profile.h1InstructionSaid ||
    digestRunRuntimePrompt(runInstructionPrompt(input.instructions), baselineTaskPrompt(task)) !==
      profile.h1RuntimePromptDigest ||
    artifactSaid(input.limits) !== profile.effectiveLimitsReceiptSaid ||
    !inspectRunParentDeathCleanupReceipt(profile, input.cleanup)
  )
    return { kind: 'Rejected' };
  return { kind: 'Compatible' };
}
