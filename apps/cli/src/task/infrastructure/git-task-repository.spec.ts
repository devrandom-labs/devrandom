import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { GitTaskRepository } from './git-task-repository.js';

const executeFile = promisify(execFile);
const directories: string[] = [];

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-task-git-'));
  directories.push(directory);
  await executeFile('git', ['init', '--quiet', directory]);
  await executeFile('git', ['-C', directory, 'config', 'user.name', 'Task Test']);
  await executeFile('git', ['-C', directory, 'config', 'user.email', 'task@example.test']);
  await writeFile(join(directory, 'README.md'), 'prepared task repository\n', 'utf8');
  await executeFile('git', ['-C', directory, 'add', 'README.md']);
  await executeFile('git', ['-C', directory, 'commit', '--quiet', '-m', 'fixture']);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Git Task repository inspection', () => {
  it('resolves a clean current HEAD to its exact commit, tree, and object format', async () => {
    const directory = await repository();
    const expectedCommit = (
      await executeFile('git', ['-C', directory, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const expectedTree = (
      await executeFile('git', ['-C', directory, 'rev-parse', 'HEAD^{tree}'])
    ).stdout.trim();

    await expect(
      new GitTaskRepository(directory).resolve({ kind: 'currentHead' }),
    ).resolves.toEqual({
      kind: 'Resolved',
      repository: { objectFormat: 'sha1', commit: expectedCommit, tree: expectedTree },
    });
  });

  it('rejects a dirty worktree before resolving a requested commit', async () => {
    const directory = await repository();
    const commit = (await executeFile('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(directory, 'README.md'), 'dirty\n', 'utf8');

    await expect(
      new GitTaskRepository(directory).resolve({ kind: 'gitCommit', commit }),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'WorktreeDirty' });
  });
});
