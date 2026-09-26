import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  PreparedRunWorktree,
  RunWorktreeInput,
  RunWorktreePreparation,
  RunWorktrees,
} from '../application/run-worktree.js';

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha1Pattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

type GitInvocation =
  { readonly kind: 'Completed'; readonly stdout: string } | { readonly kind: 'Failed' };

type ManagedPath =
  { readonly kind: 'Missing' } | { readonly kind: 'Directory' } | { readonly kind: 'Conflict' };

async function git(
  directory: string,
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<GitInvocation> {
  signal.throwIfAborted();
  return new Promise((resolveInvocation) => {
    const child = spawn('git', arguments_, {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let disposition: 'Running' | 'Failed' = 'Running';
    const terminate = (): void => {
      disposition = 'Failed';
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      // Joining the direct child must not wait on pipes inherited by an escaped child.
      child.stdout.destroy();
    };
    signal.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (disposition !== 'Running') return;
      byteLength += chunk.byteLength;
      if (byteLength > 1024 * 1024) {
        terminate();
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', terminate);
    child.on('error', terminate);
    child.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', terminate);
      resolveInvocation(
        disposition === 'Running' && code === 0 && terminationSignal === null
          ? { kind: 'Completed', stdout: Buffer.concat(chunks).toString('utf8').trim() }
          : { kind: 'Failed' },
      );
    });
  });
}

function repositoryInputIsValid(input: RunWorktreeInput): boolean {
  const objectPattern = input.repository.objectFormat === 'sha1' ? sha1Pattern : sha256Pattern;
  return (
    isAbsolute(input.stateRoot) &&
    isAbsolute(input.repositoryDirectory) &&
    runIdPattern.test(input.runId) &&
    objectPattern.test(input.repository.commit) &&
    objectPattern.test(input.repository.tree)
  );
}

async function managedPath(path: string): Promise<ManagedPath> {
  try {
    const status = await lstat(path);
    return status.isDirectory() && !status.isSymbolicLink()
      ? { kind: 'Directory' }
      : { kind: 'Conflict' };
  } catch {
    return { kind: 'Missing' };
  }
}

async function sameRepository(
  originalDirectory: string,
  candidateDirectory: string,
  signal: AbortSignal,
): Promise<boolean> {
  const [original, candidate] = await Promise.all([
    git(originalDirectory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
    git(candidateDirectory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
  ]);
  if (original.kind !== 'Completed' || candidate.kind !== 'Completed') {
    return false;
  }
  try {
    const [originalPath, candidatePath] = await Promise.all([
      realpath(resolve(originalDirectory, original.stdout)),
      realpath(resolve(candidateDirectory, candidate.stdout)),
    ]);
    return originalPath === candidatePath;
  } catch {
    return false;
  }
}

async function worktreeMatches(
  input: RunWorktreeInput,
  worktree: PreparedRunWorktree,
  signal: AbortSignal,
): Promise<boolean> {
  const [topLevel, branch, objectFormat, commit, tree, sharedRepository] = await Promise.all([
    git(worktree.directory, ['rev-parse', '--show-toplevel'], signal),
    git(worktree.directory, ['branch', '--show-current'], signal),
    git(worktree.directory, ['rev-parse', '--show-object-format'], signal),
    git(worktree.directory, ['rev-parse', 'HEAD'], signal),
    git(worktree.directory, ['rev-parse', 'HEAD^{tree}'], signal),
    sameRepository(input.repositoryDirectory, worktree.directory, signal),
  ]);
  if (
    topLevel.kind !== 'Completed' ||
    branch.kind !== 'Completed' ||
    objectFormat.kind !== 'Completed' ||
    commit.kind !== 'Completed' ||
    tree.kind !== 'Completed' ||
    !sharedRepository
  ) {
    return false;
  }
  try {
    return (
      (await realpath(topLevel.stdout)) === (await realpath(worktree.directory)) &&
      branch.stdout === worktree.branch &&
      objectFormat.stdout === worktree.repository.objectFormat &&
      commit.stdout === worktree.repository.commit &&
      tree.stdout === worktree.repository.tree
    );
  } catch {
    return false;
  }
}

async function repositoryMatches(input: RunWorktreeInput, signal: AbortSignal): Promise<boolean> {
  const [topLevel, objectFormat, commit, tree] = await Promise.all([
    git(input.repositoryDirectory, ['rev-parse', '--show-toplevel'], signal),
    git(input.repositoryDirectory, ['rev-parse', '--show-object-format'], signal),
    git(input.repositoryDirectory, ['rev-parse', `${input.repository.commit}^{commit}`], signal),
    git(input.repositoryDirectory, ['rev-parse', `${input.repository.commit}^{tree}`], signal),
  ]);
  if (
    topLevel.kind !== 'Completed' ||
    objectFormat.kind !== 'Completed' ||
    commit.kind !== 'Completed' ||
    tree.kind !== 'Completed'
  ) {
    return false;
  }
  try {
    return (
      (await realpath(topLevel.stdout)) === (await realpath(input.repositoryDirectory)) &&
      objectFormat.stdout === input.repository.objectFormat &&
      commit.stdout === input.repository.commit &&
      tree.stdout === input.repository.tree
    );
  } catch {
    return false;
  }
}

export class GitRunWorktrees implements RunWorktrees {
  async prepare(input: RunWorktreeInput, signal: AbortSignal): Promise<RunWorktreePreparation> {
    try {
      signal.throwIfAborted();
      const prepared = await this.#prepare(input, signal);
      signal.throwIfAborted();
      return prepared;
    } catch {
      return signal.aborted ? { kind: 'Interrupted' } : { kind: 'GitUnavailable' };
    }
  }

  async #prepare(input: RunWorktreeInput, signal: AbortSignal): Promise<RunWorktreePreparation> {
    if (!repositoryInputIsValid(input) || !(await repositoryMatches(input, signal))) {
      return { kind: 'RepositoryBindingRejected' };
    }
    const runDirectory = join(input.stateRoot, 'runs', input.runId);
    try {
      signal.throwIfAborted();
      await mkdir(runDirectory, { recursive: true, mode: 0o700 });
      const runDirectoryStatus = await lstat(runDirectory);
      if (
        !runDirectoryStatus.isDirectory() ||
        runDirectoryStatus.isSymbolicLink() ||
        (runDirectoryStatus.mode & 0o777) !== 0o700
      ) {
        return { kind: 'ManagedWorktreeConflict' };
      }
    } catch {
      return { kind: 'ManagedWorktreeConflict' };
    }
    const worktree: PreparedRunWorktree = {
      directory: join(runDirectory, 'worktree'),
      branch: `devrandom/run/${input.runId}`,
      repository: input.repository,
    };
    const existing = await managedPath(worktree.directory);
    if (existing.kind === 'Conflict') {
      return { kind: 'ManagedWorktreeConflict' };
    }
    if (existing.kind === 'Directory') {
      return (await worktreeMatches(input, worktree, signal))
        ? { kind: 'Reconciled', worktree }
        : { kind: 'ManagedWorktreeConflict' };
    }
    const branch = await git(
      input.repositoryDirectory,
      ['show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`],
      signal,
    );
    if (branch.kind === 'Completed') {
      return { kind: 'ManagedWorktreeConflict' };
    }
    const created = await git(
      input.repositoryDirectory,
      ['worktree', 'add', '-b', worktree.branch, worktree.directory, input.repository.commit],
      signal,
    );
    if (created.kind !== 'Completed') {
      return { kind: 'GitUnavailable' };
    }
    return (await worktreeMatches(input, worktree, signal))
      ? { kind: 'Prepared', worktree }
      : { kind: 'ManagedWorktreeConflict' };
  }
}
