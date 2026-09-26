import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { ProtectedCredentials } from '@devrandom/domain';
import { identifyCheckpointFileContent } from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreparedRunWorktree } from '../application/run-worktree.js';
import { GitWorktreeChanges } from './git-worktree-changes.js';
import { ManagedWorktreeResources, ManagedWorktreeToolEffects } from './managed-worktree-tools.js';
import { RunWorktreeWriteAdmission } from '../application/worktree-write-admission.js';

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(directory: string, arguments_: readonly string[]): Promise<string> {
  const execution = await executeFile('git', arguments_, { cwd: directory, encoding: 'utf8' });
  return execution.stdout.trim();
}

function contentSaid(content: string): string {
  const identified = identifyCheckpointFileContent(new TextEncoder().encode(content));
  if (identified.kind !== 'Identified') throw new Error('fixture content must be identifiable');
  return identified.contentSaid;
}

async function worktreeFixture(baseAContent = 'old a\n'): Promise<PreparedRunWorktree> {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-checkpoint-repository-'));
  temporaryDirectories.push(root);
  const repository = join(root, 'repository');
  const state = join(root, 'state');
  const directory = join(state, 'runs', '1cc482f1-98e9-4454-8e4c-5566cb47ce3d', 'worktree');
  await mkdir(repository);
  await mkdir(join(state, 'runs', '1cc482f1-98e9-4454-8e4c-5566cb47ce3d'), {
    recursive: true,
    mode: 0o700,
  });
  await chmod(state, 0o700);
  await git(repository, ['init', '--initial-branch=main']);
  await git(repository, ['config', 'user.name', 'Checkpoint Test']);
  await git(repository, ['config', 'user.email', 'checkpoint@devrandom.example']);
  await writeFile(join(repository, 'a.txt'), baseAContent);
  await writeFile(join(repository, 'b.txt'), 'delete me\n');
  await writeFile(join(repository, 'c.txt'), 'rename me\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'Accepted base']);
  const commit = await git(repository, ['rev-parse', 'HEAD']);
  const tree = await git(repository, ['rev-parse', 'HEAD^{tree}']);
  const branch = 'devrandom/run/1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
  await git(repository, ['worktree', 'add', '-b', branch, directory, commit]);
  await writeFile(join(directory, 'a.txt'), 'new a\n');
  await unlink(join(directory, 'b.txt'));
  await git(directory, ['mv', 'c.txt', 'd.txt']);
  await writeFile(join(directory, 'e.txt'), 'new file\n');
  return {
    directory: await realpath(directory),
    branch,
    repository: { objectFormat: 'sha1', commit, tree },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('Git worktree changes', () => {
  it.each(['Cancellation', 'CaptureCancellation', 'Deadline', 'WriteDeadline'] as const)(
    'joins stalled Git inspection on %s without admitting a write or checkpoint',
    async (interruption) => {
      const worktree = await worktreeFixture();
      const binaries = join(dirname(worktree.directory), 'stalled-git');
      const marker = join(binaries, 'started');
      await mkdir(binaries);
      await writeFile(
        join(binaries, 'git'),
        `#!/bin/sh\nprintf '%s\\n' "$$" >> '${marker}'\nexec sleep 2\n`,
        { mode: 0o700 },
      );
      vi.stubEnv('PATH', `${binaries}:${process.env.PATH ?? '/usr/bin:/bin'}`);
      const expired = new AbortController();
      const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expired.signal);
      const cancellation = new AbortController();
      const repository = new GitWorktreeChanges();
      const limits = { changedFiles: 256, changedWorktreeBytes: 16 * 1024 * 1024 };
      const inspection =
        interruption === 'Deadline' || interruption === 'CaptureCancellation'
          ? repository.capture(worktree, limits, cancellation.signal)
          : repository.inspectWrite(
              worktree,
              limits,
              { path: join(worktree.directory, 'new.txt'), bytes: new Uint8Array([1]) },
              cancellation.signal,
            );
      // Attach rejection observation before aborting the active inspection.
      const settled = inspection.then(
        (outcome) => outcome,
        (error: unknown) => error,
      );
      await vi.waitFor(async () => {
        expect(await readFile(marker, 'utf8')).not.toBe('');
      });
      const started = performance.now();
      if (interruption === 'Cancellation' || interruption === 'CaptureCancellation')
        cancellation.abort();
      else expired.abort(new DOMException('Inspection deadline', 'TimeoutError'));
      const outcome = await settled;
      expect(performance.now() - started).toBeLessThan(1_000);
      if (interruption === 'Cancellation' || interruption === 'CaptureCancellation')
        expect(outcome).toBe(cancellation.signal.reason);
      else
        expect(outcome).toEqual({
          kind: interruption === 'Deadline' ? 'GitUnavailable' : 'DependencyUnavailable',
        });
      expect(deadline).toHaveBeenCalledWith(10_000);
      for (const pid of (await readFile(marker, 'utf8')).trim().split('\n')) {
        expect(() => process.kill(Number(pid), 0)).toThrow();
      }
    },
  );

  it('does not execute a repository-selected filesystem monitor during trusted inspection', async () => {
    const worktree = await worktreeFixture();
    const marker = join(dirname(worktree.directory), 'fsmonitor-executed');
    const hook = join(dirname(worktree.directory), 'fsmonitor-hook');
    await writeFile(
      hook,
      `#!/bin/sh\nprintf unsafe > '${marker}'\nprintf 'inspection-token\\0'\n`,
      { mode: 0o700 },
    );
    await git(worktree.directory, ['config', 'core.fsmonitor', hook]);
    const repository = new GitWorktreeChanges();
    const limits = { changedFiles: 256, changedWorktreeBytes: 16 * 1024 * 1024 };
    const capture = await repository.capture(worktree, limits);
    expect(capture.kind).toBe('Captured');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const write = await repository.inspectWrite(
      worktree,
      limits,
      { path: join(worktree.directory, 'a.txt'), bytes: new TextEncoder().encode('change') },
      new AbortController().signal,
    );
    expect(write.kind).toBe('Projected');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a write whose hard-linked inode would mutate additional paths', async () => {
    const worktree = await worktreeFixture();
    await link(join(worktree.directory, 'a.txt'), join(worktree.directory, 'alias.txt'));
    await expect(
      new GitWorktreeChanges().inspectWrite(
        worktree,
        { changedFiles: 256, changedWorktreeBytes: 16 * 1024 * 1024 },
        { path: join(worktree.directory, 'a.txt'), bytes: new TextEncoder().encode('replacement') },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'DependencyUnavailable' });
  });

  it.each(['Budget', 'Bytes', 'Secret', 'Allowed'] as const)(
    'enforces %s admission at the real filesystem write boundary',
    async (scenario) => {
      const worktree = await worktreeFixture();
      const credential = 'synthetic-write-credential-0192837465';
      const credentials = new ProtectedCredentials([credential]);
      const repository = new GitWorktreeChanges(credentials);
      const withhold = vi.fn(() => ({
        kind: 'SecretDetected' as const,
        dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
        securityViolationEventSaid: 'E'.padEnd(44, 'z'),
      }));
      const writeAdmission = new RunWorktreeWriteAdmission({
        worktree,
        limits: {
          changedFiles: scenario === 'Budget' ? 4 : 5,
          changedWorktreeBytes: scenario === 'Bytes' ? 35 : 1024,
        },
        repository,
        credentials,
        evidence: { withhold },
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const resources = new ManagedWorktreeResources({
        worktree: worktree.directory,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const effects = new ManagedWorktreeToolEffects({
        resources,
        writeAdmission,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact: vi.fn() },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposal = {
        piSessionId: 'session',
        modelTurnId: 'turn',
        toolCallId: 'call',
        proposalIndex: 0,
        input: {
          kind: 'WriteFile' as const,
          path: 'new/file.txt',
          content: scenario === 'Secret' ? credential : 'new',
        },
      };
      const resolution = resources.resolve(proposal);
      if (resolution.kind !== 'Resolved') throw new Error('write must resolve');
      const outcome = await effects.enact(
        {
          proposal,
          resource: resolution.resource,
          tool: 'write_file',
          requiredCapability: 'EditRepository',
        },
        new AbortController().signal,
      );
      expect(outcome.kind).toBe(
        scenario === 'Allowed'
          ? 'Completed'
          : scenario === 'Secret'
            ? 'SecretDetected'
            : 'BudgetExhausted',
      );
      if (scenario === 'Allowed') {
        expect(await readFile(join(worktree.directory, 'new/file.txt'), 'utf8')).toBe('new');
        const checkpoint = await repository.capture(worktree, {
          changedFiles: 5,
          changedWorktreeBytes: 1024,
        });
        if (checkpoint.kind !== 'Captured') throw new Error('written repository must capture');
        expect(checkpoint.repository.changedFiles).toHaveLength(5);
      } else {
        await expect(readFile(join(worktree.directory, 'new'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(withhold).toHaveBeenCalledTimes(scenario === 'Secret' ? 1 : 0);
    },
  );

  it('withholds a protected replace_text oldText before removing it from a tracked file', async () => {
    const credential = 'synthetic-replacement-credential-1357924680';
    const worktree = await worktreeFixture(credential);
    const file = join(worktree.directory, 'a.txt');
    await writeFile(file, credential);
    const credentials = new ProtectedCredentials([credential]);
    const withhold = vi.fn(() => ({
      kind: 'SecretDetected' as const,
      dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
      securityViolationEventSaid: 'E'.padEnd(44, 'z'),
    }));
    const resources = new ManagedWorktreeResources({
      worktree: worktree.directory,
      protectedPaths: [],
      completionCommands: [],
      toolCommands: [],
    });
    const effects = new ManagedWorktreeToolEffects({
      resources,
      writeAdmission: new RunWorktreeWriteAdmission({
        worktree,
        limits: { changedFiles: 256, changedWorktreeBytes: 16 * 1024 * 1024 },
        repository: new GitWorktreeChanges(credentials),
        credentials,
        evidence: { withhold },
        now: () => '2026-09-25T20:00:04.000Z',
      }),
      commands: { run: vi.fn() },
      artifacts: { storeArtifact: vi.fn() },
      processOutput: { record: vi.fn() },
      verification: { verify: vi.fn() },
    });
    const proposed = {
      piSessionId: 'session',
      modelTurnId: 'turn',
      toolCallId: 'call',
      proposalIndex: 0,
      input: {
        kind: 'ReplaceText' as const,
        path: 'a.txt',
        oldText: credential,
        newText: 'sanitized',
        expectedOccurrences: 1,
      },
    };
    const resolved = resources.resolve(proposed);
    if (resolved.kind !== 'Resolved') throw new Error('replacement must resolve');

    await expect(
      effects.enact(
        {
          proposal: proposed,
          resource: resolved.resource,
          tool: 'replace_text',
          requiredCapability: 'EditRepository',
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'SecretDetected' });
    expect(await readFile(file, 'utf8')).toBe(credential);
    expect(withhold).toHaveBeenCalledOnce();
  });

  it('assesses prospective writes against the current complete footprint and lower Task limits', async () => {
    const worktree = await worktreeFixture();
    const repository = new GitWorktreeChanges();
    const current = await repository.capture(worktree, {
      changedFiles: 256,
      changedWorktreeBytes: 16 * 1024 * 1024,
    });
    if (current.kind !== 'Captured') throw new Error('repository must capture');
    const limits = { changedFiles: 4, changedWorktreeBytes: current.changedWorktreeBytes };
    const inspect = (path: string, content: string) =>
      repository.inspectWrite(
        worktree,
        limits,
        { path: join(worktree.directory, path), bytes: new TextEncoder().encode(content) },
        new AbortController().signal,
      );
    await expect(inspect('new/file.txt', 'new')).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 5,
      changedWorktreeBytes: current.changedWorktreeBytes + 3,
    });
    await expect(inspect('a.txt', 'new a\n')).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 4,
      changedWorktreeBytes: current.changedWorktreeBytes,
    });
    await expect(inspect('a.txt', 'larger content')).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 4,
      changedWorktreeBytes: current.changedWorktreeBytes + 8,
    });
    await expect(inspect('a.txt', 'old a\n')).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 3,
      changedWorktreeBytes: current.changedWorktreeBytes - 6,
    });
    await writeFile(join(worktree.directory, 'a.txt'), 'old a\n');
    const restored = await repository.capture(worktree, limits);
    if (restored.kind !== 'Captured') throw new Error('restored repository must capture');
    const tight = { changedFiles: 3, changedWorktreeBytes: restored.changedWorktreeBytes };
    await expect(
      repository.inspectWrite(
        worktree,
        tight,
        { path: join(worktree.directory, 'a.txt'), bytes: new TextEncoder().encode('old a\n') },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 3,
      changedWorktreeBytes: restored.changedWorktreeBytes,
    });
    await expect(
      repository.inspectWrite(
        worktree,
        tight,
        { path: join(worktree.directory, 'a.txt'), bytes: new TextEncoder().encode('change') },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 4,
      changedWorktreeBytes: restored.changedWorktreeBytes + 6,
    });
    await expect(
      repository.inspectWrite(
        worktree,
        tight,
        { path: join(worktree.directory, '..', 'outside'), bytes: new Uint8Array() },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'DependencyUnavailable' });
  });

  it('does not erase a staged change from prospective accounting when content returns to the base', async () => {
    const worktree = await worktreeFixture();
    await writeFile(join(worktree.directory, 'a.txt'), 'a');
    await git(worktree.directory, ['add', 'a.txt']);
    const repository = new GitWorktreeChanges();
    const current = await repository.capture(worktree, {
      changedFiles: 256,
      changedWorktreeBytes: 16 * 1024 * 1024,
    });
    if (current.kind !== 'Captured') throw new Error('repository must capture');
    await expect(
      repository.inspectWrite(
        worktree,
        { changedFiles: 4, changedWorktreeBytes: current.changedWorktreeBytes },
        { path: join(worktree.directory, 'a.txt'), bytes: new TextEncoder().encode('old a\n') },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: 'Projected',
      changedFiles: 4,
      changedWorktreeBytes: current.changedWorktreeBytes + 5,
    });
    expect(await git(worktree.directory, ['diff', '--cached', '--name-only'])).toContain('a.txt');
  });

  it('includes ignored files and nested ignored directories in the complete manifest and budgets', async () => {
    const worktree = await worktreeFixture();
    const commonDirectory = await git(worktree.directory, ['rev-parse', '--git-common-dir']);
    await writeFile(join(commonDirectory, 'info', 'exclude'), 'e.txt\ngenerated/\n');
    await mkdir(join(worktree.directory, 'generated', 'nested'), { recursive: true });
    await writeFile(
      join(worktree.directory, 'generated', 'nested', 'output.txt'),
      'generated bytes\n',
    );
    const repository = new GitWorktreeChanges();
    const capture = await repository.capture(worktree, {
      changedFiles: 256,
      changedWorktreeBytes: 16 * 1024 * 1024,
    });
    expect(capture.kind).toBe('Captured');
    if (capture.kind !== 'Captured') return;
    expect(capture.repository.changedFiles.map(({ path }) => path)).toEqual([
      'a.txt',
      'b.txt',
      'd.txt',
      'e.txt',
      'generated/nested/output.txt',
    ]);
    expect(capture.changedWorktreeBytes).toBe(
      Buffer.byteLength('new a\ndelete me\nrename me\nnew file\ngenerated bytes\n'),
    );
    await expect(
      repository.capture(worktree, {
        changedFiles: 4,
        changedWorktreeBytes: 16 * 1024 * 1024,
      }),
    ).resolves.toEqual({ kind: 'ChangedFileLimitExceeded' });
    await expect(
      repository.capture(worktree, {
        changedFiles: 256,
        changedWorktreeBytes: capture.changedWorktreeBytes - 1,
      }),
    ).resolves.toEqual({ kind: 'ChangedWorktreeLimitExceeded' });
  });

  it('captures an over-budget ignored build artifact for a terminal exclusion audit', async () => {
    const worktree = await worktreeFixture();
    await writeFile(join(worktree.directory, '.gitignore'), '/target/\n');
    await mkdir(join(worktree.directory, 'target'));
    await writeFile(
      join(worktree.directory, 'target', 'test-binary'),
      Buffer.alloc(17 * 1024 * 1024),
    );

    const capture = await new GitWorktreeChanges().capture(worktree, {
      changedFiles: 256,
      changedWorktreeBytes: 32 * 1024 * 1024,
    });
    expect(capture.kind).toBe('Captured');
    if (capture.kind !== 'Captured') return;
    expect(capture.repository.changedFiles.map(({ path }) => path)).toContain('target/test-binary');
    expect(capture.changedWorktreeBytes).toBeGreaterThan(16 * 1024 * 1024);
  });

  it('withholds credentials in ignored output before creating its content identity', async () => {
    const worktree = await worktreeFixture();
    const commonDirectory = await git(worktree.directory, ['rev-parse', '--git-common-dir']);
    await writeFile(join(commonDirectory, 'info', 'exclude'), 'e.txt\n');
    const credential = 'synthetic-ignored-credential-0192837465';
    await writeFile(join(worktree.directory, 'e.txt'), credential);
    await expect(
      new GitWorktreeChanges(new ProtectedCredentials([credential])).capture(worktree, {
        changedFiles: 256,
        changedWorktreeBytes: 16 * 1024 * 1024,
      }),
    ).resolves.toEqual({
      kind: 'WithheldSecret',
      reason: 'Credential',
      byteLength: Buffer.byteLength(credential),
    });
  });

  it.each(['Content', 'Path'] as const)(
    'withholds a known credential in changed %s before returning content identities',
    async (location) => {
      const worktree = await worktreeFixture();
      const credential = 'synthetic-checkpoint-credential-0192837465';
      await writeFile(
        join(worktree.directory, location === 'Path' ? credential : 'e.txt'),
        location === 'Content' ? credential : 'ordinary content\n',
      );

      const capture = await new GitWorktreeChanges(new ProtectedCredentials([credential])).capture(
        worktree,
        { changedFiles: 256, changedWorktreeBytes: 16 * 1024 * 1024 },
      );

      expect(capture).toEqual({
        kind: 'WithheldSecret',
        reason: 'Credential',
        byteLength: Buffer.byteLength(credential),
      });
    },
  );

  it('captures porcelain-v2 changes as a sorted content-addressed manifest', async () => {
    const worktree = await worktreeFixture();

    await expect(
      new GitWorktreeChanges().capture(worktree, {
        changedFiles: 256,
        changedWorktreeBytes: 16 * 1024 * 1024,
      }),
    ).resolves.toEqual({
      kind: 'Captured',
      repository: {
        objectFormat: 'sha1',
        baseCommit: worktree.repository.commit,
        baseTree: worktree.repository.tree,
        changedFiles: [
          {
            path: 'a.txt',
            disposition: 'Modified',
            mode: '100644',
            contentSaid: contentSaid('new a\n'),
          },
          {
            path: 'b.txt',
            disposition: 'Deleted',
            mode: '000000',
            contentSaid: contentSaid('delete me\n'),
          },
          {
            path: 'd.txt',
            disposition: 'Renamed',
            mode: '100644',
            contentSaid: contentSaid('rename me\n'),
          },
          {
            path: 'e.txt',
            disposition: 'Added',
            mode: '100644',
            contentSaid: contentSaid('new file\n'),
          },
        ],
      },
      changedWorktreeBytes:
        Buffer.byteLength('new a\n') +
        Buffer.byteLength('delete me\n') +
        Buffer.byteLength('rename me\n') +
        Buffer.byteLength('new file\n'),
    });
  });

  it('fails closed before reading file content when the changed-file limit is exceeded', async () => {
    const worktree = await worktreeFixture();

    await expect(
      new GitWorktreeChanges().capture(worktree, {
        changedFiles: 3,
        changedWorktreeBytes: 16 * 1024 * 1024,
      }),
    ).resolves.toEqual({ kind: 'ChangedFileLimitExceeded' });
  });
});
