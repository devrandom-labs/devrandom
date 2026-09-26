import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('standalone pitch application boundary', () => {
  it('offers a browser app with production build, start, and interactive smoke commands', async () => {
    const source = await readFile('apps/demo/package.json', 'utf8');
    expect(JSON.parse(source)).toMatchObject({
      name: '@devrandom/demo',
      scripts: { build: 'next build', start: 'next start', smoke: 'playwright test' },
      dependencies: { next: '16.3.6', '@mui/material': '9.4.0' },
    });
  });
});
