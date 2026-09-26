import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { maximumEvaluationVerifierBundleBytes } from '@devrandom/protocol';

import type { EvaluationCaseInventory } from '../application/observe-protected-trial-artifact.js';

/** Private parent-only custody for the raw, immutable M-bound verifier bundle. */
export class FileEvaluationCaseInventory implements EvaluationCaseInventory {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async open(
    manifest: Parameters<EvaluationCaseInventory['open']>[0],
  ): ReturnType<EvaluationCaseInventory['open']> {
    if (!/^[A-Z][A-Za-z0-9_-]{43}$/u.test(manifest.verifierSaid)) return { kind: 'Missing' };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
        return { kind: 'Unavailable' };
      file = await open(
        join(this.directory, manifest.verifierSaid),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const before = await file.stat();
      if (
        !before.isFile() ||
        (before.mode & 0o077) !== 0 ||
        before.size === 0 ||
        before.size > maximumEvaluationVerifierBundleBytes
      )
        return { kind: 'Unavailable' };
      const bytes = await file.readFile();
      const after = await file.stat();
      if (
        bytes.byteLength !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        return { kind: 'Unavailable' };
      return { kind: 'Opened', bytes };
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? { kind: 'Missing' }
        : { kind: 'Unavailable' };
    } finally {
      await file?.close();
    }
  }
}
