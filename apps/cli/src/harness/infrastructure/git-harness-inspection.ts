import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { identifyHarnessInstruction, type TaskProjection } from '@devrandom/protocol';
import type { ProtectedCredentials } from '@devrandom/domain';

import type {
  BaselineHarnessInspection,
  BaselineHarnessInspectionOutcome,
  HarnessExecutionInventory,
} from '../application/baseline-harness-preparation.js';

const executeFile = promisify(execFile);
const maximumInstructionCount = 64;
const maximumInstructionBytes = 131_072;
const maximumTreeOutputBytes = 1_048_576;

type InspectionRejectionReason = Extract<
  BaselineHarnessInspectionOutcome,
  { readonly kind: 'Rejected' }
>['reason'];

class GitInspectionFailure extends Error {
  readonly reason: InspectionRejectionReason;

  constructor(reason: InspectionRejectionReason) {
    super(reason);
    this.name = 'GitInspectionFailure';
    this.reason = reason;
  }
}

export class GitHarnessInspection implements BaselineHarnessInspection {
  readonly #workingDirectory: string;
  readonly #executionInventory: HarnessExecutionInventory;

  constructor(workingDirectory: string, executionInventory: HarnessExecutionInventory) {
    this.#workingDirectory = workingDirectory;
    this.#executionInventory = executionInventory;
  }

  async inspect(
    task: TaskProjection,
    protectedCredentials: ProtectedCredentials,
  ): Promise<BaselineHarnessInspectionOutcome> {
    try {
      const status = await this.#gitText(['status', '--porcelain=v1', '--untracked-files=normal']);
      if (status.length !== 0) {
        return { kind: 'Rejected', reason: 'WorktreeDirty' };
      }
      const objectFormat = (await this.#gitText(['rev-parse', '--show-object-format'])).trim();
      const commit = (await this.#gitText(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const tree = (await this.#gitText(['rev-parse', '--verify', 'HEAD^{tree}'])).trim();
      if (
        objectFormat !== task.revision.repository.objectFormat ||
        commit !== task.revision.repository.commit ||
        tree !== task.revision.repository.tree
      ) {
        return { kind: 'Rejected', reason: 'RepositoryBindingChanged' };
      }
      const paths = await this.#instructionPaths(commit);
      const instructionResources = [];
      for (const path of paths) {
        if (protectedCredentials.inspect(utf8.encode(path)).kind === 'WithheldSecret') {
          return { kind: 'Rejected', reason: 'SecretDetected' };
        }
        const content = await this.#gitText(['show', `${commit}:${path}`], maximumInstructionBytes);
        if (protectedCredentials.inspect(utf8.encode(content)).kind === 'WithheldSecret') {
          return { kind: 'Rejected', reason: 'SecretDetected' };
        }
        if (content.startsWith('\uFEFF')) {
          return { kind: 'Rejected', reason: 'InstructionInvalid' };
        }
        const identified = identifyHarnessInstruction({ path, content });
        if (identified.kind === 'Rejected') {
          return { kind: 'Rejected', reason: 'InstructionInvalid' };
        }
        instructionResources.push(identified.resource);
      }
      const inventory = await this.#executionInventory.inspect(task);
      if (inventory.kind === 'Rejected') return inventory;
      const declaredCommands = [
        ...task.revision.completionConditions,
        ...(task.revision.toolCommands ?? []),
      ];
      if (
        inventory.commandExecutables.length !== declaredCommands.length ||
        inventory.commandExecutables.some(
          (entry, index) =>
            entry.commandId !== declaredCommands[index]?.id ||
            !entry.executableRealpath.startsWith('/') ||
            entry.executableRealpath.includes('\u0000'),
        )
      )
        return { kind: 'Rejected', reason: 'CommandExecutableUnavailable' };
      for (const { executableRealpath } of inventory.commandExecutables) {
        if (
          protectedCredentials.inspect(utf8.encode(executableRealpath)).kind === 'WithheldSecret'
        ) {
          return { kind: 'Rejected', reason: 'SecretDetected' };
        }
      }
      const finalStatus = await this.#gitText([
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ]);
      if (finalStatus.length !== 0) return { kind: 'Rejected', reason: 'WorktreeDirty' };
      const finalCommit = (await this.#gitText(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const finalTree = (await this.#gitText(['rev-parse', '--verify', 'HEAD^{tree}'])).trim();
      if (finalCommit !== commit || finalTree !== tree)
        return { kind: 'Rejected', reason: 'RepositoryBindingChanged' };
      return {
        kind: 'Inspected',
        snapshot: {
          repository: {
            objectFormat,
            commit,
            tree,
            instructionResources,
          },
          commandExecutables: inventory.commandExecutables,
          environmentCompatibility: inventory.environmentCompatibility,
        },
      };
    } catch (cause) {
      return {
        kind: 'Rejected',
        reason: cause instanceof GitInspectionFailure ? cause.reason : 'RepositoryUnavailable',
      };
    }
  }

  async #instructionPaths(commit: string): Promise<readonly string[]> {
    const output = await this.#gitText(
      ['ls-tree', '-r', '-z', '--name-only', commit],
      maximumTreeOutputBytes,
    );
    const paths = output
      .split('\u0000')
      .filter((path) => path === 'AGENTS.md' || path.endsWith('/AGENTS.md'))
      .sort(compareUtf8);
    if (paths.length > maximumInstructionCount) {
      throw new GitInspectionFailure('InstructionInventoryTooLarge');
    }
    return paths;
  }

  async #gitText(
    arguments_: readonly string[],
    maxBuffer = maximumTreeOutputBytes,
  ): Promise<string> {
    let stdout: string;
    try {
      stdout = (
        await executeFile(
          'git',
          ['-c', 'core.fsmonitor=false', '-C', this.#workingDirectory, ...arguments_],
          {
            encoding: 'utf8',
            maxBuffer,
          },
        )
      ).stdout;
    } catch {
      throw new GitInspectionFailure('RepositoryUnavailable');
    }
    if (stdout.includes('\uFFFD')) {
      throw new GitInspectionFailure('InstructionInvalid');
    }
    return stdout;
  }
}

const utf8 = new TextEncoder();

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte !== undefined && rightByte !== undefined && leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}
