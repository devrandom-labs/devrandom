import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  decodeEvaluationSourceInventory,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';

const maximumBytes = 64 * 1024;

export type QualifiedSourceInventoryRecording =
  | { readonly kind: 'Recorded'; readonly inventorySaid: string; readonly path: string }
  | { readonly kind: 'Unavailable' };

/** Exact parent-local inventory custody, created only after fresh Q/mandate/raw checks. */
export class QualifiedSourceInventoryFile {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async commit(inventory: EvaluationSourceInventory): Promise<QualifiedSourceInventoryRecording> {
    if (decodeEvaluationSourceInventory(inventory).kind !== 'Accepted')
      return { kind: 'Unavailable' };
    const bytes = new TextEncoder().encode(JSON.stringify(inventory));
    if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) return { kind: 'Unavailable' };
    const path = join(this.#directory, `${inventory.d}.json`);
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.#directory);
      if (
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && directory.uid !== process.getuid())
      )
        return { kind: 'Unavailable' };
      let file;
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'Unavailable' };
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await existing.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0 ||
            stat.size !== bytes.byteLength ||
            (process.getuid !== undefined && stat.uid !== process.getuid())
          )
            return { kind: 'Unavailable' };
          const current = await existing.readFile();
          return current.equals(bytes)
            ? { kind: 'Recorded', inventorySaid: inventory.d, path }
            : { kind: 'Unavailable' };
        } finally {
          await existing.close();
        }
      }
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const directoryFile = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directoryFile.sync();
      } finally {
        await directoryFile.close();
      }
      return { kind: 'Recorded', inventorySaid: inventory.d, path };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
