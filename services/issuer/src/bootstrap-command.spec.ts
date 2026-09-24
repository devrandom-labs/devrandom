import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('devrandom-issuer bootstrap command', () => {
  it('rejects missing bootstrap configuration through the real process boundary', () => {
    const command = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'main.ts'), 'bootstrap'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVRANDOM_ISSUER_BRAN: '',
          PORT: 'not-a-port',
        },
      },
    );

    expect(command.status).toBe(2);
    expect(command.stdout).toBe('');
    expect(command.stderr).toContain('DEVRANDOM_ISSUER_BRAN');
    expect(command.stderr).not.toContain('0123456789abcdefghijk');
  });
});
