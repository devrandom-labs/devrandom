import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { ProtectedCredentials } from '@devrandom/domain';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { GitHarnessInspection } from './git-harness-inspection.js';
import { HostHarnessExecutionInventory } from './host-harness-execution-inventory.js';

const executeFile = promisify(execFile);
const directories: string[] = [];

function hostInspection(path: string): GitHarnessInspection {
  return new GitHarnessInspection(path, new HostHarnessExecutionInventory(path));
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository(): Promise<{
  readonly path: string;
  readonly commit: string;
  readonly tree: string;
}> {
  const path = await mkdtemp(join(tmpdir(), 'devrandom-h1-git-'));
  directories.push(path);
  await mkdir(join(path, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(path, 'AGENTS.md'), '# Root instructions\n'),
    writeFile(join(path, 'src', 'AGENTS.md'), '# Nested instructions\n'),
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
  return { path, commit, tree };
}

describe('Git H1 inspection', () => {
  it.each(['Content', 'Path'] as const)(
    'rejects a protected credential in instruction %s without returning its identity',
    async (location) => {
      const fixture = await repository();
      const secret = 'opaque-fixture-credential-946825';
      const path = location === 'Content' ? 'AGENTS.md' : `${secret}/AGENTS.md`;
      if (location === 'Path') await mkdir(join(fixture.path, secret));
      await writeFile(join(fixture.path, path), location === 'Content' ? secret : '# Safe text\n');
      await executeFile('git', ['add', '.'], { cwd: fixture.path });
      await executeFile('git', ['commit', '-m', 'instruction fixture'], { cwd: fixture.path });
      const commit = (
        await executeFile('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })
      ).stdout.trim();
      const tree = (
        await executeFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixture.path })
      ).stdout.trim();
      const task = taskProjectionFixture();
      const outcome = await hostInspection(fixture.path).inspect(
        {
          ...task,
          revision: {
            ...task.revision,
            repository: { objectFormat: 'sha1', commit, tree },
          },
        },
        new ProtectedCredentials([secret]),
      );

      expect(outcome).toEqual({ kind: 'Rejected', reason: 'SecretDetected' });
    },
  );

  it('inspects the accepted repository without executing its filesystem monitor', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const marker = join(fixture.path, '.git', 'monitor-executed');
    const hook = join(fixture.path, '.git', 'inspection-monitor');
    await writeFile(hook, '#!/bin/sh\ntouch "$(dirname "$0")/monitor-executed"\n', {
      mode: 0o700,
    });
    await executeFile('git', ['config', 'core.fsmonitor', hook], { cwd: fixture.path });

    const outcome = await hostInspection(fixture.path).inspect(
      {
        ...task,
        revision: {
          ...task.revision,
          repository: { objectFormat: 'sha1', commit: fixture.commit, tree: fixture.tree },
        },
      },
      new ProtectedCredentials(),
    );

    expect(outcome.kind).toBe('Inspected');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('identifies ordered instruction bytes from the exact accepted commit', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const boundTask = {
      ...task,
      revision: {
        ...task.revision,
        repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
      },
    };

    const first = await hostInspection(fixture.path).inspect(boundTask, new ProtectedCredentials());
    const second = await hostInspection(fixture.path).inspect(
      boundTask,
      new ProtectedCredentials(),
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'Inspected',
      snapshot: {
        commandExecutables: [
          {
            commandId: 'public-test',
          },
        ],
        repository: {
          objectFormat: 'sha1',
          commit: fixture.commit,
          tree: fixture.tree,
          instructionResources: [{ path: 'AGENTS.md' }, { path: 'src/AGENTS.md' }],
        },
      },
    });
    if (first.kind !== 'Inspected') {
      throw new Error('fixture H1 must inspect');
    }
    expect(first.snapshot.commandExecutables[0]?.executableRealpath).toMatch(/^\//u);
  });

  it('binds a supplied Linux execution inventory instead of host OS and command paths', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const boundTask = {
      ...task,
      revision: {
        ...task.revision,
        repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
      },
    };
    const inventory = {
      inspect: () =>
        Promise.resolve({
          kind: 'Inspected' as const,
          environmentCompatibility: {
            operatingSystem: 'linux' as const,
            architecture: 'arm64' as const,
            nodeVersion: '22.0.0',
            gitVersion: '2.48.0',
            piSdkVersion: '0.87.1',
            xstateVersion: '5.33.2',
          },
          commandExecutables: [
            {
              commandId: 'public-test',
              executableRealpath:
                '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo',
            },
          ],
        }),
    };
    const outcome = await new GitHarnessInspection(fixture.path, inventory).inspect(
      boundTask,
      new ProtectedCredentials(),
    );
    expect(outcome).toMatchObject({
      kind: 'Inspected',
      snapshot: {
        environmentCompatibility: { operatingSystem: 'linux', architecture: 'arm64' },
        commandExecutables: [
          {
            commandId: 'public-test',
            executableRealpath:
              '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo',
          },
        ],
      },
    });
    await expect(
      new GitHarnessInspection(fixture.path, inventory).inspect(
        boundTask,
        new ProtectedCredentials(['1.98.1-aarch64']),
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'SecretDetected' });
  });

  it('rejects a repository change made while the execution inventory is probed', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const boundTask = {
      ...task,
      revision: {
        ...task.revision,
        repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
      },
    };
    const host = new HostHarnessExecutionInventory(fixture.path);
    const inventory = {
      inspect: async (inspectedTask: typeof boundTask) => {
        const observed = await host.inspect(inspectedTask);
        await writeFile(join(fixture.path, 'AGENTS.md'), '# Modified during probe\n');
        return observed;
      },
    };
    await expect(
      new GitHarnessInspection(fixture.path, inventory).inspect(
        boundTask,
        new ProtectedCredentials(),
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'WorktreeDirty' });
  });

  it('rejects a new clean commit made while the execution inventory is probed', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const boundTask = {
      ...task,
      revision: {
        ...task.revision,
        repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
      },
    };
    const host = new HostHarnessExecutionInventory(fixture.path);
    const inventory = {
      inspect: async (inspectedTask: typeof boundTask) => {
        const observed = await host.inspect(inspectedTask);
        await writeFile(join(fixture.path, 'AGENTS.md'), '# New clean commit\n');
        await executeFile('git', ['add', 'AGENTS.md'], { cwd: fixture.path });
        await executeFile('git', ['commit', '-m', 'changed during probe'], { cwd: fixture.path });
        return observed;
      },
    };
    await expect(
      new GitHarnessInspection(fixture.path, inventory).inspect(
        boundTask,
        new ProtectedCredentials(),
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'RepositoryBindingChanged' });
  });

  it.each(['RunFormatter', 'RunStaticAnalysis'] as const)(
    'resolves declared %s executables and rejects unavailable ones before H1 construction',
    async (capability) => {
      const fixture = await repository();
      const task = taskProjectionFixture();
      const declaration = {
        capability,
        id: 'declared-tool',
        argv: ['git', '--version'],
        timeoutSeconds: 30,
        expected: { kind: 'exitCode' as const, code: 0 },
      };
      const boundTask = {
        ...task,
        revision: {
          ...task.revision,
          repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
          requestedCapabilities: [...task.revision.requestedCapabilities, capability],
          toolCommands: [declaration],
        },
      };
      const inspection = hostInspection(fixture.path);
      const outcome = await inspection.inspect(boundTask, new ProtectedCredentials());
      expect(outcome.kind).toBe('Inspected');
      if (outcome.kind !== 'Inspected') throw new Error('Expected inspected executables');
      expect(outcome.snapshot.commandExecutables.map((command) => command.commandId)).toEqual([
        'public-test',
        'declared-tool',
      ]);
      for (const command of outcome.snapshot.commandExecutables) {
        expect(command.executableRealpath).toMatch(/^\//u);
      }
      await expect(
        inspection.inspect(
          {
            ...boundTask,
            revision: {
              ...boundTask.revision,
              toolCommands: [{ ...declaration, argv: ['devrandom-command-that-does-not-exist'] }],
            },
          },
          new ProtectedCredentials(),
        ),
      ).resolves.toEqual({ kind: 'Rejected', reason: 'CommandExecutableUnavailable' });
    },
  );

  it('withholds a protected credential exposed only by executable resolution', async () => {
    const fixture = await repository();
    const secret = 'opaque-executable-location-946825';
    const executable = join(fixture.path, '.git', secret);
    const alias = join(fixture.path, '.git', 'safe-command');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await symlink(executable, alias);
    const task = taskProjectionFixture();
    await expect(
      hostInspection(fixture.path).inspect(
        {
          ...task,
          revision: {
            ...task.revision,
            repository: { objectFormat: 'sha1', commit: fixture.commit, tree: fixture.tree },
            toolCommands: [
              {
                capability: 'RunFormatter',
                id: 'format',
                argv: [alias],
                timeoutSeconds: 30,
                expected: { kind: 'exitCode', code: 0 },
              },
            ],
          },
        },
        new ProtectedCredentials([secret]),
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'SecretDetected' });
  });

  it('rejects mutable worktree state before reading instructions', async () => {
    const fixture = await repository();
    const task = taskProjectionFixture();
    const boundTask = {
      ...task,
      revision: {
        ...task.revision,
        repository: { objectFormat: 'sha1' as const, commit: fixture.commit, tree: fixture.tree },
      },
    };
    await writeFile(join(fixture.path, 'AGENTS.md'), '# Changed after admission\n');

    await expect(
      hostInspection(fixture.path).inspect(boundTask, new ProtectedCredentials()),
    ).resolves.toEqual({
      kind: 'Rejected',
      reason: 'WorktreeDirty',
    });
  });
});
