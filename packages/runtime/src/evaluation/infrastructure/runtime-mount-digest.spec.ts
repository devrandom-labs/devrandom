import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { digestEvaluationRuntimeMounts } from './runtime-mount-digest.js';

describe('contained runtime mount digest', () => {
  it('binds exact mounted bytes and rejects a symlink into worker-writable scratch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-runtime-digest-'));
    try {
      await mkdir(join(root, 'runtime'));
      await writeFile(join(root, 'runtime', 'worker.js'), 'first');
      const mounts = [
        { hostPath: join(root, 'runtime'), containerPath: '/app/runtime', writable: false },
      ];
      const first = await digestEvaluationRuntimeMounts(mounts);
      await writeFile(join(root, 'runtime', 'worker.js'), 'second');
      const second = await digestEvaluationRuntimeMounts(mounts);
      expect(second).not.toBe(first);
      await symlink('/work/source/worker.js', join(root, 'runtime', 'alternate.js'));
      await expect(digestEvaluationRuntimeMounts(mounts)).rejects.toThrow(/symlink escapes/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
