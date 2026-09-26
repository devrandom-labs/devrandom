import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitRunWorktrees } from './git-run-worktree.js';

const executeFile = promisify(execFile);
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';

interface RepositoryFixture {
  readonly directory: string;
  readonly commit: string;
  readonly tree: string;
}

const temporaryDirectories: string[] = [];

async function git(directory: string, arguments_: readonly string[]): Promise<string> {
  const execution = await executeFile('git', arguments_, { cwd: directory, encoding: 'utf8' });
  return execution.stdout.trim();
}

async function repositoryFixture(root: string): Promise<RepositoryFixture> {
  const directory = join(root, 'repository');
  await mkdir(directory);
  await git(directory, ['init', '--initial-branch=main']);
  await git(directory, ['config', 'user.name', 'Run Worktree Test']);
  await git(directory, ['config', 'user.email', 'run-worktree@devrandom.example']);
  await writeFile(join(directory, 'task.txt'), 'accepted base\n');
  await git(directory, ['add', 'task.txt']);
  await git(directory, ['commit', '-m', 'Accepted base']);
  return {
    directory,
    commit: await git(directory, ['rev-parse', 'HEAD']),
    tree: await git(directory, ['rev-parse', 'HEAD^{tree}']),
  };
}

async function fixture(): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly repository: RepositoryFixture;
}> {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-run-worktree-'));
  temporaryDirectories.push(root);
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot, { mode: 0o700 });
  await chmod(stateRoot, 0o700);
  return { root, stateRoot, repository: await repositoryFixture(root) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('Git Run worktrees', () => {
  it('terminates an interrupted checkout before reporting preparation interruption', async () => {
    const { root, stateRoot, repository } = await fixture();
    const hookStarted = join(root, 'hook-started');
    const hookCompleted = join(root, 'hook-completed');
    const hook = join(repository.directory, '.git', 'hooks', 'post-checkout');
    await writeFile(
      hook,
      `#!/bin/sh\necho "$$" > '${hookStarted.replaceAll("'", "'\\''")}'\nsleep 2\necho completed > '${hookCompleted.replaceAll("'", "'\\''")}'\n`,
      { mode: 0o700 },
    );
    const cancellation = new AbortController();
    const preparation = new GitRunWorktrees().prepare(
      {
        stateRoot,
        repositoryDirectory: repository.directory,
        runId,
        repository: { objectFormat: 'sha1', commit: repository.commit, tree: repository.tree },
      },
      cancellation.signal,
    );
    await vi.waitFor(async () => {
      expect(await readFile(hookStarted, 'utf8')).toMatch(/^\d+\n$/u);
    });
    cancellation.abort();
    await expect(preparation).resolves.toEqual({ kind: 'Interrupted' });
    await expect(readFile(hookCompleted)).rejects.toMatchObject({ code: 'ENOENT' });
    const hookPid = Number((await readFile(hookStarted, 'utf8')).trim());
    await vi.waitFor(() => {
      expect(() => process.kill(hookPid, 0)).toThrow();
    });
  });

  it('creates the exact Run-owned worktree and reconciles only the same base binding', async () => {
    const { stateRoot, repository } = await fixture();
    const worktrees = new GitRunWorktrees();
    const input = {
      stateRoot,
      repositoryDirectory: repository.directory,
      runId,
      repository: {
        objectFormat: 'sha1' as const,
        commit: repository.commit,
        tree: repository.tree,
      },
    };

    const created = await worktrees.prepare(input, new AbortController().signal);
    const reconciled = await worktrees.prepare(input, new AbortController().signal);
    const worktreeDirectory = join(stateRoot, 'runs', runId, 'worktree');

    expect(created).toEqual({
      kind: 'Prepared',
      worktree: {
        directory: worktreeDirectory,
        branch: `devrandom/run/${runId}`,
        repository: input.repository,
      },
    });
    expect(reconciled).toEqual({
      kind: 'Reconciled',
      worktree: {
        directory: worktreeDirectory,
        branch: `devrandom/run/${runId}`,
        repository: input.repository,
      },
    });
    await expect(readFile(join(worktreeDirectory, 'task.txt'), 'utf8')).resolves.toBe(
      'accepted base\n',
    );
    await expect(git(worktreeDirectory, ['branch', '--show-current'])).resolves.toBe(
      `devrandom/run/${runId}`,
    );
    await expect(git(repository.directory, ['status', '--porcelain=v2', '-z'])).resolves.toBe('');
  });

  it('rejects an existing managed worktree whose branch moved from the admitted commit', async () => {
    const { stateRoot, repository } = await fixture();
    const worktrees = new GitRunWorktrees();
    const input = {
      stateRoot,
      repositoryDirectory: repository.directory,
      runId,
      repository: {
        objectFormat: 'sha1' as const,
        commit: repository.commit,
        tree: repository.tree,
      },
    };
    const prepared = await worktrees.prepare(input, new AbortController().signal);
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture worktree was not prepared');
    }
    await writeFile(join(prepared.worktree.directory, 'task.txt'), 'different revision\n');
    await git(prepared.worktree.directory, ['add', 'task.txt']);
    await git(prepared.worktree.directory, ['commit', '-m', 'Move managed branch']);

    await expect(worktrees.prepare(input, new AbortController().signal)).resolves.toEqual({
      kind: 'ManagedWorktreeConflict',
    });
  });

  it('does not reuse a detached branch name left outside the managed path', async () => {
    const { stateRoot, repository } = await fixture();
    await git(repository.directory, ['branch', `devrandom/run/${runId}`, repository.commit]);

    await expect(
      new GitRunWorktrees().prepare(
        {
          stateRoot,
          repositoryDirectory: repository.directory,
          runId,
          repository: {
            objectFormat: 'sha1',
            commit: repository.commit,
            tree: repository.tree,
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'ManagedWorktreeConflict' });
  });
});
