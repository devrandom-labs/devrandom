import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

import { prepareEvaluationExecutionProfile, prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { digestEvaluationRuntimeMounts } from '../evaluation/infrastructure/runtime-mount-digest.js';
import { DockerRunEnvironment, type RunEnvironmentOpeningInput } from './docker-run-environment.js';

const runFile = promisify(execFile);
const said = (character: string): string => `E${character.repeat(43)}`;
const cargoPath = '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo';

async function output(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; text: string }> {
  const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
  let text = '';
  for await (const chunk of child.stdout) text += String(chunk);
  const code = await closed;
  return { code, text };
}

async function parentDeathNames(input: {
  readonly image: string;
  readonly runtimeDigest: string;
  readonly runtimeDirectory: string;
  readonly worktree: string;
}): Promise<{ worker: string; native: string }> {
  const child = spawn(
    process.execPath,
    [
      resolve('packages/runtime/dist/run/run-parent-death-probe.js'),
      input.image,
      input.runtimeDigest,
      input.runtimeDirectory,
      input.worktree,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let names: { worker: string; native: string } | undefined;
  try {
    const line = await new Promise<string>((resolveLine, reject) => {
      let text = '';
      const timeout = setTimeout(() => {
        reject(new Error('Run OCI parent-death probe did not open.'));
      }, 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        text += String(chunk);
        if (text.includes('\n')) {
          clearTimeout(timeout);
          resolveLine(text.split('\n')[0] ?? '');
        }
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Run OCI parent-death probe exited ${String(code)}`));
      });
    });
    names = JSON.parse(line) as { worker: string; native: string };
    expect(names.worker).toMatch(/^devrandom-evaluation-[0-9a-f-]{36}$/u);
    expect(names.native).toMatch(/^devrandom-evaluation-[0-9a-f-]{36}$/u);
    child.kill('SIGKILL');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const [worker, native] = await Promise.all([
        runFile('docker', [
          'ps',
          '-a',
          '--filter',
          `name=^/${names.worker}$`,
          '--format',
          '{{.ID}}',
        ]),
        runFile('docker', [
          'ps',
          '-a',
          '--filter',
          `name=^/${names.native}$`,
          '--format',
          '{{.ID}}',
        ]),
      ]);
      if (worker.stdout.trim() === '' && native.stdout.trim() === '') return names;
      await new Promise((wait) => setTimeout(wait, 500));
    }
    throw new Error('Run OCI parent-death cleanup was not observed.');
  } finally {
    child.kill('SIGKILL');
    if (names !== undefined) {
      await Promise.allSettled([
        runFile('docker', ['rm', '-f', names.worker]),
        runFile('docker', ['rm', '-f', names.native]),
      ]);
    }
  }
}

describe.skipIf(process.env.DEVRANDOM_RUN_OCI_TEST !== '1')('real Run OCI profile', () => {
  it('reopens exact effective limits/toolchain after observed parent-SIGKILL cleanup', async () => {
    const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
    const root = await mkdtemp(resolve('.run-oci-profile-'));
    try {
      const runtimeDirectory = join(root, 'runtime');
      const worktree = join(root, 'worktree');
      await Promise.all([mkdir(runtimeDirectory), mkdir(worktree)]);
      await writeFile(
        join(runtimeDirectory, 'worker.js'),
        'process.stdout.write(String(process.getuid()));\n',
      );
      await writeFile(join(worktree, 'source.txt'), 'public source\n');
      const runtimeMounts = [{ hostPath: runtimeDirectory, containerPath: '/app/runtime' }];
      const runtimeDigest = await digestEvaluationRuntimeMounts(
        runtimeMounts.map((mount) => ({
          ...mount,
          writable: false,
        })),
      );
      const base = {
        os: 'linux' as const,
        architecture: 'aarch64' as const,
        imageDigest: image,
        runtimeDigest,
        sourceGitCommit: '3'.repeat(40),
        sourceGitTree: '4'.repeat(40),
        h1InstructionSaid: said('i'),
        h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
        modelProvider: 'fixture',
        modelId: 'fixture',
        thinkingLevel: 'low',
        maximumOutputTokens: 64,
        limits: {
          cpuCount: 1,
          memoryBytes: 128 * 1024 * 1024,
          processCount: 16,
          scratchBytes: 1024 * 1024,
          outputBytes: 64 * 1024,
          wallTimeSeconds: 60,
        },
        containment: {
          nonRoot: true,
          readOnlyRuntime: true,
          networkDisabled: true,
          privilegesDropped: true,
          restrictedIpc: true,
          parentDeathCleanup: true,
        },
      };
      const draft = prepareEvaluationExecutionProfile({
        ...base,
        toolchainDigest: `sha256:${'2'.repeat(64)}`,
        effectiveLimitsReceiptSaid: said('l'),
        parentDeathCleanupReceiptSaid: said('p'),
      });
      expect(draft.kind).toBe('Prepared');
      if (draft.kind !== 'Prepared') return;
      const names = await parentDeathNames({ image, runtimeDigest, runtimeDirectory, worktree });
      const cleanupReceipt = Buffer.from(
        JSON.stringify({
          version: 1,
          kind: 'RunParentDeathCleanup',
          imageDigest: image,
          runtimeDigest,
          architecture: base.architecture,
          limits: base.limits,
          mechanism: 'WatchdogParentLoss',
          workerContainer: names.worker,
          nativeContainer: names.native,
          workerRemoved: true,
          nativeRemoved: true,
          observedAt: new Date().toISOString(),
        }),
      );
      const observed = await DockerRunEnvironment.probe({
        profile: draft.profile,
        image,
        runtimeMounts,
        worktreeDirectory: worktree,
        executableRealpaths: [cargoPath],
        signal: new AbortController().signal,
      });
      expect(observed.kind).toBe('Observed');
      if (observed.kind !== 'Observed') return;
      const limitsArtifact = prepareEvidenceArtifact(
        observed.effectiveLimitsReceipt,
        'application/json',
      );
      const cleanupArtifact = prepareEvidenceArtifact(cleanupReceipt, 'application/json');
      expect(limitsArtifact.kind).toBe('Prepared');
      expect(cleanupArtifact.kind).toBe('Prepared');
      if (limitsArtifact.kind !== 'Prepared' || cleanupArtifact.kind !== 'Prepared') return;
      const final = prepareEvaluationExecutionProfile({
        ...base,
        toolchainDigest: observed.toolchainDigest,
        effectiveLimitsReceiptSaid: limitsArtifact.artifact.d,
        parentDeathCleanupReceiptSaid: cleanupArtifact.artifact.d,
      });
      expect(final.kind).toBe('Prepared');
      if (final.kind !== 'Prepared') return;
      process.stdout.write(
        `${JSON.stringify({
          kind: 'RunOciMechanismFixture',
          imageDigest: image,
          runtimeDigest,
          cargoPath,
          nodeVersion: observed.nodeVersion,
          gitVersion: observed.gitVersion,
          toolchainDigest: observed.toolchainDigest,
          effectiveLimitsReceiptSaid: limitsArtifact.artifact.d,
          parentDeathCleanupReceiptSaid: cleanupArtifact.artifact.d,
          profileSaid: final.profile.d,
        })}\n`,
      );
      const opening: RunEnvironmentOpeningInput = {
        profile: final.profile,
        image,
        runtimeMounts,
        worktreeDirectory: worktree,
        executableRealpaths: [cargoPath],
        environmentCompatibility: {
          operatingSystem: 'linux',
          architecture: 'arm64',
          nodeVersion: observed.nodeVersion,
          gitVersion: observed.gitVersion,
          piSdkVersion: '0.87.1',
          xstateVersion: '5.33.2',
        },
        parentDeathCleanupReceipt: cleanupReceipt,
        signal: new AbortController().signal,
      };
      const opened = await DockerRunEnvironment.open(opening);
      expect(opened.kind).toBe('Opened');
      if (opened.kind !== 'Opened') return;
      try {
        expect(opened.effectiveLimitsReceipt).toEqual(observed.effectiveLimitsReceipt);
        const worker = opened.environment.startWorker('/app/runtime/worker.js', 'run-binding');
        expect(await output(worker)).toEqual({ code: 0, text: '65534' });
        const native = await opened.environment.runNative(
          cargoPath,
          ['--version'],
          new AbortController().signal,
        );
        expect(native.kind).toBe('Running');
        if (native.kind === 'Running') {
          const result = await output(native.child);
          expect(result.code).toBe(0);
          expect(result.text).toContain('cargo 1.98.1');
          expect(await native.close()).toBe(true);
        }
      } finally {
        expect(await opened.environment.close()).toBe(true);
      }
      const settlementEnvironment = await DockerRunEnvironment.open(opening);
      expect(settlementEnvironment.kind).toBe('Opened');
      if (settlementEnvironment.kind === 'Opened') {
        try {
          const verification = await settlementEnvironment.environment.runNative(
            cargoPath,
            ['--version'],
            new AbortController().signal,
          );
          expect(verification.kind).toBe('Running');
          if (verification.kind === 'Running') {
            expect((await output(verification.child)).code).toBe(0);
            expect(await verification.close()).toBe(true);
          }
        } finally {
          expect(await settlementEnvironment.environment.close()).toBe(true);
        }
      }
      const forged = prepareEvaluationExecutionProfile({
        ...base,
        toolchainDigest: `sha256:${'0'.repeat(64)}`,
        effectiveLimitsReceiptSaid: limitsArtifact.artifact.d,
        parentDeathCleanupReceiptSaid: cleanupArtifact.artifact.d,
      });
      expect(forged.kind).toBe('Prepared');
      if (forged.kind === 'Prepared') {
        expect(await DockerRunEnvironment.open({ ...opening, profile: forged.profile })).toEqual({
          kind: 'ProfileDrift',
        });
      }
      expect(
        await DockerRunEnvironment.open({
          ...opening,
          environmentCompatibility: {
            ...opening.environmentCompatibility,
            nodeVersion: '0.0.0',
          },
        }),
      ).toEqual({ kind: 'ProfileDrift' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
