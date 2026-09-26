import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';

import {
  decodeEvaluationClosure,
  decodeEvaluationClosureEvidenceIndex,
  decodePromotionSelectionRecord,
  evaluationClosureCommandSchema,
  type EvaluationClosureEvidenceIndex,
  type PromotionSelectionRecord,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

type ClosureCommand = Type.Static<typeof evaluationClosureCommandSchema>;

export type PromotionEvidenceStaging = 'Staged' | 'Conflict' | 'Unavailable';
export type PromotionEvidenceCustody =
  | {
      readonly kind: 'Staged';
      readonly closureCommand: ClosureCommand;
      readonly index: EvaluationClosureEvidenceIndex;
      readonly selectionRecord?: PromotionSelectionRecord;
    }
  | { readonly kind: 'Absent' | 'Unavailable' };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const maximumClosureBytes = 512 * 1_024;
const maximumSelectionBytes = 16 * 1_024;

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function exists(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}

function verifiedIndex(command: ClosureCommand): EvaluationClosureEvidenceIndex | undefined {
  if (
    !Value.Check(evaluationClosureCommandSchema, command) ||
    decodeEvaluationClosure(command.closure).kind !== 'Accepted' ||
    command.evidenceIndex.artifact.d !== command.closure.evidenceIndexSaid
  )
    return undefined;
  const bytes = Buffer.from(command.evidenceIndex.bytesBase64Url, 'base64url');
  if (
    bytes.toString('base64url') !== command.evidenceIndex.bytesBase64Url ||
    bytes.byteLength > 128 * 1_024
  )
    return undefined;
  const decoded = decodeEvaluationClosureEvidenceIndex(command.evidenceIndex.artifact, bytes);
  if (decoded.kind !== 'Accepted') return undefined;
  const index = decoded.index;
  const closure = command.closure;
  return index.evaluationId === closure.evaluationId &&
    index.manifestSaid === closure.manifestSaid &&
    isDeepStrictEqual(
      index.observations.map((item) => item.artifactSaid),
      closure.observationSaids,
    ) &&
    isDeepStrictEqual(
      index.measurements.map((item) => item.artifactSaid),
      closure.measurementSaids,
    ) &&
    index.audits[0]?.assessmentArtifactSaid === closure.sharedAuditSaid &&
    index.audits[1]?.assessmentArtifactSaid === closure.armAuditSaids.H1 &&
    index.audits[2]?.assessmentArtifactSaid === closure.armAuditSaids.C1 &&
    index.audits[3]?.assessmentArtifactSaid === closure.armAuditSaids.C2 &&
    index.audits[4]?.assessmentArtifactSaid === closure.armAuditSaids.C3 &&
    index.audits[5]?.assessmentArtifactSaid === closure.armAuditSaids.H1TaskSearch
    ? index
    : undefined;
}

function selectionMatches(
  selection: PromotionSelectionRecord,
  command: ClosureCommand,
  index: EvaluationClosureEvidenceIndex,
): boolean {
  return (
    decodePromotionSelectionRecord(selection).kind === 'Accepted' &&
    selection.evaluationClosureSaid === command.closure.d &&
    selection.evaluationManifestSaid === command.closure.manifestSaid &&
    selection.hypothesisSaid === index.hypothesisSaid &&
    selection.taskId.length > 0 &&
    selection.taskRevisionSaid.length > 0
  );
}

/** Private local pre-network custody. Staged bytes are not hosted acceptance or a grade. */
export class PromotionEvidenceFile {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async stageClosure(command: ClosureCommand): Promise<PromotionEvidenceStaging> {
    if (!isAbsolute(this.#directory) || verifiedIndex(command) === undefined) return 'Unavailable';
    return this.#stage(command.closure.d, 'closure', command, maximumClosureBytes);
  }

  async stageSelection(selection: PromotionSelectionRecord): Promise<PromotionEvidenceStaging> {
    if (
      !isAbsolute(this.#directory) ||
      decodePromotionSelectionRecord(selection).kind !== 'Accepted'
    )
      return 'Unavailable';
    const staged = await this.inspect(selection.evaluationClosureSaid);
    if (staged.kind !== 'Staged') return staged.kind === 'Absent' ? 'Conflict' : 'Unavailable';
    if (!selectionMatches(selection, staged.closureCommand, staged.index)) return 'Conflict';
    return this.#stage(
      selection.evaluationClosureSaid,
      'selection',
      selection,
      maximumSelectionBytes,
    );
  }

  async inspect(closureSaid: string): Promise<PromotionEvidenceCustody> {
    if (!said.test(closureSaid) || !(await this.#safeDirectory(false)))
      return { kind: 'Unavailable' };
    let closure: ClosureCommand;
    try {
      const document = await this.#read(closureSaid, 'closure', maximumClosureBytes);
      if (!Value.Check(evaluationClosureCommandSchema, document)) return { kind: 'Unavailable' };
      closure = document;
    } catch (cause) {
      return { kind: absent(cause) ? 'Absent' : 'Unavailable' };
    }
    const index = verifiedIndex(closure);
    if (closure.closure.d !== closureSaid || index === undefined) return { kind: 'Unavailable' };
    try {
      const selection = await this.#read(closureSaid, 'selection', maximumSelectionBytes);
      const decoded = decodePromotionSelectionRecord(selection);
      return decoded.kind === 'Accepted' && selectionMatches(decoded.record, closure, index)
        ? { kind: 'Staged', closureCommand: closure, index, selectionRecord: decoded.record }
        : { kind: 'Unavailable' };
    } catch (cause) {
      return absent(cause)
        ? { kind: 'Staged', closureCommand: closure, index }
        : { kind: 'Unavailable' };
    }
  }

  async #stage(
    closureSaid: string,
    role: 'closure' | 'selection',
    document: ClosureCommand | PromotionSelectionRecord,
    maximumBytes: number,
  ): Promise<PromotionEvidenceStaging> {
    if (!(await this.#safeDirectory(true))) return 'Unavailable';
    const encoded = JSON.stringify(document);
    if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) return 'Unavailable';
    const path = this.#path(closureSaid, role);
    try {
      const existing = await this.#read(closureSaid, role, maximumBytes);
      return isDeepStrictEqual(existing, document) ? 'Staged' : 'Conflict';
    } catch (cause) {
      if (!absent(cause)) return 'Unavailable';
    }
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (cause) {
        if (!exists(cause)) throw cause;
      }
      await unlink(temporary);
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const stored = await this.#read(closureSaid, role, maximumBytes);
      return isDeepStrictEqual(stored, document) ? 'Staged' : 'Conflict';
    } catch {
      try {
        await unlink(temporary);
      } catch {
        /* not retained */
      }
      return 'Unavailable';
    }
  }

  async #read(
    closureSaid: string,
    role: 'closure' | 'selection',
    maximumBytes: number,
  ): Promise<unknown> {
    const file = await open(
      this.#path(closureSaid, role),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const status = await file.stat();
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        status.size < 2 ||
        status.size > maximumBytes ||
        (status.mode & 0o777) !== 0o600 ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new Error('Promotion evidence custody invalid');
      return JSON.parse(await file.readFile({ encoding: 'utf8' })) as unknown;
    } finally {
      await file.close();
    }
  }

  async #safeDirectory(create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const status = await lstat(this.#directory);
      return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        (status.mode & 0o777) === 0o700 &&
        (process.getuid === undefined || status.uid === process.getuid()) &&
        (await realpath(this.#directory)) === this.#directory
      );
    } catch {
      return false;
    }
  }

  #path(closureSaid: string, role: 'closure' | 'selection'): string {
    return join(this.#directory, `${closureSaid}.${role}.json`);
  }
}
