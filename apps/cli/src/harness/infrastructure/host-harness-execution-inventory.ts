import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { HarnessEnvironmentCompatibility } from '@devrandom/domain';
import type { TaskProjection } from '@devrandom/protocol';

import type {
  HarnessExecutionInventory,
  HarnessExecutionInventoryOutcome,
} from '../application/baseline-harness-preparation.js';

const executeFile = promisify(execFile);
const piSdkVersion = '0.87.1';
const xstateVersion = '5.33.2';

/** Existing host execution binding for PRD02 and local non-OCI runs. */
export class HostHarnessExecutionInventory implements HarnessExecutionInventory {
  readonly #workingDirectory: string;

  constructor(workingDirectory: string) {
    this.#workingDirectory = workingDirectory;
  }

  async inspect(task: TaskProjection): Promise<HarnessExecutionInventoryOutcome> {
    const environmentCompatibility = await this.#environmentCompatibility();
    if (environmentCompatibility === undefined)
      return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
    const commandExecutables = [];
    for (const condition of [
      ...task.revision.completionConditions,
      ...(task.revision.toolCommands ?? []),
    ]) {
      const executableRealpath = await this.#resolveExecutable(condition.argv[0] ?? '');
      if (executableRealpath === undefined)
        return { kind: 'Rejected', reason: 'CommandExecutableUnavailable' };
      commandExecutables.push({ commandId: condition.id, executableRealpath });
    }
    return { kind: 'Inspected', environmentCompatibility, commandExecutables };
  }

  async #environmentCompatibility(): Promise<HarnessEnvironmentCompatibility | undefined> {
    if (
      (process.platform !== 'darwin' && process.platform !== 'linux') ||
      (process.arch !== 'arm64' && process.arch !== 'x64')
    ) {
      return undefined;
    }
    let versionOutput: string;
    try {
      versionOutput = (
        await executeFile('git', ['-c', 'core.fsmonitor=false', 'version'], {
          cwd: this.#workingDirectory,
          encoding: 'utf8',
          maxBuffer: 1_048_576,
        })
      ).stdout.trim();
    } catch {
      return undefined;
    }
    const match = /^git version ([0-9][A-Za-z0-9.+_-]*)$/u.exec(versionOutput);
    if (match?.[1] === undefined) return undefined;
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
        if (isAbsolute(resolved) && (await stat(resolved)).isFile()) return resolved;
      } catch {
        // Continue through the finite PATH snapshot captured for this inspection.
      }
    }
    return undefined;
  }
}
