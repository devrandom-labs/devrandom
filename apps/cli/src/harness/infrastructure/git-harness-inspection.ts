import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { identifyHarnessInstruction, type TaskProjection } from '@devrandom/protocol';
import type { HarnessEnvironmentCompatibility, ProtectedCredentials } from '@devrandom/domain';

import type {
  BaselineHarnessInspection,
  BaselineHarnessInspectionOutcome,
} from '../application/baseline-harness-preparation.js';

const executeFile = promisify(execFile);
const maximumInstructionCount = 64;
const maximumInstructionBytes = 131_072;
const maximumTreeOutputBytes = 1_048_576;
const piSdkVersion = '0.87.1';
const xstateVersion = '5.33.2';

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

  constructor(workingDirectory: string) {
    this.#workingDirectory = workingDirectory;
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
      const environmentCompatibility = await this.#environmentCompatibility();
      if (environmentCompatibility === undefined) {
        return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
      }
      const commandExecutables = [];
      for (const condition of [
        ...task.revision.completionConditions,
        ...(task.revision.toolCommands ?? []),
      ]) {
        const executableRealpath = await this.#resolveExecutable(condition.argv[0] ?? '');
        if (executableRealpath === undefined) {
          return { kind: 'Rejected', reason: 'CommandExecutableUnavailable' };
        }
        if (
          protectedCredentials.inspect(utf8.encode(executableRealpath)).kind === 'WithheldSecret'
        ) {
          return { kind: 'Rejected', reason: 'SecretDetected' };
        }
        commandExecutables.push({ commandId: condition.id, executableRealpath });
      }
      return {
        kind: 'Inspected',
        snapshot: {
          repository: {
            objectFormat,
            commit,
            tree,
            instructionResources,
          },
          commandExecutables,
          environmentCompatibility,
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

  async #environmentCompatibility(): Promise<HarnessEnvironmentCompatibility | undefined> {
    if (
      (process.platform !== 'darwin' && process.platform !== 'linux') ||
      (process.arch !== 'arm64' && process.arch !== 'x64')
    ) {
      return undefined;
    }
    const versionOutput = (await this.#gitText(['version'])).trim();
    const match = /^git version ([0-9][A-Za-z0-9.+_-]*)$/u.exec(versionOutput);
    if (match?.[1] === undefined) {
      return undefined;
    }
    return {
      operatingSystem: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
      gitVersion: match[1],
      piSdkVersion,
      xstateVersion,
    };
  }

  async #resolveExecutable(command: string): Promise<string | undefined> {
    const candidates = command.includes('/')
      ? [resolve(this.#workingDirectory, command)]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) =>
            resolve(directory.length === 0 ? this.#workingDirectory : directory, command),
          );
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        const resolved = await realpath(candidate);
        if (isAbsolute(resolved) && (await stat(resolved)).isFile()) {
          return resolved;
        }
      } catch {
        // Continue through the finite PATH snapshot captured for this inspection.
      }
    }
    return undefined;
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
