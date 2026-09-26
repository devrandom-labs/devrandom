import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { prepareEvidenceArtifact, type EvidenceArtifact } from '@devrandom/protocol';

import {
  decodeReviewedPublicAnalogy,
  type ReviewedPublicAnalogy,
} from '../application/review-public-analogy.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

export type PublicAnalogyReviewReading =
  | {
      readonly kind: 'Read';
      readonly artifact: EvidenceArtifact;
      readonly review: ReviewedPublicAnalogy;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'NotFound' | 'Unavailable' };

/** Parent-local SAIDed review custody; H0 application rechecks current hosted source on every use. */
export class FilePublicAnalogyReviews {
  readonly #directory: string;
  constructor(directory: string) {
    this.#directory = directory;
  }

  async commit(
    review: ReviewedPublicAnalogy,
  ): Promise<
    | { readonly kind: 'Committed' | 'AlreadyCommitted'; readonly artifact: EvidenceArtifact }
    | { readonly kind: 'Rejected' | 'Unavailable' }
  > {
    const bytes = new TextEncoder().encode(JSON.stringify(review));
    if (decodeReviewedPublicAnalogy(bytes).kind !== 'Accepted') return { kind: 'Rejected' };
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') return { kind: 'Rejected' };
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) return { kind: 'Rejected' };
      const path = join(this.#directory, `${prepared.artifact.d}.json`);
      let file;
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'Unavailable' };
        const existing = await this.read(prepared.artifact.d);
        return existing.kind === 'Read' && Buffer.from(existing.bytes).equals(bytes)
          ? { kind: 'AlreadyCommitted', artifact: existing.artifact }
          : { kind: 'Rejected' };
      }
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const directoryFile = await open(this.#directory, constants.O_RDONLY);
      try {
        await directoryFile.sync();
      } finally {
        await directoryFile.close();
      }
      return { kind: 'Committed', artifact: prepared.artifact };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async read(artifactSaid: string): Promise<PublicAnalogyReviewReading> {
    if (!said.test(artifactSaid)) return { kind: 'NotFound' };
    const path = join(this.#directory, `${artifactSaid}.json`);
    try {
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
        return { kind: 'Unavailable' };
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 1 ||
        stat.size > 8 * 1024
      )
        return { kind: 'Unavailable' };
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(await file.readFile());
      } finally {
        await file.close();
      }
      const decoded = decodeReviewedPublicAnalogy(bytes);
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (
        decoded.kind !== 'Accepted' ||
        prepared.kind !== 'Prepared' ||
        prepared.artifact.d !== artifactSaid
      )
        return { kind: 'Unavailable' };
      return { kind: 'Read', artifact: prepared.artifact, review: decoded.analogy, bytes };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'NotFound' }
        : { kind: 'Unavailable' };
    }
  }
}
