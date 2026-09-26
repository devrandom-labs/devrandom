import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { decodeEvidenceArtifact } from '@devrandom/protocol';
import type { HarnessProposalRecords } from '../application/propose-harness-authority.js';
/** Immutable local authority-attempt evidence; successful return follows fsync of both exact artifacts. */
export class FileHarnessProposalRecords implements HarnessProposalRecords {
  readonly #directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('Absolute proposal record directory required');
    this.#directory = directory;
  }
  async record(
    input: Parameters<HarnessProposalRecords['record']>[0],
  ): ReturnType<HarnessProposalRecords['record']> {
    try {
      const ownerUid = process.getuid?.();
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.#directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o777) !== 0o700 ||
        directory.uid !== ownerUid
      )
        return { kind: 'Unavailable' };
      for (const entry of [input.proposal, input.receipt]) {
        if (
          entry.bytes.byteLength > 16384 ||
          decodeEvidenceArtifact(entry.artifact, entry.bytes).kind !== 'Accepted'
        )
          return { kind: 'Unavailable' };
        const path = join(this.#directory, `${entry.artifact.d}.json`);
        try {
          const file = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o400,
          );
          try {
            await file.writeFile(entry.bytes);
            await file.sync();
          } finally {
            await file.close();
          }
        } catch (cause) {
          if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.uid !== ownerUid ||
              (stat.mode & 0o777) !== 0o400 ||
              stat.size !== entry.bytes.byteLength ||
              !(await file.readFile()).equals(entry.bytes)
            )
              return { kind: 'Unavailable' };
          } finally {
            await file.close();
          }
        }
      }
      const handle = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { kind: 'Recorded' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
