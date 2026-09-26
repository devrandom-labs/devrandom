import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SourceRepository } from '@devrandom/protocol';

import type { TaskRepositoryBinding, TaskRepositoryResolution } from '../application/user-tasks.js';

const executeFile = promisify(execFile);

export class GitTaskRepository implements TaskRepositoryBinding {
  readonly #workingDirectory: string;

  constructor(workingDirectory: string) {
    this.#workingDirectory = workingDirectory;
  }

  async resolve(source: SourceRepository): Promise<TaskRepositoryResolution> {
    let status: string;
    try {
      status = (
        await executeFile(
          'git',
          ['-C', this.#workingDirectory, 'status', '--porcelain=v1', '--untracked-files=normal'],
          { encoding: 'utf8' },
        )
      ).stdout;
    } catch {
      return { kind: 'Rejected', reason: 'RepositoryUnavailable' };
    }
    if (status.length !== 0) {
      return { kind: 'Rejected', reason: 'WorktreeDirty' };
    }

    try {
      const objectFormat = (
        await executeFile(
          'git',
          ['-C', this.#workingDirectory, 'rev-parse', '--show-object-format'],
          { encoding: 'utf8' },
        )
      ).stdout.trim();
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
        return { kind: 'Rejected', reason: 'RepositoryUnavailable' };
      }
      const reference = source.kind === 'currentHead' ? 'HEAD' : source.commit;
      const commit = (
        await executeFile(
          'git',
          ['-C', this.#workingDirectory, 'rev-parse', '--verify', `${reference}^{commit}`],
          { encoding: 'utf8' },
        )
      ).stdout.trim();
      const tree = (
        await executeFile(
          'git',
          ['-C', this.#workingDirectory, 'rev-parse', '--verify', `${commit}^{tree}`],
          { encoding: 'utf8' },
        )
      ).stdout.trim();
      const objectId = objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
      if (!objectId.test(commit) || !objectId.test(tree)) {
        return { kind: 'Rejected', reason: 'RepositoryUnavailable' };
      }
      return { kind: 'Resolved', repository: { objectFormat, commit, tree } };
    } catch {
      return { kind: 'Rejected', reason: 'CommitUnavailable' };
    }
  }
}
