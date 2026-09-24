import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('version audit command', () => {
  it('is exposed through the repository command surface', async () => {
    const { stdout } = await execFileAsync('just', ['--list']);

    expect(stdout).toContain('version-audit');
  });
});
