import type { ProtectedCredentials } from '@devrandom/domain';
import {
  identifyHarnessInstruction,
  type BaselineHarnessRevision,
  type TaskProjection,
} from '@devrandom/protocol';

import type { PreparedRunWorktree } from './run-worktree.js';

export interface MaterializedInstruction {
  readonly path: string;
  readonly content: string;
}

export type ManagedWorktreeInstructionInspection =
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'Inspected'; readonly instructions: readonly MaterializedInstruction[] }
  | { readonly kind: 'RepositoryBindingMismatch' }
  | { readonly kind: 'InventoryMismatch' }
  | { readonly kind: 'InventoryLimitExceeded' }
  | { readonly kind: 'UnsafeInstructionPath'; readonly path: string }
  | { readonly kind: 'InstructionUnavailable'; readonly path: string }
  | { readonly kind: 'InstructionContentLimitExceeded'; readonly path: string }
  | { readonly kind: 'InstructionEncodingInvalid'; readonly path: string }
  | { readonly kind: 'RepositoryUnavailable' };

export interface ManagedWorktreeInstructions {
  inspect(
    input: {
      readonly worktree: PreparedRunWorktree;
      readonly expectedPaths: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ManagedWorktreeInstructionInspection>;
}

export interface BaselineExecutionInputs {
  readonly worktree: string;
  readonly harness: BaselineHarnessRevision;
  readonly instructions: readonly MaterializedInstruction[];
  readonly prompt: string;
}

export type BaselineExecutionInputMaterialization =
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'Materialized'; readonly inputs: BaselineExecutionInputs }
  | { readonly kind: 'BindingRejected' }
  | { readonly kind: 'InstructionInventoryMismatch' }
  | { readonly kind: 'InstructionInventoryLimitExceeded' }
  | { readonly kind: 'UnsafeInstructionPath'; readonly path: string }
  | { readonly kind: 'InstructionUnavailable'; readonly path: string }
  | { readonly kind: 'InstructionContentLimitExceeded'; readonly path: string }
  | { readonly kind: 'InstructionEncodingInvalid'; readonly path: string }
  | { readonly kind: 'InstructionContentMismatch'; readonly path: string }
  | { readonly kind: 'InstructionIdentificationFailed'; readonly path: string }
  | { readonly kind: 'PromptLimitExceeded' }
  | { readonly kind: 'RepositoryUnavailable' };

export interface BaselineExecutionInputMaterializerDependencies {
  readonly instructions: ManagedWorktreeInstructions;
  readonly protectedCredentials: ProtectedCredentials;
}

const maximumPromptBytes = 262_144;
const utf8 = new TextEncoder();

function repositoryMatches(
  task: TaskProjection,
  harness: BaselineHarnessRevision,
  worktree: PreparedRunWorktree,
): boolean {
  return (
    task.lifecycle.kind === 'Open' &&
    task.taskId === harness.task.taskId &&
    task.revisionSaid === harness.task.revisionSaid &&
    task.harnessLineageId === harness.task.harnessLineageId &&
    task.revision.repository.objectFormat === harness.repository.objectFormat &&
    task.revision.repository.commit === harness.repository.commit &&
    task.revision.repository.tree === harness.repository.tree &&
    worktree.repository.objectFormat === harness.repository.objectFormat &&
    worktree.repository.commit === harness.repository.commit &&
    worktree.repository.tree === harness.repository.tree
  );
}

function deliverableLine(
  deliverable: TaskProjection['revision']['deliverables'][number],
  index: number,
): string {
  switch (deliverable.kind) {
    case 'repositoryFile':
      return `${String(index + 1)}. repositoryFile id=${JSON.stringify(deliverable.id)} path=${JSON.stringify(deliverable.path)}`;
    case 'namedResult':
      return `${String(index + 1)}. namedResult id=${JSON.stringify(deliverable.id)} name=${JSON.stringify(deliverable.name)} description=${JSON.stringify(deliverable.description)}`;
  }
}

function completionConditionLine(
  condition: TaskProjection['revision']['completionConditions'][number],
  index: number,
): string {
  return `${String(index + 1)}. id=${JSON.stringify(condition.id)} argv=${JSON.stringify(condition.argv)} timeoutSeconds=${String(condition.timeoutSeconds)} expectedExitCode=${String(condition.expected.code)}`;
}

function taskPrompt(task: TaskProjection): string {
  return [
    'Devrandom baseline Task',
    `Task ID: ${task.taskId}`,
    `Task Revision SAID: ${task.revisionSaid}`,
    `Title: ${JSON.stringify(task.revision.title)}`,
    `Objective: ${JSON.stringify(task.revision.objective)}`,
    'Deliverables (ordered):',
    ...task.revision.deliverables.map(deliverableLine),
    'Completion conditions (ordered; executed by the parent verifier):',
    ...task.revision.completionConditions.map(completionConditionLine),
    ...(task.revision.toolCommands === undefined
      ? []
      : [
          'Declared tool commands (ordered; separate from completion conditions):',
          ...task.revision.toolCommands.map((command, index) => {
            const tool =
              command.capability === 'RunFormatter' ? 'run_formatter' : 'run_static_analysis';
            return `${String(index + 1)}. tool=${tool} id=${JSON.stringify(command.id)} argv=${JSON.stringify(command.argv)} timeoutSeconds=${String(command.timeoutSeconds)} expectedExitCode=${String(command.expected.code)}`;
          }),
        ]),
    'Constraints:',
    `dataPolicy=${JSON.stringify(task.revision.constraints.dataPolicy)}`,
    `protectedPaths=${JSON.stringify(task.revision.constraints.protectedPaths)}`,
    `prohibitedEffects=${JSON.stringify(task.revision.constraints.prohibitedEffects)}`,
    'Work only inside the managed worktree. Use only the provided tools. Report completion with submit_result; the parent verifier, not model prose, determines acceptance.',
    'After your first focused code change, call submit_result with the current work even if a public check still fails. The trusted verifier runs the completion conditions and returns feedback; revise and resubmit if rejected while the Run budget permits. Submit only locally recorded output artifact SAIDs, or [] if none.',
  ].join('\n');
}

export class BaselineExecutionInputMaterializer {
  readonly #dependencies: BaselineExecutionInputMaterializerDependencies;

  constructor(dependencies: BaselineExecutionInputMaterializerDependencies) {
    this.#dependencies = dependencies;
  }

  async materialize(
    input: {
      readonly task: TaskProjection;
      readonly harness: BaselineHarnessRevision;
      readonly worktree: PreparedRunWorktree;
    },
    signal: AbortSignal,
  ): Promise<BaselineExecutionInputMaterialization> {
    const expected = input.harness.repository.instructionResources;
    let inspection: ManagedWorktreeInstructionInspection;
    try {
      signal.throwIfAborted();
      if (
        this.#dependencies.protectedCredentials.inspect(utf8.encode(JSON.stringify(input))).kind ===
        'WithheldSecret'
      ) {
        return { kind: 'SecretDetected' };
      }
      if (!repositoryMatches(input.task, input.harness, input.worktree)) {
        return { kind: 'BindingRejected' };
      }
      inspection = await this.#dependencies.instructions.inspect(
        {
          worktree: input.worktree,
          expectedPaths: expected.map(({ path }) => path),
        },
        signal,
      );
      signal.throwIfAborted();
    } catch {
      return signal.aborted ? { kind: 'Interrupted' } : { kind: 'RepositoryUnavailable' };
    }
    if (
      this.#dependencies.protectedCredentials.inspect(utf8.encode(JSON.stringify(inspection)))
        .kind === 'WithheldSecret'
    ) {
      return { kind: 'SecretDetected' };
    }
    switch (inspection.kind) {
      case 'Interrupted':
        return inspection;
      case 'RepositoryBindingMismatch':
        return { kind: 'BindingRejected' };
      case 'InventoryMismatch':
        return { kind: 'InstructionInventoryMismatch' };
      case 'InventoryLimitExceeded':
        return { kind: 'InstructionInventoryLimitExceeded' };
      case 'UnsafeInstructionPath':
      case 'InstructionUnavailable':
      case 'InstructionContentLimitExceeded':
      case 'InstructionEncodingInvalid':
      case 'RepositoryUnavailable':
        return inspection;
      case 'Inspected':
        break;
    }
    if (inspection.instructions.length !== expected.length) {
      return { kind: 'InstructionInventoryMismatch' };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const resource = expected[index];
      const instruction = inspection.instructions[index];
      if (
        resource === undefined ||
        instruction === undefined ||
        resource.path !== instruction.path
      ) {
        return { kind: 'InstructionInventoryMismatch' };
      }
      const identified = identifyHarnessInstruction(instruction);
      if (identified.kind === 'Rejected') {
        return { kind: 'InstructionIdentificationFailed', path: instruction.path };
      }
      if (identified.resource.contentSaid !== resource.contentSaid) {
        return { kind: 'InstructionContentMismatch', path: instruction.path };
      }
    }
    const prompt = taskPrompt(input.task);
    if (
      this.#dependencies.protectedCredentials.inspect(utf8.encode(prompt)).kind === 'WithheldSecret'
    ) {
      return { kind: 'SecretDetected' };
    }
    if (utf8.encode(prompt).byteLength > maximumPromptBytes) {
      return { kind: 'PromptLimitExceeded' };
    }
    return {
      kind: 'Materialized',
      inputs: {
        worktree: input.worktree.directory,
        harness: input.harness,
        instructions: inspection.instructions,
        prompt,
      },
    };
  }
}
