import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  dirname as posixDirname,
  join as posixJoin,
  resolve as posixResolve,
} from 'node:path/posix';

import type { EvaluationMount } from './docker-compartment.js';

/**
 * SHA-256 over the mounted runtime namespace. Each sorted container destination is
 * followed by sorted relative paths, entry kind, mode, and exact regular-file bytes
 * (or symlink target text). Host paths and timestamps are deliberately excluded.
 */
export async function digestEvaluationRuntimeMounts(
  mounts: readonly EvaluationMount[],
): Promise<string> {
  if (mounts.length === 0 || mounts.some((mount) => mount.writable))
    throw new Error('Evaluation runtime mounts must be nonempty and read-only.');
  const destinations = new Set(mounts.map((mount) => mount.containerPath));
  if (destinations.size !== mounts.length)
    throw new Error('Evaluation runtime mount destination repeated.');
  const hash = createHash('sha256');
  let totalBytes = 0;
  const field = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(Buffer.from(`${String(bytes.length)}:`, 'ascii'));
    hash.update(bytes);
  };
  const visit = async (path: string, relative: string, containerPath: string): Promise<void> => {
    const before = await lstat(path);
    field(relative);
    field(String(before.mode & 0o7777));
    if (before.isSymbolicLink()) {
      field('link');
      const target = await readlink(path);
      const resolved = posixResolve(posixDirname(containerPath), target);
      if (!resolved.startsWith('/app/'))
        throw new Error('Evaluation runtime symlink escapes its read-only namespace.');
      field(target);
      return;
    }
    if (before.isDirectory()) {
      field('directory');
      const entries = await readdir(path);
      entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const entry of entries)
        await visit(
          join(path, entry),
          relative === '.' ? entry : `${relative}/${entry}`,
          posixJoin(containerPath, entry),
        );
      const after = await lstat(path);
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs)
        throw new Error('Evaluation runtime directory changed during digest.');
      return;
    }
    if (!before.isFile()) throw new Error('Evaluation runtime mount contains an unsafe entry.');
    field('file');
    field(String(before.size));
    totalBytes += before.size;
    if (totalBytes > 1024 * 1024 * 1024)
      throw new Error('Evaluation runtime mount exceeds digest limit.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      if (held.ino !== before.ino || held.size !== before.size)
        throw new Error('Evaluation runtime file changed before digest.');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== bytes.length ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error('Evaluation runtime file changed during digest.');
      hash.update(bytes);
    } finally {
      await handle.close();
    }
  };
  for (const mount of [...mounts].sort((a, b) =>
    a.containerPath.localeCompare(b.containerPath, 'en'),
  )) {
    field('mount');
    field(mount.containerPath);
    if (!mount.containerPath.startsWith('/app/'))
      throw new Error('Evaluation runtime mount lies outside the read-only namespace.');
    await visit(mount.hostPath, '.', mount.containerPath);
  }
  return `sha256:${hash.digest('hex')}`;
}
