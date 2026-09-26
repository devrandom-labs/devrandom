import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { DockerEvaluationCompartment } from '../evaluation/infrastructure/docker-compartment.js';

const runFile = promisify(execFile);
const said = (character: string): string => `E${character.repeat(43)}`;

describe.skipIf(process.env.DEVRANDOM_RUN_OCI_TEST !== '1')(
  'real Linux H1 Cargo command graph',
  () => {
    it('runs all declared locked public test argv through a direct nonroot Cargo binary without network', async () => {
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const root = await mkdtemp(resolve('.run-cargo-proof-'));
      try {
        const worktree = join(root, 'worktree');
        await cp(resolve('fixtures/cesr-receipt-service'), worktree, { recursive: true });
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
            cpuCount: 2,
            memoryBytes: 1024 * 1024 * 1024,
            processCount: 64,
            scratchBytes: 128 * 1024 * 1024,
            outputBytes: 512 * 1024,
            wallTimeSeconds: 180,
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
        const toolchain = await runFile(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--user',
            '65534:65534',
            image,
            'node',
            '-e',
            [
              "const fs=require('node:fs');",
              "const crypto=require('node:crypto');",
              "const root='/usr/local/rustup/toolchains';",
              "const names=fs.readdirSync(root).filter(name=>name.includes('aarch64'));",
              'const entries=names.map(name=>({name,cargo:`${root}/${name}/bin/cargo`,rustc:`${root}/${name}/bin/rustc`}));',
              "const files=entries.filter(entry=>fs.existsSync(entry.cargo)&&fs.existsSync(entry.rustc)).map(entry=>({...entry,cargoRealpath:fs.realpathSync(entry.cargo),rustcRealpath:fs.realpathSync(entry.rustc),cargoSha256:crypto.createHash('sha256').update(fs.readFileSync(entry.cargo)).digest('hex'),rustcSha256:crypto.createHash('sha256').update(fs.readFileSync(entry.rustc)).digest('hex')}));",
              'process.stdout.write(JSON.stringify(files));',
            ].join(''),
          ],
          { timeout: 30000, maxBuffer: 64 * 1024 },
        );
        const candidates = JSON.parse(toolchain.stdout) as {
          name: string;
          cargo: string;
          rustc: string;
          cargoRealpath: string;
          rustcRealpath: string;
          cargoSha256: string;
          rustcSha256: string;
        }[];
        expect(candidates.length).toBeGreaterThan(0);
        const selected = candidates[0];
        if (selected === undefined) return;
        expect(selected.cargo).toBe(selected.cargoRealpath);
        expect(selected.rustc).toBe(selected.rustcRealpath);
        const cases = ['cesr-current', 'cesr-tamper', 'cesr-legacy'] as const;
        const outcomes: { caseId: string; exitCode: number | null; output: string }[] = [];
        for (const caseId of cases) {
          const opened = await DockerEvaluationCompartment.open({
            profile: prepared.profile,
            image,
            mounts: [{ hostPath: worktree, containerPath: '/work/source', writable: true }],
            signal: new AbortController().signal,
          });
          expect(opened.kind).toBe('Opened');
          if (opened.kind !== 'Opened') return;
          try {
            const command = opened.compartment.executeAt('/work/source', [
              selected.cargo,
              'test',
              '--locked',
              '--test',
              caseId,
            ]);
            let text = '';
            command.stdout.on('data', (chunk: Buffer) => {
              text += String(chunk);
            });
            command.stderr.on('data', (chunk: Buffer) => {
              text += String(chunk);
            });
            const exitCode = await new Promise<number | null>((resolveClose) =>
              command.once('close', resolveClose),
            );
            outcomes.push({ caseId, exitCode, output: text.slice(0, 8192) });
            expect(text).toContain('Running tests/');
          } finally {
            expect(await opened.compartment.close()).toBe(true);
          }
        }
        process.stdout.write(
          `${JSON.stringify({
            kind: 'LinuxCargoCommandGraph',
            image,
            cargo: selected.cargo,
            cargoSha256: selected.cargoSha256,
            rustc: selected.rustc,
            rustcSha256: selected.rustcSha256,
            outcomes: outcomes.map(({ caseId, exitCode }) => ({ caseId, exitCode })),
          })}\n`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 180000);
  },
);
