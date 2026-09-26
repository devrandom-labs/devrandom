import { execFile } from 'node:child_process';
import { cp, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export interface CesrReceiptFixtureMaterialization {
  readonly worktree: string;
  readonly taskFile: string;
  readonly repository: {
    readonly objectFormat: 'sha1';
    readonly commit: string;
    readonly tree: string;
  };
}

export interface CesrReceiptFixtureSource {
  readonly templateRoot: string;
  readonly taskTemplate: string;
  readonly destination: string;
}

async function pathDisposition(path: string): Promise<'Absent' | 'Present'> {
  try {
    await lstat(path);
    return 'Present';
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return 'Absent';
    }
    throw cause;
  }
}

async function git(worktree: string, arguments_: readonly string[]): Promise<string> {
  return (
    await executeFile('git', ['-C', worktree, ...arguments_], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Devrandom Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@devrandom.local',
        GIT_AUTHOR_DATE: '2026-09-24T00:00:00Z',
        GIT_COMMITTER_NAME: 'Devrandom Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@devrandom.local',
        GIT_COMMITTER_DATE: '2026-09-24T00:00:00Z',
      },
    })
  ).stdout.trim();
}

export async function materializeCesrReceiptFixture(
  source: CesrReceiptFixtureSource,
): Promise<CesrReceiptFixtureMaterialization> {
  const worktree = resolve(source.destination);
  const taskFile = `${worktree}.task.json`;
  if (
    (await pathDisposition(worktree)) !== 'Absent' ||
    (await pathDisposition(taskFile)) !== 'Absent'
  ) {
    throw new Error('The CESR fixture destination or its Task file already exists.');
  }
  await cp(resolve(source.templateRoot), worktree, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await cp(resolve(source.taskTemplate), taskFile, { errorOnExist: true, force: false });
  await git(worktree, ['init', '--quiet', '--initial-branch=main', '--object-format=sha1']);
  await git(worktree, ['add', '--all']);
  await git(worktree, [
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '--message',
    'Prepared CESR receipt compatibility fixture',
  ]);
  const objectFormat = await git(worktree, ['rev-parse', '--show-object-format']);
  const commit = await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = await git(worktree, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (objectFormat !== 'sha1' || !/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error('The materialized CESR fixture did not produce a pinned SHA-1 Git identity.');
  }
  return { worktree, taskFile, repository: { objectFormat, commit, tree } };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  const profile = process.argv[3] ?? 'flat-groups';
  if (
    destination === undefined ||
    process.argv.length > 4 ||
    !['flat-groups', 'scoped-groups'].includes(profile)
  ) {
    process.stderr.write(
      'Usage: materialize-cesr-fixture <new-directory> [flat-groups|scoped-groups]\n',
    );
    process.exitCode = 2;
  } else {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const materialized = await materializeCesrReceiptFixture({
        templateRoot: resolve(
          repositoryRoot,
          'fixtures',
          profile === 'flat-groups' ? 'cesr-receipt-service' : 'cesr-scoped-receipt-service',
        ),
        taskTemplate: resolve(
          repositoryRoot,
          'fixtures',
          profile === 'flat-groups' ? 'cesr-compat.task.json' : 'cesr-scoped-compat.task.json',
        ),
        destination,
      });
      process.stdout.write(`${JSON.stringify(materialized)}\n`);
    } catch (cause) {
      process.stderr.write(
        `${cause instanceof Error ? cause.message : 'Fixture materialization failed.'}\n`,
      );
      process.exitCode = 1;
    }
  }
}
