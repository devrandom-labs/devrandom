import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import {
  baselineHarnessProjectionSchema,
  decodeBaselineHarnessRevision,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  BaselineHarnessAdmissionAcknowledgement,
  BaselineHarnessAdmissionAcquisition,
  BaselineHarnessAdmissionBinding,
  BaselineHarnessAdmissions,
} from '../application/baseline-harness-preparation.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const bindingSchema = Type.Object(
  {
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessSaid: saidSchema,
  },
  { additionalProperties: false },
);
const admissionSchema = Type.Object(
  {
    version: Type.Literal(1),
    binding: bindingSchema,
    commandId: uuidV4Schema,
    disposition: Type.Union([
      Type.Object({ kind: Type.Literal('Prepared') }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal('Accepted'), projection: baselineHarnessProjectionSchema },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

type HarnessAdmission = Type.Static<typeof admissionSchema>;

export class BaselineHarnessAdmissionFile implements BaselineHarnessAdmissions {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async readAccepted(
    binding: BaselineHarnessAdmissionBinding,
  ): Promise<
    | { kind: 'Read'; projection: Type.Static<typeof baselineHarnessProjectionSchema> }
    | { kind: 'NotFound' | 'NotAccepted' | 'BindingConflict' | 'Unavailable' }
  > {
    if (!Value.Check(bindingSchema, binding)) {
      return { kind: 'BindingConflict' };
    }
    try {
      const admission = await this.#read(binding.taskId);
      if (admission === undefined) {
        return { kind: 'NotFound' };
      }
      if (!sameBinding(admission.binding, binding)) {
        return { kind: 'BindingConflict' };
      }
      return admission.disposition.kind === 'Accepted'
        ? { kind: 'Read', projection: admission.disposition.projection }
        : { kind: 'NotAccepted' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async inspectRevision(
    harnessSaid: string,
  ): Promise<
    | { kind: 'Read'; projection: Type.Static<typeof baselineHarnessProjectionSchema> }
    | { kind: 'NotFound' | 'Unavailable' }
  > {
    if (!Value.Check(saidSchema, harnessSaid)) return { kind: 'NotFound' };
    try {
      const entries = await readdir(this.#directory);
      if (entries.length > 1024) return { kind: 'Unavailable' };
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const taskId = entry.slice(0, -5);
        if (!Value.Check(uuidV4Schema, taskId)) continue;
        const admission = await this.#read(taskId);
        if (
          admission?.disposition.kind === 'Accepted' &&
          admission.binding.harnessSaid === harnessSaid
        )
          return { kind: 'Read', projection: admission.disposition.projection };
      }
      return { kind: 'NotFound' };
    } catch (cause) {
      return { kind: isAbsent(cause) ? 'NotFound' : 'Unavailable' };
    }
  }

  async acquire(
    binding: BaselineHarnessAdmissionBinding,
  ): Promise<BaselineHarnessAdmissionAcquisition> {
    if (!Value.Check(bindingSchema, binding)) {
      return { kind: 'BindingConflict' };
    }
    try {
      await this.#prepareDirectory();
      const existing = await this.#read(binding.taskId);
      if (existing !== undefined) {
        return sameBinding(existing.binding, binding)
          ? { kind: 'Acquired', commandId: existing.commandId }
          : { kind: 'BindingConflict' };
      }
      const commandId = randomUUID();
      const admission: HarnessAdmission = {
        version: 1,
        binding,
        commandId,
        disposition: { kind: 'Prepared' },
      };
      const lock = await this.#lock(binding.taskId);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const concurrent = await this.#read(binding.taskId);
        if (concurrent !== undefined) {
          return sameBinding(concurrent.binding, binding)
            ? { kind: 'Acquired', commandId: concurrent.commandId }
            : { kind: 'BindingConflict' };
        }
        await this.#replace(binding.taskId, admission);
      } finally {
        await lock.close();
        await unlink(this.#lockPath(binding.taskId)).catch(() => undefined);
      }
      return { kind: 'Acquired', commandId };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async acknowledge(
    binding: BaselineHarnessAdmissionBinding,
    projection: Type.Static<typeof baselineHarnessProjectionSchema>,
  ): Promise<BaselineHarnessAdmissionAcknowledgement> {
    if (
      !Value.Check(bindingSchema, binding) ||
      !Value.Check(baselineHarnessProjectionSchema, projection) ||
      decodeBaselineHarnessRevision(projection.revision).kind !== 'Accepted' ||
      projection.revision.d !== binding.harnessSaid ||
      projection.revision.task.taskId !== binding.taskId ||
      projection.revision.task.revisionSaid !== binding.taskRevisionSaid
    ) {
      return { kind: 'BindingConflict' };
    }
    try {
      await this.#prepareDirectory();
      const lock = await this.#lock(binding.taskId);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const current = await this.#read(binding.taskId);
        if (
          current === undefined ||
          !sameBinding(current.binding, binding) ||
          current.commandId !== projection.commandId
        ) {
          return { kind: 'BindingConflict' };
        }
        if (current.disposition.kind === 'Accepted') {
          return isDeepStrictEqual(current.disposition.projection, projection)
            ? { kind: 'Acknowledged' }
            : { kind: 'BindingConflict' };
        }
        await this.#replace(binding.taskId, {
          ...current,
          disposition: { kind: 'Accepted', projection },
        });
      } finally {
        await lock.close();
        await unlink(this.#lockPath(binding.taskId)).catch(() => undefined);
      }
      return { kind: 'Acknowledged' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #read(taskId: string): Promise<HarnessAdmission | undefined> {
    const path = this.#path(taskId);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (cause) {
      if (isAbsent(cause)) {
        return undefined;
      }
      throw cause;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !ownedByCurrentUser(before) ||
      (before.mode & 0o077) !== 0
    ) {
      throw new Error('Harness admission file is insecure');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error('Harness admission file changed while opening');
      }
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!Value.Check(admissionSchema, parsed)) {
        throw new Error('Harness admission file is invalid');
      }
      const admission = Value.Parse(admissionSchema, parsed);
      if (
        admission.binding.taskId !== taskId ||
        (admission.disposition.kind === 'Accepted' &&
          (decodeBaselineHarnessRevision(admission.disposition.projection.revision).kind !==
            'Accepted' ||
            admission.disposition.projection.commandId !== admission.commandId ||
            admission.disposition.projection.revision.d !== admission.binding.harnessSaid ||
            admission.disposition.projection.revision.task.taskId !== admission.binding.taskId ||
            admission.disposition.projection.revision.task.revisionSaid !==
              admission.binding.taskRevisionSaid))
      ) {
        throw new Error('Harness admission binding is invalid');
      }
      return admission;
    } finally {
      await handle.close();
    }
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const status = await lstat(this.#directory);
    if (!status.isDirectory() || status.isSymbolicLink() || !ownedByCurrentUser(status)) {
      throw new Error('Harness admission directory is insecure');
    }
  }

  async #lock(taskId: string) {
    try {
      return await open(
        this.#lockPath(taskId),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      return undefined;
    }
  }

  async #replace(taskId: string, admission: HarnessAdmission): Promise<void> {
    if (!Value.Check(admissionSchema, admission)) {
      throw new Error('Harness admission cannot be encoded');
    }
    const path = this.#path(taskId);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(admission)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (cause) {
      await unlink(temporaryPath).catch(() => undefined);
      throw cause;
    }
  }

  #path(taskId: string): string {
    if (!Value.Check(uuidV4Schema, taskId)) {
      throw new Error('Harness admission task identity is invalid');
    }
    return join(this.#directory, `${taskId}.json`);
  }

  #lockPath(taskId: string): string {
    return `${this.#path(taskId)}.lock`;
  }
}

function sameBinding(
  left: BaselineHarnessAdmissionBinding,
  right: BaselineHarnessAdmissionBinding,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.harnessSaid === right.harnessSaid
  );
}

function isAbsent(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function ownedByCurrentUser(status: Stats): boolean {
  return typeof process.getuid !== 'function' || status.uid === process.getuid();
}
