import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Linux CI policy', () => {
  it('enters the Nix flake and runs the complete repository gate on Linux', async () => {
    const workflow = await readFile(resolve('.github/workflows/check.yml'), 'utf8');

    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('run: nix develop --command just bootstrap');
    expect(workflow).toContain('run: nix develop --command just check');
    expect(workflow).toContain('run: nix develop --command just test-integration');
  });
});
