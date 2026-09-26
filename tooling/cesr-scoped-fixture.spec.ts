import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { materializeCesrReceiptFixture } from './cesr-receipt-fixture.js';

const run = promisify(execFile);

it('preserves the real flat repair but requires the disclosed nested and large compatibility extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-scoped-cesr-'));
  try {
    const fixture = await materializeCesrReceiptFixture({
      templateRoot: resolve('fixtures/cesr-scoped-receipt-service'),
      taskTemplate: resolve('fixtures/cesr-scoped-compat.task.json'),
      destination: join(root, 'source'),
    });
    const source = await readFile(join(fixture.worktree, 'src/lib.rs'));
    const provenance: { sourceSha256: string } = JSON.parse(
      await readFile(join(fixture.worktree, 'SOURCE-PROVENANCE.json'), 'utf8'),
    ) as { sourceSha256: string };
    expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.sourceSha256);
    for (const name of ['cesr-current', 'cesr-tamper']) {
      expect(
        (await run('cargo', ['test', '--locked', '--test', name], { cwd: fixture.worktree }))
          .stderr,
      ).toContain('Finished');
    }
    await expect(
      run('cargo', ['test', '--locked', '--test', 'cesr-legacy'], { cwd: fixture.worktree }),
    ).rejects.toMatchObject({ code: 101 });
    await writeFile(
      join(fixture.worktree, 'src/lib.rs'),
      await readFile(resolve('tooling/fixtures/cesr-scoped-reference.rs')),
    );
    expect((await run('cargo', ['test', '--locked'], { cwd: fixture.worktree })).stdout).toContain(
      'test result: ok.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('rejects an unknown public materializer profile before creating source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-scoped-profile-'));
  try {
    await expect(
      run(process.execPath, [
        '--import',
        'tsx',
        'tooling/cesr-receipt-fixture.ts',
        join(root, 'source'),
        'unreviewed-profile',
      ]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(join(root, 'source', 'src/lib.rs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
