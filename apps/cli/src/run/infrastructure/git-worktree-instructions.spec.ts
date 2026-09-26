import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtectedCredentials } from '@devrandom/domain';
import { identifyHarnessInstruction } from '@devrandom/protocol';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { BaselineExecutionInputMaterializer } from '../application/baseline-execution-inputs.js';
import type { PreparedRunWorktree } from '../application/run-worktree.js';
import { GitWorktreeInstructions } from './git-worktree-instructions.js';

const executeFile = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository(): Promise<{
  readonly path: string;
  readonly worktree: PreparedRunWorktree;
}> {
  const path = await mkdtemp(join(tmpdir(), 'devrandom-execution-inputs-'));
  directories.push(path);
  await mkdir(join(path, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(path, 'AGENTS.md'), '# Root instructions\n'),
    writeFile(join(path, 'src', 'AGENTS.md'), '# Source instructions\n'),
    writeFile(join(path, 'src', 'index.ts'), 'export const value = 1;\n'),
  ]);
  for (const arguments_ of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Devrandom Test'],
    ['config', 'user.email', 'test@devrandom.example'],
    ['add', '.'],
    ['commit', '-m', 'baseline'],
  ]) {
    await executeFile('git', arguments_, { cwd: path });
  }
  const commit = (await executeFile('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  const tree = (
    await executeFile('git', ['rev-parse', `${commit}^{tree}`], { cwd: path })
  ).stdout.trim();
  return {
    path,
    worktree: {
      directory: path,
      branch: 'devrandom/run/1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      repository: { objectFormat: 'sha1', commit, tree },
    },
  };
}

describe('Git managed-worktree instruction inspection', () => {
  it('withholds a credential introduced into real instruction bytes before content comparison', async () => {
    const fixture = await repository();
    const secret = 'opaque-worktree-instruction-fixture-465378';
    const resources = [
      { path: 'AGENTS.md', content: '# Root instructions\n' },
      { path: 'src/AGENTS.md', content: '# Source instructions\n' },
    ].map((instruction) => {
      const identified = identifyHarnessInstruction(instruction);
      if (identified.kind !== 'Identified') throw new Error('fixture instruction must identify');
      return identified.resource;
    });
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    await writeFile(join(fixture.path, 'src', 'AGENTS.md'), secret);

    const outcome = await new BaselineExecutionInputMaterializer({
      protectedCredentials: new ProtectedCredentials([secret]),
      instructions: new GitWorktreeInstructions(),
    }).materialize(
      {
        task: { ...task, revision: { ...task.revision, repository: fixture.worktree.repository } },
        harness: {
          ...harness,
          repository: { ...fixture.worktree.repository, instructionResources: resources },
        },
        worktree: fixture.worktree,
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'SecretDetected' });
    await expect(readFile(join(fixture.path, 'src', 'AGENTS.md'), 'utf8')).resolves.toBe(secret);
  });

  it('terminates and joins an interrupted Git inspection subprocess', async () => {
    const fixture = await repository();
    const executableDirectory = join(fixture.path, 'executables');
    await mkdir(executableDirectory);
    const started = join(fixture.path, 'inspection-started');
    const completed = join(fixture.path, 'inspection-completed');
    await writeFile(
      join(executableDirectory, 'git'),
      `#!/bin/sh\necho "$$" > '${started.replaceAll("'", "'\\''")}'\nsleep 2\necho completed > '${completed.replaceAll("'", "'\\''")}'\nexit 1\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', `${executableDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`);
    const cancellation = new AbortController();
    const inspection = new GitWorktreeInstructions().inspect(
      { worktree: fixture.worktree, expectedPaths: ['AGENTS.md', 'src/AGENTS.md'] },
      cancellation.signal,
    );
    await vi.waitFor(async () => {
      expect(await readFile(started, 'utf8')).toMatch(/^\d+\n$/u);
    });
    cancellation.abort();
    await expect(inspection).resolves.toEqual({ kind: 'Interrupted' });
    await expect(readFile(completed)).rejects.toMatchObject({ code: 'ENOENT' });
    const pid = Number((await readFile(started, 'utf8')).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('loads only the exact ordered AGENTS resources from the bound worktree', async () => {
    const fixture = await repository();

    await expect(
      new GitWorktreeInstructions().inspect(
        {
          worktree: fixture.worktree,
          expectedPaths: ['AGENTS.md', 'src/AGENTS.md'],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'Inspected',
      instructions: [
        { path: 'AGENTS.md', content: '# Root instructions\n' },
        { path: 'src/AGENTS.md', content: '# Source instructions\n' },
      ],
    });
  });

  it('rejects missing and extra instruction files before constructing Pi inputs', async () => {
    const missing = await repository();
    await unlink(join(missing.path, 'AGENTS.md'));
    await expect(
      new GitWorktreeInstructions().inspect(
        {
          worktree: missing.worktree,
          expectedPaths: ['AGENTS.md', 'src/AGENTS.md'],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'InstructionUnavailable', path: 'AGENTS.md' });

    const extra = await repository();
    await mkdir(join(extra.path, 'nested'));
    await writeFile(join(extra.path, 'nested', 'AGENTS.md'), '# Uncommitted extra\n');
    await expect(
      new GitWorktreeInstructions().inspect(
        {
          worktree: extra.worktree,
          expectedPaths: ['AGENTS.md', 'src/AGENTS.md'],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'InventoryMismatch' });
  });

  it('does not follow an instruction parent symlink outside the managed worktree', async () => {
    const fixture = await repository();
    const outside = await mkdtemp(join(tmpdir(), 'devrandom-instruction-escape-'));
    directories.push(outside);
    await writeFile(join(outside, 'AGENTS.md'), '# Outside secret instructions\n');
    await rm(join(fixture.path, 'src'), { recursive: true });
    await symlink(outside, join(fixture.path, 'src'));

    const outcome = await new GitWorktreeInstructions().inspect(
      {
        worktree: fixture.worktree,
        expectedPaths: ['AGENTS.md', 'src/AGENTS.md'],
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'UnsafeInstructionPath', path: 'src/AGENTS.md' });
    await expect(readFile(join(outside, 'AGENTS.md'), 'utf8')).resolves.toBe(
      '# Outside secret instructions\n',
    );
  });

  it('rejects a physical repository whose HEAD no longer matches the admitted binding', async () => {
    const fixture = await repository();
    await writeFile(join(fixture.path, 'new.txt'), 'new commit\n');
    await executeFile('git', ['add', 'new.txt'], { cwd: fixture.path });
    await executeFile('git', ['commit', '-m', 'different head'], { cwd: fixture.path });

    await expect(
      new GitWorktreeInstructions().inspect(
        {
          worktree: fixture.worktree,
          expectedPaths: ['AGENTS.md', 'src/AGENTS.md'],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'RepositoryBindingMismatch' });
  });
});
