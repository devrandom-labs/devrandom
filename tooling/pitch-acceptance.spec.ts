import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectStackManifest } from './stack-policy.js';
import { findWorkspaceBoundaryViolations } from './workspace-boundaries.js';

describe('standalone pitch application boundary', () => {
  it('offers a browser app with production build, start, and interactive smoke commands', async () => {
    const source = await readFile('apps/demo/package.json', 'utf8');
    expect(JSON.parse(source)).toMatchObject({
      name: '@devrandom/demo',
      scripts: { build: 'next build', start: 'next start', smoke: 'playwright test' },
      dependencies: { next: '16.3.6', '@mui/material': '9.4.0' },
    });
  });

  it('enforces the same stack and deployable isolation for the pitch', () => {
    expect(
      inspectStackManifest('apps/demo/package.json', {
        dependencies: { next: '16.3.6', axios: '1.0.0' },
      }),
    ).toContainEqual({
      kind: 'forbidden-dependency',
      manifest: 'apps/demo/package.json',
      packageName: 'axios',
    });
    expect(
      findWorkspaceBoundaryViolations([
        {
          name: '@devrandom/demo',
          directory: 'apps/demo',
          dependencies: new Set(['@devrandom/cli']),
        },
        { name: '@devrandom/cli', directory: 'apps/cli', dependencies: new Set() },
      ]),
    ).toContainEqual({
      kind: 'deployable-imports-deployable',
      source: '@devrandom/demo',
      target: '@devrandom/cli',
    });
  });
});
