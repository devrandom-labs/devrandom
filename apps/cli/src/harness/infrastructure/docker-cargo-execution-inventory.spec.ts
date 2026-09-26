import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { prepareEvaluationExecutionProfile, prepareEvidenceArtifact } from '@devrandom/protocol';
import { DockerRunEnvironment } from '@devrandom/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { DockerCargoExecutionInventory } from './docker-cargo-execution-inventory.js';

const runFile = promisify(execFile);
const said = (letter: string) => `E${letter.repeat(43)}`;
const directories: string[] = [];
const cargo = '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo';

async function oneFileRuntimeDigest(directory: string, bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  const field = (value: string) => {
    const content = Buffer.from(value);
    hash.update(Buffer.from(`${String(content.length)}:`, 'ascii'));
    hash.update(content);
  };
  const root = await stat(directory);
  const file = await stat(join(directory, 'worker.js'));
  field('mount');
  field('/app/runtime');
  field('.');
  field(String(root.mode & 0o7777));
  field('directory');
  field('worker.js');
  field(String(file.mode & 0o7777));
  field('file');
  field(String(file.size));
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await realpath(await mkdtemp(resolve('.cargo-inventory-')));
  directories.push(directory);
  await chmod(directory, 0o755);
  await writeFile(
    join(directory, 'Cargo.toml'),
    '[package]\nname = "fixture"\nversion = "0.1.0"\n',
  );
  for (const arguments_ of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Devrandom Test'],
    ['config', 'user.email', 'test@devrandom.example'],
    ['add', '.'],
    ['commit', '-m', 'source'],
  ])
    await runFile('git', arguments_, { cwd: directory });
  const commit = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  const tree = (
    await runFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: directory })
  ).stdout.trim();
  const task = taskProjectionFixture();
  const condition = task.revision.completionConditions[0];
  if (condition === undefined) throw new Error('Task fixture has no completion condition');
  const bound = {
    ...task,
    revision: {
      ...task.revision,
      repository: { objectFormat: 'sha1' as const, commit, tree },
      completionConditions: [{ ...condition, argv: ['cargo', 'test', '--locked'] }],
    },
  };
  const receipt = Buffer.from('{"observed":"pinned OCI limits"}');
  const identified = prepareEvidenceArtifact(receipt, 'application/json');
  if (identified.kind !== 'Prepared') throw new Error('receipt fixture invalid');
  const digest = `sha256:${'a'.repeat(64)}`;
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    runtimeDigest: `sha256:${'c'.repeat(64)}`,
    toolchainDigest: digest,
    sourceGitCommit: commit,
    sourceGitTree: tree,
    h1InstructionSaid: said('i'),
    h1RuntimePromptDigest: `sha256:${'d'.repeat(64)}`,
    effectiveLimitsReceiptSaid: identified.artifact.d,
    parentDeathCleanupReceiptSaid: said('p'),
    modelProvider: 'concentrate',
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
  });
  if (profile.kind !== 'Prepared') throw new Error('profile fixture invalid');
  const probe = vi.fn().mockResolvedValue({
    kind: 'Observed',
    toolchainDigest: digest,
    effectiveLimitsReceipt: receipt,
    nodeVersion: '22.15.0',
    gitVersion: '2.48.1',
  });
  const options = {
    profile: profile.profile,
    image: `pinned@sha256:${'b'.repeat(64)}`,
    runtimeMounts: [{ hostPath: directory, containerPath: '/app/runtime' }],
    worktreeDirectory: directory,
    cargoRealpath: cargo,
    probe,
  };
  return { task: bound, options, probe, receipt, digest, commit, tree };
}

describe('pinned Linux Cargo Harness inventory', () => {
  it('returns observed container versions and only the direct pinned Cargo executable', async () => {
    const { task, options, probe } = await fixture();
    const condition = task.revision.completionConditions[0];
    if (condition === undefined) throw new Error('Task fixture has no completion condition');
    expect(await new DockerCargoExecutionInventory(options).inspect(task)).toEqual({
      kind: 'Inspected',
      environmentCompatibility: {
        operatingSystem: 'linux',
        architecture: 'arm64',
        nodeVersion: '22.15.0',
        gitVersion: '2.48.1',
        piSdkVersion: '0.87.1',
        xstateVersion: '5.33.2',
      },
      commandExecutables: [{ commandId: condition.id, executableRealpath: cargo }],
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        executableRealpaths: [cargo],
        worktreeDirectory: options.worktreeDirectory,
        profile: options.profile,
      }),
    );
  });

  it.each(['Digest', 'Receipt'] as const)('rejects a forged %s observation', async (part) => {
    const { task, options, probe } = await fixture();
    probe.mockResolvedValue({
      kind: 'Observed',
      toolchainDigest:
        part === 'Digest' ? `sha256:${'e'.repeat(64)}` : options.profile.toolchainDigest,
      effectiveLimitsReceipt:
        part === 'Receipt' ? Buffer.from('{}') : Buffer.from('{"observed":"pinned OCI limits"}'),
      nodeVersion: '22.15.0',
      gitVersion: '2.48.1',
    });
    expect(await new DockerCargoExecutionInventory(options).inspect(task)).toEqual({
      kind: 'Rejected',
      reason: 'EnvironmentUnsupported',
    });
  });

  it('rejects a non-Cargo command before opening a container', async () => {
    const { task, options, probe } = await fixture();
    const condition = task.revision.completionConditions[0];
    if (condition === undefined) throw new Error('Task fixture has no completion condition');
    const changed = {
      ...task,
      revision: {
        ...task.revision,
        completionConditions: [{ ...condition, argv: ['sh', '-c', 'cargo test'] }],
      },
    };
    expect(await new DockerCargoExecutionInventory(options).inspect(changed)).toEqual({
      kind: 'Rejected',
      reason: 'CommandExecutableUnavailable',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a modified profile or source revision before opening a container', async () => {
    const { task, options, probe } = await fixture();
    expect(
      await new DockerCargoExecutionInventory({
        ...options,
        profile: { ...options.profile, toolchainDigest: `sha256:${'f'.repeat(64)}` },
      }).inspect(task),
    ).toEqual({ kind: 'Rejected', reason: 'EnvironmentUnsupported' });
    expect(
      await new DockerCargoExecutionInventory(options).inspect({
        ...task,
        revision: {
          ...task.revision,
          repository: { ...task.revision.repository, commit: 'e'.repeat(40) },
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'EnvironmentUnsupported' });
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.DEVRANDOM_CARGO_INVENTORY_OCI_TEST !== '1')(
    'reopens the pinned Linux image and returns only its observed Cargo inventory',
    async () => {
      const { task, options } = await fixture();
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const imageDigest = image.slice(image.lastIndexOf('@') + 1);
      const runtimeDirectory = await mkdtemp(resolve('.cargo-runtime-'));
      directories.push(runtimeDirectory);
      await chmod(runtimeDirectory, 0o755);
      const worker = Buffer.from('process.stdout.write("ok");\n');
      await writeFile(join(runtimeDirectory, 'worker.js'), worker);
      const runtimeMounts = [{ hostPath: runtimeDirectory, containerPath: '/app/runtime' }];
      const runtimeDigest = await oneFileRuntimeDigest(runtimeDirectory, worker);
      const base = Object.fromEntries(
        Object.entries(options.profile).filter(
          ([name]) => !['version', 'd', 'kind'].includes(name),
        ),
      );
      const draft = prepareEvaluationExecutionProfile({
        ...base,
        imageDigest,
        runtimeDigest,
        toolchainDigest: `sha256:${'0'.repeat(64)}`,
        effectiveLimitsReceiptSaid: said('l'),
      });
      expect(draft.kind).toBe('Prepared');
      if (draft.kind !== 'Prepared') return;
      const observed = await DockerRunEnvironment.probe({
        profile: draft.profile,
        image,
        runtimeMounts,
        worktreeDirectory: options.worktreeDirectory,
        executableRealpaths: [cargo],
        signal: new AbortController().signal,
      });
      expect(observed.kind).toBe('Observed');
      if (observed.kind !== 'Observed') return;
      const receipt = prepareEvidenceArtifact(observed.effectiveLimitsReceipt, 'application/json');
      expect(receipt.kind).toBe('Prepared');
      if (receipt.kind !== 'Prepared') return;
      const final = prepareEvaluationExecutionProfile({
        ...base,
        imageDigest,
        runtimeDigest,
        toolchainDigest: observed.toolchainDigest,
        effectiveLimitsReceiptSaid: receipt.artifact.d,
      });
      expect(final.kind).toBe('Prepared');
      if (final.kind !== 'Prepared') return;
      const inventory = await new DockerCargoExecutionInventory({
        profile: final.profile,
        image,
        runtimeMounts,
        worktreeDirectory: options.worktreeDirectory,
        cargoRealpath: cargo,
      }).inspect(task);
      expect(inventory).toEqual({
        kind: 'Inspected',
        environmentCompatibility: {
          operatingSystem: 'linux',
          architecture: 'arm64',
          nodeVersion: observed.nodeVersion,
          gitVersion: observed.gitVersion,
          piSdkVersion: '0.87.1',
          xstateVersion: '5.33.2',
        },
        commandExecutables: [
          { commandId: task.revision.completionConditions[0]?.id, executableRealpath: cargo },
        ],
      });
    },
    120_000,
  );
});
