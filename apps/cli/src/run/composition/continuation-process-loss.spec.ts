import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Run, TaskBudgets } from '@devrandom/domain';
import type { EvidenceEvent, VerifiedCheckpoint } from '@devrandom/protocol';
const fixture = join(process.cwd(), 'apps/cli/test/continuation-process-fixture.ts');
it.each([false, true])(
  'external SIGKILL preserves acknowledged pause custody; tampered source=%s',
  async (tamper) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'devrandom-continuation-process-')));
    const start = () =>
      spawn(process.execPath, ['--import', 'tsx', fixture, 'pause', root], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const child = start();
    const children = [child];
    let diagnostics = '';
    child.stderr.on('data', (bytes: Buffer) => {
      diagnostics += bytes.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => {
          reject(new Error(`pause timeout ${diagnostics}`));
        }, 15000);
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`pause exited ${String(code)}: ${diagnostics}`));
        });
        child.stdout.on('data', (bytes: Buffer) => {
          output += bytes.toString();
          if (output.includes('CHECKPOINT_ACKNOWLEDGED')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const killed = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once('exit', (_code, signal) => {
          resolve(signal);
        }),
      );
      child.kill('SIGKILL');
      expect(await killed).toBe('SIGKILL');
      const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')) as {
        run: Run;
        worktree: { directory: string };
        events: EvidenceEvent[];
        checkpointRepository: Extract<VerifiedCheckpoint, { version: 1 }>['repository'];
      };
      if (tamper)
        await writeFile(
          join(snapshot.worktree.directory, 'source.txt'),
          'unauthorized change after checkpoint\n',
        );
      const fresh = spawn(process.execPath, ['--import', 'tsx', fixture, 'resume', root], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(fresh);
      let output = '';
      fresh.stdout.on('data', (bytes: Buffer) => {
        output += bytes.toString();
      });
      fresh.stderr.on('data', (bytes: Buffer) => {
        diagnostics += bytes.toString();
      });
      const code = await new Promise<number | null>((resolve) => fresh.once('exit', resolve));
      expect(code, diagnostics).toBe(0);
      const result = JSON.parse(output) as {
        kind: string;
        admissions: number;
        runId: string;
        oldIncarnationId: string;
        incarnationId: string;
        sequence: number;
        consumedBudget: TaskBudgets;
        repository: Extract<VerifiedCheckpoint, { version: 1 }>['repository'];
        oldPrefix: string[];
        artifactCount: number;
      };
      if (tamper) {
        expect(result).toEqual({ kind: 'ArtifactMismatch', admissions: 0 });
        return;
      }
      expect(result.kind).toBe('Resumed');
      expect(result.admissions).toBe(1);
      expect(result.runId).toBe(snapshot.run.binding.runId);
      expect(result.incarnationId).not.toBe(result.oldIncarnationId);
      expect(result.sequence).toBe(0);
      expect(result.consumedBudget).toEqual(snapshot.run.consumedBudget);
      expect(result.consumedBudget.providerRequests).toBe(1);
      expect(result.consumedBudget.changedFiles).toBe(1);
      expect(result.repository).toEqual(snapshot.checkpointRepository);
      expect(await readFile(join(snapshot.worktree.directory, 'source.txt'), 'utf8')).toBe(
        'changed before external SIGKILL\n',
      );
      expect(result.repository.changedFiles).toHaveLength(1);
      expect(result.oldPrefix).toEqual(snapshot.events.map((event) => event.d));
      expect(result.artifactCount).toBeGreaterThan(0);
    } finally {
      for (const process of children) process.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
