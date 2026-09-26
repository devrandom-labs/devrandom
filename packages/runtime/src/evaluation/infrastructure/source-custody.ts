import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { prepareEvidenceArtifact } from '@devrandom/protocol';

export interface SourceCaptureLimits {
  readonly maximumFiles: number;
  readonly maximumBytes: number;
  readonly maximumPathBytes: number;
}

interface SourceFile {
  readonly path: string;
  readonly length: number;
  readonly digest: string;
}

export type SourceCapture =
  | { readonly kind: 'Captured'; readonly sourceSaid: string; readonly path: string }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'UnsafeSource' | 'WriterSurvived' | 'LimitExceeded';
    };

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(path: string, maximumPathBytes: number): boolean {
  return (
    path.length > 0 &&
    Buffer.byteLength(path) <= maximumPathBytes &&
    !path.split(sep).some((part) => part === '' || part === '.' || part === '..') &&
    !path.includes('\\') &&
    !Array.from(path).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

/** Parent-owned custody freezes a stopped worker's actual source bytes. */
export class SourceCustody {
  readonly #root: string;
  readonly #limits: SourceCaptureLimits;

  constructor(root: string, limits: SourceCaptureLimits) {
    if (
      !Number.isSafeInteger(limits.maximumFiles) ||
      !Number.isSafeInteger(limits.maximumBytes) ||
      !Number.isSafeInteger(limits.maximumPathBytes) ||
      limits.maximumFiles < 1 ||
      limits.maximumBytes < 1 ||
      limits.maximumPathBytes < 1
    ) {
      throw new Error('Invalid source capture limits.');
    }
    this.#root = resolve(root);
    this.#limits = limits;
  }

  async capture(sourceRoot: string, writerAlive: () => Promise<boolean>): Promise<SourceCapture> {
    if (await writerAlive()) return { kind: 'Rejected', reason: 'WriterSurvived' };
    const source = resolve(sourceRoot);
    const temp = join(this.#root, `.capture-${randomUUID()}`);
    await mkdir(join(temp, 'files'), { recursive: true, mode: 0o700 });
    const files: SourceFile[] = [];
    let totalBytes = 0;
    let rejected: SourceCapture | undefined;
    try {
      const rootStat = await lstat(source);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { kind: 'Rejected', reason: 'UnsafeSource' };
      }
      const visit = async (directory: string): Promise<void> => {
        const entries = await opendir(directory);
        for await (const entry of entries) {
          const path = join(directory, entry.name);
          const relativePath = relative(source, path);
          if (!safeRelativePath(relativePath, this.#limits.maximumPathBytes)) {
            rejected = { kind: 'Rejected', reason: 'UnsafeSource' };
            return;
          }
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || (stat.mode & 0o6000) !== 0) {
            rejected = { kind: 'Rejected', reason: 'UnsafeSource' };
            return;
          }
          if (stat.isDirectory()) {
            await mkdir(join(temp, 'files', relativePath), { mode: 0o700 });
            await visit(path);
            if (rejected !== undefined) return;
            continue;
          }
          if (!stat.isFile() || stat.nlink !== 1) {
            rejected = { kind: 'Rejected', reason: 'UnsafeSource' };
            return;
          }
          if (
            files.length >= this.#limits.maximumFiles ||
            totalBytes + stat.size > this.#limits.maximumBytes
          ) {
            rejected = { kind: 'Rejected', reason: 'LimitExceeded' };
            return;
          }
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.ino !== stat.ino || before.size !== stat.size) {
              rejected = { kind: 'Rejected', reason: 'UnsafeSource' };
              return;
            }
            bytes = await handle.readFile();
            const after = await handle.stat();
            if (
              after.ino !== before.ino ||
              after.size !== bytes.length ||
              after.mtimeMs !== before.mtimeMs
            ) {
              rejected = { kind: 'Rejected', reason: 'UnsafeSource' };
              return;
            }
          } finally {
            await handle.close();
          }
          await writeFile(join(temp, 'files', relativePath), bytes, { flag: 'wx', mode: 0o400 });
          files.push({ path: relativePath, length: bytes.length, digest: digest(bytes) });
          totalBytes += bytes.length;
        }
      };
      await visit(source);
      if (rejected !== undefined) return rejected;
      if (await writerAlive()) return { kind: 'Rejected', reason: 'WriterSurvived' };
      files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      const manifest = Buffer.from(JSON.stringify({ version: 1, files }), 'utf8');
      const identified = prepareEvidenceArtifact(manifest, 'application/json');
      if (identified.kind !== 'Prepared') return { kind: 'Rejected', reason: 'LimitExceeded' };
      await writeFile(join(temp, 'manifest.json'), manifest, { flag: 'wx', mode: 0o400 });
      const destination = join(this.#root, identified.artifact.d);
      try {
        await rename(temp, destination);
      } catch (cause) {
        if (!(
          cause instanceof Error &&
          'code' in cause &&
          ['EEXIST', 'ENOTEMPTY'].includes(String(cause.code))
        ))
          throw cause;
        if ((await this.open(identified.artifact.d)) === undefined)
          return { kind: 'Rejected', reason: 'UnsafeSource' };
      }
      return {
        kind: 'Captured',
        sourceSaid: identified.artifact.d,
        path: join(destination, 'files'),
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async open(sourceSaid: string): Promise<
    | {
        readonly manifestBytes: Uint8Array;
        readonly files: readonly { path: string; bytes: Uint8Array }[];
      }
    | undefined
  > {
    if (!/^[A-Z][A-Za-z0-9_-]{43}$/u.test(sourceSaid)) return undefined;
    const root = join(this.#root, sourceSaid);
    try {
      const manifest = await readFile(join(root, 'manifest.json'));
      const identified = prepareEvidenceArtifact(manifest, 'application/json');
      if (identified.kind !== 'Prepared' || identified.artifact.d !== sourceSaid) return undefined;
      const candidate: unknown = JSON.parse(manifest.toString('utf8'));
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !('files' in candidate) ||
        !Array.isArray(candidate.files)
      )
        return undefined;
      const files: { path: string; bytes: Uint8Array }[] = [];
      for (const file of candidate.files as SourceFile[]) {
        if (
          typeof file.path !== 'string' ||
          !safeRelativePath(file.path, this.#limits.maximumPathBytes) ||
          typeof file.length !== 'number' ||
          typeof file.digest !== 'string'
        )
          return undefined;
        const path = join(root, 'files', file.path);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined;
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const bytes = await handle.readFile();
        await handle.close();
        if (bytes.length !== file.length || digest(bytes) !== file.digest) return undefined;
        files.push({ path: file.path, bytes });
      }
      return { manifestBytes: Uint8Array.from(manifest), files };
    } catch {
      return undefined;
    }
  }
}
