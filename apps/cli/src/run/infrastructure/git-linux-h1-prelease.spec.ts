import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { inspectLinuxH1PreLease } from '../application/linux-h1-prelease.js';
import { GitLinuxH1PreLease } from './git-linux-h1-prelease.js';
import type { LinuxH1ProfileBundle } from './linux-h1-profile-file.js';

vi.mock('../application/linux-h1-prelease.js', () => ({
  inspectLinuxH1PreLease: vi.fn(() => ({ kind: 'Compatible' })),
}));

function withRepository(assertion: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'linux-h1-prelease-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(directory, 'AGENTS.md'), '# Pinned instructions\n');
  git('add', 'AGENTS.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source');
  return assertion(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

describe('Git Linux H1 pre-lease reread', () => {
  it('passes the committed instruction bytes and exact source to profile inspection', async () => {
    await withRepository(async (directory) => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
      const original = taskProjectionFixture();
      const task = {
        ...original,
        revision: {
          ...original.revision,
          repository: {
            objectFormat: 'sha1' as const,
            commit: git('rev-parse', 'HEAD'),
            tree: git('rev-parse', 'HEAD^{tree}'),
          },
        },
      };
      const harness = baselineHarnessCommandFixture(task).revision;
      const bundle = { cargoRealpath: '/pinned/cargo' } as LinuxH1ProfileBundle;
      const verifier = new GitLinuxH1PreLease(directory, bundle);
      await expect(verifier.verify(task, harness)).resolves.toEqual({ kind: 'Compatible' });
      expect(inspectLinuxH1PreLease).toHaveBeenCalledWith(
        expect.objectContaining({
          task,
          harness,
          instructions: [{ path: 'AGENTS.md', content: '# Pinned instructions\n' }],
        }),
      );
      writeFileSync(join(directory, 'AGENTS.md'), '# Changed instructions\n');
      vi.mocked(inspectLinuxH1PreLease).mockClear();
      await expect(verifier.verify(task, harness)).resolves.toEqual({ kind: 'Rejected' });
      expect(inspectLinuxH1PreLease).not.toHaveBeenCalled();
    });
  });
});
