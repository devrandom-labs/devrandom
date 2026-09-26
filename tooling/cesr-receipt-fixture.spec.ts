import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeCesrReceiptFixture } from './cesr-receipt-fixture.js';

const executeFile = promisify(execFile);
const roots: string[] = [];
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = join(repositoryRoot, 'fixtures', 'cesr-receipt-service');
const taskTemplate = join(repositoryRoot, 'fixtures', 'cesr-compat.task.json');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function commandStatus(workingDirectory: string, arguments_: readonly string[]) {
  try {
    await executeFile('cargo', arguments_, { cwd: workingDirectory, encoding: 'utf8' });
    return 0;
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      typeof cause.code === 'number' &&
      Number.isSafeInteger(cause.code)
    ) {
      return cause.code;
    }
    throw cause;
  }
}

describe('prepared CESR receipt fixture', () => {
  it('publishes a visible multi-payload legacy group with adjacent default restoration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-fixture-'));
    roots.push(root);
    const fixture = await materializeCesrReceiptFixture({
      templateRoot,
      taskTemplate,
      destination: join(root, 'worktree'),
    });
    const task: unknown = JSON.parse(await readFile(fixture.taskFile, 'utf8'));
    expect(task).toMatchObject({
      title: 'Repair CESR receipt group compatibility',
      objective:
        'Parse top-level short-count CESR groups containing multiple qualified payloads with group-local genus/version scope.',
    });
    await expect(readFile(join(fixture.worktree, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'A marker applies only within its own group; the next group returns to the default.',
    );
    await expect(readFile(join(fixture.worktree, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'After the first focused edit, call submit_result with the current work even if a public test fails; use verifier feedback for later revisions.',
    );
    await expect(readFile(join(fixture.worktree, 'src/lib.rs'), 'utf8')).resolves.toContain(
      'pub fn parse_receipt_stream(',
    );
    await expect(
      readFile(join(fixture.worktree, 'tests/legacy_compatibility.rs'), 'utf8'),
    ).resolves.toContain('legacy_group_contains_two_payloads_then_default_returns');
  });

  it('withholds the CLI model credential from fixture Git children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-fixture-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const git = join(bin, 'git');
    await writeFile(
      git,
      '#!/bin/sh\nif [ "${CONCENTRATE_API_KEY+x}" = x ]; then exit 91; fi\nexec /usr/bin/git "$@"\n',
    );
    await chmod(git, 0o755);
    const previousPath = process.env.PATH;
    const previousCredential = process.env.CONCENTRATE_API_KEY;
    process.env.PATH = `${bin}:${previousPath ?? '/usr/bin:/bin'}`;
    process.env.CONCENTRATE_API_KEY = 'credential-marker';
    try {
      await expect(
        materializeCesrReceiptFixture({
          templateRoot,
          taskTemplate,
          destination: join(root, 'worktree'),
        }),
      ).resolves.toMatchObject({ repository: { objectFormat: 'sha1' } });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCredential === undefined) delete process.env.CONCENTRATE_API_KEY;
      else process.env.CONCENTRATE_API_KEY = previousCredential;
    }
  });

  it('materializes the same pinned clean Git repository and exact Task contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-fixture-'));
    roots.push(root);
    const first = await materializeCesrReceiptFixture({
      templateRoot,
      taskTemplate,
      destination: join(root, 'first'),
    });
    const second = await materializeCesrReceiptFixture({
      templateRoot,
      taskTemplate,
      destination: join(root, 'second'),
    });

    expect(first.repository).toEqual({
      objectFormat: 'sha1',
      commit: '51cfb9d825c956c6b065af45096177359daad9b7',
      tree: '7bc0aad77828ce5b61ef901a61b34990b502267e',
    });
    expect(second.repository).toEqual(first.repository);
    await expect(
      executeFile('git', ['-C', first.worktree, 'status', '--porcelain=v1'], { encoding: 'utf8' }),
    ).resolves.toMatchObject({ stdout: '' });
    const source: unknown = JSON.parse(await readFile(first.taskFile, 'utf8'));
    expect(source).toMatchObject({
      version: 1,
      label: 'cesr-compat',
      budgets: { runsPerAdmittedUser: 6, hostedWorkRunsGlobally: 21 },
      repository: { kind: 'currentHead' },
      constraints: {
        protectedPaths: [],
      },
      completionConditions: [
        { id: 'cesr-current', argv: ['cargo', 'test', '--locked', '--test', 'cesr-current'] },
        { id: 'cesr-tamper', argv: ['cargo', 'test', '--locked', '--test', 'cesr-tamper'] },
        { id: 'cesr-legacy', argv: ['cargo', 'test', '--locked', '--test', 'cesr-legacy'] },
      ],
    });
  });

  it('passes current and tamper conditions while the exact legacy condition fails with Cargo 101', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-fixture-'));
    roots.push(root);
    const fixture = await materializeCesrReceiptFixture({
      templateRoot,
      taskTemplate,
      destination: join(root, 'worktree'),
    });

    await expect(commandStatus(fixture.worktree, ['fmt', '--check'])).resolves.toBe(0);
    await expect(
      commandStatus(fixture.worktree, [
        'clippy',
        '--locked',
        '--all-targets',
        '--',
        '-D',
        'warnings',
      ]),
    ).resolves.toBe(0);
    await expect(
      commandStatus(fixture.worktree, ['test', '--locked', '--test', 'cesr-current']),
    ).resolves.toBe(0);
    await expect(
      commandStatus(fixture.worktree, ['test', '--locked', '--test', 'cesr-tamper']),
    ).resolves.toBe(0);
    await expect(
      commandStatus(fixture.worktree, ['test', '--locked', '--test', 'cesr-legacy']),
    ).resolves.toBe(101);
  }, 30_000);

  it('keeps sequential public Cargo conditions inside the exact changed-file ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-fixture-'));
    roots.push(root);
    const fixture = await materializeCesrReceiptFixture({
      templateRoot,
      taskTemplate,
      destination: join(root, 'worktree'),
    });

    for (const [name, exitCode] of [
      ['cesr-current', 0],
      ['cesr-tamper', 0],
      ['cesr-legacy', 101],
    ] as const) {
      await expect(
        commandStatus(fixture.worktree, ['test', '--locked', '--test', name]),
      ).resolves.toBe(exitCode);
      const products = await readdir(join(fixture.worktree, 'target'), {
        recursive: true,
        withFileTypes: true,
      });
      expect(products.filter((product) => product.isFile()).length).toBeLessThanOrEqual(256);
    }
    await expect(
      executeFile(
        'git',
        ['-C', fixture.worktree, 'status', '--porcelain=v2', '--untracked-files=all'],
        { encoding: 'utf8' },
      ),
    ).resolves.toMatchObject({ stdout: '' });
  }, 30_000);
});
