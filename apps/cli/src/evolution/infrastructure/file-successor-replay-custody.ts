import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import type { EvaluationRawArtifacts } from '@devrandom/runtime';

import type { SuccessorReplayReceiptCustody } from '../application/observe-successor-public-replay.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

/** Parent-private append-only native raw and pre-M replay receipt custody. */
export class FileSuccessorReplayCustody
  implements EvaluationRawArtifacts, SuccessorReplayReceiptCustody
{
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Successor replay custody needs an absolute root.');
    this.#root = resolve(root);
  }

  async #privateRoot(create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.#root);
      return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  async #writeExact(path: string, bytes: Uint8Array): Promise<boolean> {
    try {
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      return true;
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) return false;
      try {
        const stat = await lstat(path);
        const existing = await readFile(path);
        return (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          (stat.mode & 0o077) === 0 &&
          Buffer.from(existing).equals(Buffer.from(bytes))
        );
      } catch {
        return false;
      }
    }
  }

  async retain(
    input: Parameters<SuccessorReplayReceiptCustody['retain']>[0],
  ): ReturnType<SuccessorReplayReceiptCustody['retain']> {
    if (
      !said.test(input.artifact.d) ||
      decodeEvidenceArtifact(input.artifact, input.bytes).kind !== 'Accepted' ||
      !(await this.#privateRoot(true))
    )
      return { kind: 'Unavailable' };
    const contents = join(this.#root, input.artifact.d);
    const description = join(this.#root, `${input.artifact.d}.json`);
    const descriptor = Buffer.from(JSON.stringify(input.artifact), 'utf8');
    if (
      !(await this.#writeExact(contents, input.bytes)) ||
      !(await this.#writeExact(description, descriptor))
    )
      return { kind: 'Unavailable' };
    try {
      const directory = await open(this.#root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      return { kind: 'Unavailable' };
    }
    return { kind: 'Retained', artifactSaid: input.artifact.d };
  }

  async record(
    input: Parameters<EvaluationRawArtifacts['record']>[0],
  ): ReturnType<EvaluationRawArtifacts['record']> {
    const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
    if (prepared.kind !== 'Prepared') return { kind: 'Rejected' };
    const retained = await this.retain({ artifact: prepared.artifact, bytes: input.bytes });
    return retained.kind === 'Retained'
      ? { kind: 'Stored', artifact: prepared.artifact }
      : { kind: 'Unavailable' };
  }

  async read(artifactSaid: string): ReturnType<SuccessorReplayReceiptCustody['read']> {
    if (!said.test(artifactSaid)) return { kind: 'Unavailable' };
    if (!(await this.#privateRoot(false))) return { kind: 'Missing' };
    try {
      const contents = join(this.#root, artifactSaid);
      const description = join(this.#root, `${artifactSaid}.json`);
      const [contentStat, descriptionStat, bytes, descriptor] = await Promise.all([
        lstat(contents),
        lstat(description),
        readFile(contents),
        readFile(description),
      ]);
      if (
        [contentStat, descriptionStat].some(
          (stat) =>
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0,
        )
      )
        return { kind: 'Unavailable' };
      const parsed: unknown = JSON.parse(descriptor.toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('d' in parsed) ||
        parsed.d !== artifactSaid ||
        JSON.stringify(parsed) !== descriptor.toString('utf8')
      )
        return { kind: 'Unavailable' };
      const artifact = parsed as EvidenceArtifact;
      return decodeEvidenceArtifact(artifact, bytes).kind === 'Accepted'
        ? { kind: 'Read', artifact, bytes }
        : { kind: 'Unavailable' };
    } catch (cause) {
      return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
        ? { kind: 'Missing' }
        : { kind: 'Unavailable' };
    }
  }
}
