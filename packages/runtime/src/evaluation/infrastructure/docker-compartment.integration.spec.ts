import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { DockerEvaluationCompartment } from './docker-compartment.js';

const runFile = promisify(execFile);
const said = (character: string): string => `E${character.repeat(43)}`;

describe.skipIf(process.env.DEVRANDOM_OCI_TEST !== '1')(
  'real Docker evaluation compartment',
  () => {
    it('reports effective limits, blocks network and closes its process tree', async () => {
      const image = (
        await runFile('docker', [
          'image',
          'inspect',
          'node:24-slim',
          '--format',
          '{{index .RepoDigests 0}}',
        ])
      ).stdout.trim();
      const digest = image.slice(image.lastIndexOf('@') + 1);
      const prepared = prepareEvaluationExecutionProfile({
        os: 'linux',
        architecture: 'aarch64',
        imageDigest: digest,
        runtimeDigest: `sha256:${'1'.repeat(64)}`,
        toolchainDigest: `sha256:${'2'.repeat(64)}`,
        sourceGitCommit: '3'.repeat(40),
        sourceGitTree: '4'.repeat(40),
        h1InstructionSaid: said('i'),
        h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
        effectiveLimitsReceiptSaid: said('l'),
        parentDeathCleanupReceiptSaid: said('p'),
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
          wallTimeSeconds: 20,
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
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') return;
      const opened = await DockerEvaluationCompartment.open({
        profile: prepared.profile,
        image,
        mounts: [],
        signal: new AbortController().signal,
      });
      expect(opened.kind).toBe('Opened');
      if (opened.kind !== 'Opened') return;
      const { compartment, effectiveLimitsReceipt } = opened;
      try {
        const inspected = JSON.parse(effectiveLimitsReceipt) as [
          {
            HostConfig: {
              ReadonlyRootfs: boolean;
              NetworkMode: string;
              Memory: number;
              PidsLimit: number;
            };
          },
        ];
        expect(inspected[0].HostConfig).toMatchObject({
          ReadonlyRootfs: true,
          NetworkMode: 'none',
          Memory: 128 * 1024 * 1024,
          PidsLimit: 16,
        });
        const child = compartment.execute([
          'node',
          '-e',
          'process.stdout.write(`${process.getuid()}:${process.getgid()}`)',
        ]);
        let output = '';
        for await (const chunk of child.stdout) output += String(chunk);
        expect(output).toBe('65534:65534');
        const createWorktree = compartment.execute(['mkdir', '/work/source']);
        expect(
          await new Promise<number | null>((resolve) => createWorktree.once('close', resolve)),
        ).toBe(0);
        const cwd = compartment.executeAt('/work/source', ['pwd']);
        let observedCwd = '';
        for await (const chunk of cwd.stdout) observedCwd += String(chunk);
        expect(observedCwd.trim()).toBe('/work/source');
      } finally {
        expect(await compartment.close()).toBe(true);
      }
    });

    it('removes a detached background child left by a native command', async () => {
      const image = (
        await runFile('docker', [
          'image',
          'inspect',
          'devrandom-evaluation-tools:prd03',
          '--format',
          '{{.Id}}',
        ])
      ).stdout.trim();
      const prepared = prepareEvaluationExecutionProfile({
        os: 'linux',
        architecture: 'aarch64',
        imageDigest: image,
        runtimeDigest: `sha256:${'1'.repeat(64)}`,
        toolchainDigest: `sha256:${'2'.repeat(64)}`,
        sourceGitCommit: '3'.repeat(40),
        sourceGitTree: '4'.repeat(40),
        h1InstructionSaid: said('i'),
        h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
        effectiveLimitsReceiptSaid: said('l'),
        parentDeathCleanupReceiptSaid: said('p'),
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
          wallTimeSeconds: 30,
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
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') return;
      const opened = await DockerEvaluationCompartment.open({
        profile: prepared.profile,
        image,
        mounts: [],
        signal: new AbortController().signal,
      });
      expect(opened.kind).toBe('Opened');
      if (opened.kind !== 'Opened') return;
      const inspected = JSON.parse(opened.effectiveLimitsReceipt) as [{ Name: string }];
      const name = inspected[0].Name.slice(1);
      try {
        const child = opened.compartment.execute([
          'node',
          '-e',
          'const {spawn}=require("node:child_process"); spawn("sleep",["30"],{detached:true,stdio:"ignore"}).unref();',
        ]);
        expect(await new Promise<number | null>((resolve) => child.once('close', resolve))).toBe(0);
        const background = await runFile('docker', ['top', name]);
        expect(background.stdout).toContain('sleep 30');
      } finally {
        expect(await opened.compartment.close()).toBe(true);
      }
      const remaining = await runFile('docker', [
        'ps',
        '-a',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.ID}}',
      ]);
      expect(remaining.stdout.trim()).toBe('');
    });
  },
);
