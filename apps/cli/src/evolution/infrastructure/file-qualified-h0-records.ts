import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from '@devrandom/protocol';

import type { QualifiedH0Records } from '../application/progress-qualified-h0.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumBytes = 64 * 1024;

function boundEvaluationId(bytes: Uint8Array): string | undefined {
  try {
    const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof document !== 'object' || document === null || Array.isArray(document))
      return undefined;
    const candidate = document as { version?: unknown; kind?: unknown; evaluationId?: unknown };
    return candidate.version === 1 &&
      candidate.kind === 'QualifiedH0Progress' &&
      typeof candidate.evaluationId === 'string' &&
      uuid.test(candidate.evaluationId)
      ? candidate.evaluationId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exact parent-local H0 output artifact, written after hosted reservation and raw influence proof. */
export class FileQualifiedH0Records implements QualifiedH0Records {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async commit(input: {
    readonly evaluationId: string;
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }): ReturnType<QualifiedH0Records['commit']> {
    if (
      !uuid.test(input.evaluationId) ||
      input.bytes.byteLength < 2 ||
      input.bytes.byteLength > maximumBytes ||
      input.artifact.mediaType !== 'application/json' ||
      decodeEvidenceArtifact(input.artifact, input.bytes).kind !== 'Accepted' ||
      boundEvaluationId(input.bytes) !== input.evaluationId
    )
      return { kind: 'Conflict' };
    const path = join(this.#directory, `${input.artifact.d}.json`);
    try {
      if (!(await this.#directoryReady(true))) return { kind: 'Conflict' };
      const current = await this.inspectEvaluation(input.evaluationId);
      if (current.kind === 'Read')
        return current.artifact.d === input.artifact.d &&
          Buffer.from(current.bytes).equals(input.bytes)
          ? { kind: 'AlreadyCommitted', artifactSaid: input.artifact.d }
          : { kind: 'Conflict' };
      if (current.kind !== 'NotFound') return { kind: 'Conflict' };
      let file;
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'Unavailable' };
        const existing = await this.inspect(input.artifact.d);
        if (existing.kind !== 'Read' || !Buffer.from(existing.bytes).equals(input.bytes))
          return { kind: 'Conflict' };
      }
      if (file !== undefined) {
        try {
          await file.writeFile(input.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      let pointer;
      try {
        pointer = await open(
          join(this.#directory, `${input.evaluationId}.ref`),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'Unavailable' };
        const raced = await this.inspectEvaluation(input.evaluationId);
        return raced.kind === 'Read' &&
          raced.artifact.d === input.artifact.d &&
          Buffer.from(raced.bytes).equals(input.bytes)
          ? { kind: 'AlreadyCommitted', artifactSaid: input.artifact.d }
          : { kind: 'Conflict' };
      }
      try {
        await pointer.writeFile(input.artifact.d);
        await pointer.sync();
      } finally {
        await pointer.close();
      }
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const checked = await this.inspectEvaluation(input.evaluationId);
      return checked.kind === 'Read' &&
        checked.artifact.d === input.artifact.d &&
        Buffer.from(checked.bytes).equals(input.bytes)
        ? { kind: 'Committed', artifactSaid: input.artifact.d }
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async inspectEvaluation(
    evaluationId: string,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' | 'Unavailable' }
  > {
    if (!uuid.test(evaluationId)) return { kind: 'NotFound' };
    try {
      if (!(await this.#directoryReady(false))) return { kind: 'Unavailable' };
      const path = join(this.#directory, `${evaluationId}.ref`);
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size !== 44 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        return { kind: 'Unavailable' };
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(await file.readFile());
      } finally {
        await file.close();
      }
      const artifactSaid = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!said.test(artifactSaid)) return { kind: 'Unavailable' };
      const record = await this.inspect(artifactSaid);
      return record.kind === 'Read' && boundEvaluationId(record.bytes) === evaluationId
        ? record
        : { kind: 'Unavailable' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'NotFound' }
        : { kind: 'Unavailable' };
    }
  }

  async inspect(
    artifactSaid: string,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' | 'Unavailable' }
  > {
    if (!said.test(artifactSaid)) return { kind: 'NotFound' };
    try {
      if (!(await this.#directoryReady(false))) return { kind: 'Unavailable' };
      const path = join(this.#directory, `${artifactSaid}.json`);
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 2 ||
        stat.size > maximumBytes ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        return { kind: 'Unavailable' };
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(await file.readFile());
      } finally {
        await file.close();
      }
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      return prepared.kind === 'Prepared' && prepared.artifact.d === artifactSaid
        ? { kind: 'Read', artifact: prepared.artifact, bytes }
        : { kind: 'Unavailable' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'NotFound' }
        : { kind: 'Unavailable' };
    }
  }

  async #directoryReady(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const status = await lstat(this.#directory);
    return (
      status.isDirectory() &&
      (status.mode & 0o077) === 0 &&
      (process.getuid === undefined || status.uid === process.getuid())
    );
  }
}
