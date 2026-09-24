import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('installed devrandom command', () => {
  it('runs its package bin without a generated environment handoff', async () => {
    const { stdout, stderr } = await execFileAsync('node_modules/.bin/devrandom', ['--help'], {
      env: process.env,
    });

    expect(stdout).toContain('Usage: devrandom');
    expect(stdout).toContain('status');
    expect(stderr).toBe('');
  });

  it('keeps the service dotenv and Atlas configuration outside the CLI boundary', async () => {
    const [manifest, main, justfile] = await Promise.all([
      readFile('apps/cli/package.json', 'utf8'),
      readFile('apps/cli/src/main.ts', 'utf8'),
      readFile('justfile', 'utf8'),
    ]);

    expect(manifest).toContain('"devrandom": "dist/main.js"');
    expect(main).not.toContain('DEVRANDOM_ATLAS');
    expect(main).not.toContain('--env-file');
    expect(justfile).not.toContain('DEVRANDOM_CLI_ENV_FILE');
    await expect(access('apps/cli/bin/devrandom')).rejects.toThrow();
  });
});
