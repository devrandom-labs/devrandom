import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const runFile = promisify(execFile);

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'runtime-owned parent death cleanup',
  () => {
    it('removes the OCI subtree after the parent receives SIGKILL', async () => {
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const probe = spawn(
        process.execPath,
        [resolve('packages/runtime/dist/evaluation/infrastructure/parent-death-probe.js'), image],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            NODE_ENV: 'production',
          },
        },
      );
      let name = '';
      try {
        const line = await new Promise<string>((resolveLine, reject) => {
          let output = '';
          const timeout = setTimeout(() => {
            reject(new Error('OCI probe did not open.'));
          }, 10_000);
          probe.stdout.on('data', (chunk: Buffer) => {
            output += String(chunk);
            if (output.includes('\n')) {
              clearTimeout(timeout);
              resolveLine(output.split('\n')[0] ?? '');
            }
          });
          probe.once('close', (code) => {
            clearTimeout(timeout);
            reject(new Error(`OCI probe exited ${String(code)}`));
          });
        });
        name = (JSON.parse(line) as { name: string }).name;
        expect(name).toMatch(/^devrandom-evaluation-[0-9a-f-]{36}$/u);
        probe.kill('SIGKILL');
        let remaining = 'unknown';
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const result = await runFile('docker', [
            'ps',
            '-a',
            '--filter',
            `name=^/${name}$`,
            '--format',
            '{{.ID}}',
          ]);
          remaining = result.stdout.trim();
          if (remaining === '') break;
          await new Promise((wait) => setTimeout(wait, 500));
        }
        expect(remaining).toBe('');
      } finally {
        probe.kill('SIGKILL');
        if (name !== '') {
          try {
            await runFile('docker', ['rm', '-f', name]);
          } catch {
            /* already removed */
          }
        }
      }
    }, 30_000);
  },
);
