import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { BaselineHarnessRevision, TaskProjection } from '@devrandom/protocol';

import { inspectLinuxH1PreLease } from '../application/linux-h1-prelease.js';
import type { LinuxH1ProfileBundle } from './linux-h1-profile-file.js';

const runFile = promisify(execFile);
const maximumInstructionBytes = 131_072;
function safeInstructionPath(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return (
    (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/** Re-reads the admitted source's instruction bytes immediately before the Run lease. */
export class GitLinuxH1PreLease {
  readonly #workingDirectory: string;
  readonly #bundle: LinuxH1ProfileBundle;

  constructor(workingDirectory: string, bundle: LinuxH1ProfileBundle) {
    this.#workingDirectory = workingDirectory;
    this.#bundle = bundle;
  }

  async verify(
    task: TaskProjection,
    harness: BaselineHarnessRevision,
  ): Promise<{ readonly kind: 'Compatible' | 'Rejected' }> {
    try {
      const read = async (arguments_: readonly string[], maxBuffer = 4096): Promise<string> => {
        const result = await runFile(
          'git',
          ['-c', 'core.fsmonitor=false', '-C', this.#workingDirectory, ...arguments_],
          { encoding: 'utf8', maxBuffer },
        );
        return result.stdout;
      };
      const [head, tree, status] = await Promise.all([
        read(['rev-parse', '--verify', 'HEAD^{commit}']),
        read(['rev-parse', '--verify', 'HEAD^{tree}']),
        read(['status', '--porcelain=v1', '--untracked-files=normal']),
      ]);
      if (
        head.trim() !== task.revision.repository.commit ||
        tree.trim() !== task.revision.repository.tree ||
        status !== '' ||
        harness.repository.instructionResources.length > 64 ||
        harness.repository.instructionResources.some(
          (resource) => !safeInstructionPath(resource.path),
        )
      )
        return { kind: 'Rejected' };
      const instructions = [];
      for (const resource of harness.repository.instructionResources) {
        const content = await read(
          ['show', `${head.trim()}:${resource.path}`],
          maximumInstructionBytes,
        );
        if (content.startsWith('\uFEFF')) return { kind: 'Rejected' };
        instructions.push({ path: resource.path, content });
      }
      const result = inspectLinuxH1PreLease({
        task,
        harness,
        profile: this.#bundle.profile,
        instructions,
        limits: this.#bundle.effectiveLimitsReceipt,
        cleanup: this.#bundle.parentDeathCleanupReceipt,
        cargoRealpath: this.#bundle.cargoRealpath,
      });
      if (result.kind !== 'Compatible') return result;
      const [finalHead, finalTree, finalStatus] = await Promise.all([
        read(['rev-parse', '--verify', 'HEAD^{commit}']),
        read(['rev-parse', '--verify', 'HEAD^{tree}']),
        read(['status', '--porcelain=v1', '--untracked-files=normal']),
      ]);
      return finalHead === head && finalTree === tree && finalStatus === ''
        ? { kind: 'Compatible' }
        : { kind: 'Rejected' };
    } catch {
      return { kind: 'Rejected' };
    }
  }
}
