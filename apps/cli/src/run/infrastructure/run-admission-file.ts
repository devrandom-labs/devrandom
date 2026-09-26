import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { governorAid, personalAgentAid } from '@devrandom/identity';
import {
  decodeRunProjection,
  preparedRepositorySchema,
  runLeaseProjectionSchema,
  runProjectionSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  BaselineRunAdmissionRecords,
  BaselineRunAdmissionRecordOutcome,
  BaselineRunAdmissionTransition,
  BaselineRunBinding,
  StableBaselineRunAdmission,
} from '../application/baseline-run-admission.js';
import type {
  AcceptedRunAdmissionLocation,
  AcceptedRunAdmissions,
} from '../application/task-run-observation.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const bindingSchema = Type.Object(
  {
    ownerAid: saidSchema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessLineageId: uuidV4Schema,
    harnessRevisionSaid: saidSchema,
    personalAgentAid: saidSchema,
    taskMandateSaid: saidSchema,
    governorAid: saidSchema,
    promotionMandateSaid: saidSchema,
    purpose: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('PreparedCompatibilityCalibration'),
          campaignId: uuidV4Schema,
          ordinal: Type.Union([
            Type.Literal(1),
            Type.Literal(2),
            Type.Literal(3),
            Type.Literal(4),
            Type.Literal(5),
          ]),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal('Retained') }, { additionalProperties: false }),
    ]),
    repository: preparedRepositorySchema,
  },
  { additionalProperties: false },
);
const identityProperties = {
  version: Type.Literal(1),
  binding: bindingSchema,
  commandId: uuidV4Schema,
  incarnationId: uuidV4Schema,
  preparedAt: safeIntegerSchema,
};
const admissionSchema = Type.Union([
  Type.Object(
    { ...identityProperties, kind: Type.Literal('PreparingExchange') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...identityProperties,
      kind: Type.Literal('ExchangePrepared'),
      exchangeSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...identityProperties,
      kind: Type.Literal('RunAccepted'),
      exchangeSaid: saidSchema,
      runAdmission: Type.Union([Type.Literal('Created'), Type.Literal('Reconciled')]),
      run: runProjectionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...identityProperties,
      kind: Type.Literal('LeaseAccepted'),
      exchangeSaid: saidSchema,
      runAdmission: Type.Union([Type.Literal('Created'), Type.Literal('Reconciled')]),
      run: runProjectionSchema,
      lease: runLeaseProjectionSchema,
    },
    { additionalProperties: false },
  ),
]);

type RunAdmissionDocument = Type.Static<typeof admissionSchema>;

function sameBinding(left: BaselineRunBinding, right: BaselineRunBinding): boolean {
  return (
    left.ownerAid === right.ownerAid &&
    left.taskId === right.taskId &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.harnessLineageId === right.harnessLineageId &&
    left.harnessRevisionSaid === right.harnessRevisionSaid &&
    left.personalAgentAid === right.personalAgentAid &&
    left.taskMandateSaid === right.taskMandateSaid &&
    left.governorAid === right.governorAid &&
    left.promotionMandateSaid === right.promotionMandateSaid &&
    isDeepStrictEqual(left.purpose, right.purpose) &&
    isDeepStrictEqual(left.repository, right.repository)
  );
}

function runMatches(
  document: Extract<RunAdmissionDocument, { readonly kind: 'RunAccepted' | 'LeaseAccepted' }>,
): boolean {
  const run = document.run;
  const bound = document.binding;
  return (
    decodeRunProjection(run).kind === 'Accepted' &&
    run.ownerAid === bound.ownerAid &&
    run.commandId === document.commandId &&
    run.admissionExchangeSaid === document.exchangeSaid &&
    run.taskId === bound.taskId &&
    run.taskRevisionSaid === bound.taskRevisionSaid &&
    run.harnessLineageId === bound.harnessLineageId &&
    run.harnessRevisionSaid === bound.harnessRevisionSaid &&
    run.personalAgentAid === bound.personalAgentAid &&
    run.taskMandateSaid === bound.taskMandateSaid &&
    run.governorAid === bound.governorAid &&
    run.promotionMandateSaid === bound.promotionMandateSaid &&
    isDeepStrictEqual(run.purpose, bound.purpose) &&
    isDeepStrictEqual(run.repository, bound.repository) &&
    run.lease.kind === 'Unassigned'
  );
}

function documentIsConsistent(document: RunAdmissionDocument, taskId: string): boolean {
  if (document.binding.taskId !== taskId) {
    return false;
  }
  switch (document.kind) {
    case 'PreparingExchange':
    case 'ExchangePrepared':
      return true;
    case 'RunAccepted':
      return runMatches(document);
    case 'LeaseAccepted':
      return (
        runMatches(document) &&
        document.lease.runId === document.run.runId &&
        document.lease.incarnationId === document.incarnationId &&
        document.lease.runVersion === document.run.runVersion + 1
      );
  }
}

function decodeDocument(document: RunAdmissionDocument): StableBaselineRunAdmission {
  const binding: BaselineRunBinding = {
    ...document.binding,
    personalAgentAid: personalAgentAid(document.binding.personalAgentAid),
    governorAid: governorAid(document.binding.governorAid),
  };
  switch (document.kind) {
    case 'PreparingExchange':
      return { ...document, binding };
    case 'ExchangePrepared':
      return { ...document, binding };
    case 'RunAccepted':
      return { ...document, binding };
    case 'LeaseAccepted':
      return { ...document, binding };
  }
}

export class RunAdmissionFile implements BaselineRunAdmissionRecords, AcceptedRunAdmissions {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async inspectTaskAdmissions(
    taskId: string,
  ): Promise<
    | { readonly kind: 'Found'; readonly admissions: readonly StableBaselineRunAdmission[] }
    | { readonly kind: 'Unavailable' }
  > {
    try {
      if (!Value.Check(uuidV4Schema, taskId)) return { kind: 'Unavailable' };
      let directory: Stats;
      try {
        directory = await lstat(this.#directory);
      } catch (cause) {
        if (isAbsent(cause)) return { kind: 'Found', admissions: [] };
        throw cause;
      }
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        !ownedByCurrentUser(directory) ||
        (directory.mode & 0o777) !== 0o700
      ) {
        return { kind: 'Unavailable' };
      }
      const names = await readdir(this.#directory);
      const admissions: StableBaselineRunAdmission[] = [];
      const campaigns = new Set<string>();
      for (const name of names) {
        if (name !== `${taskId}.json` && !name.startsWith(`${taskId}.`)) continue;
        if (!name.endsWith('.json')) continue;
        const key = name.slice(0, -'.json'.length);
        const admission = await this.#read(key, taskId);
        if (admission === undefined) continue;
        if (this.#key(admission.binding) !== key) return { kind: 'Unavailable' };
        if (admission.binding.purpose.kind === 'PreparedCompatibilityCalibration') {
          campaigns.add(admission.binding.purpose.campaignId);
        }
        admissions.push(admission);
      }
      if (campaigns.size > 1) return { kind: 'Unavailable' };
      return { kind: 'Found', admissions };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async locateAcceptedRun(taskId: string): Promise<AcceptedRunAdmissionLocation> {
    const inspection = await this.inspectTaskAdmissions(taskId);
    if (inspection.kind !== 'Found') return inspection;
    const accepted = inspection.admissions
      .filter(
        (admission): admission is Extract<StableBaselineRunAdmission, { kind: 'LeaseAccepted' }> =>
          admission.kind === 'LeaseAccepted',
      )
      .sort((left, right) => {
        const leftOrdinal =
          left.binding.purpose.kind === 'Retained' ? 6 : left.binding.purpose.ordinal;
        const rightOrdinal =
          right.binding.purpose.kind === 'Retained' ? 6 : right.binding.purpose.ordinal;
        return rightOrdinal - leftOrdinal;
      });
    const latest = accepted[0];
    if (latest !== undefined) return { kind: 'Located', admission: latest };
    return { kind: inspection.admissions.length === 0 ? 'NotFound' : 'NotAccepted' };
  }

  async acquire(
    binding: BaselineRunBinding,
    candidate: {
      readonly commandId: string;
      readonly incarnationId: string;
      readonly preparedAt: number;
    },
  ): Promise<BaselineRunAdmissionRecordOutcome> {
    const prepared: StableBaselineRunAdmission = {
      version: 1,
      kind: 'PreparingExchange',
      binding,
      ...candidate,
    };
    if (!Value.Check(admissionSchema, prepared)) {
      return { kind: 'BindingConflict' };
    }
    const key = this.#key(binding);
    try {
      await this.#prepareDirectory();
      const existing = await this.#read(key, binding.taskId);
      if (existing !== undefined) {
        return sameBinding(existing.binding, binding)
          ? { kind: 'Acquired', provenance: 'Recovered', admission: existing }
          : { kind: 'BindingConflict' };
      }
      const lock = await this.#lock(key);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const concurrent = await this.#read(key, binding.taskId);
        if (concurrent !== undefined) {
          return sameBinding(concurrent.binding, binding)
            ? { kind: 'Acquired', provenance: 'Recovered', admission: concurrent }
            : { kind: 'BindingConflict' };
        }
        await this.#replace(key, prepared);
      } finally {
        await lock.close();
        await unlink(this.#lockPath(key)).catch(() => undefined);
      }
      return { kind: 'Acquired', provenance: 'Created', admission: prepared };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async recordExchange(
    binding: BaselineRunBinding,
    prepared: { readonly exchangeSaid: string },
  ): Promise<BaselineRunAdmissionTransition> {
    if (!Value.Check(bindingSchema, binding) || !Value.Check(saidSchema, prepared.exchangeSaid)) {
      return { kind: 'Conflict' };
    }
    try {
      await this.#prepareDirectory();
      const key = this.#key(binding);
      const lock = await this.#lock(key);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const current = await this.#read(key, binding.taskId);
        if (current === undefined || !sameBinding(current.binding, binding)) {
          return { kind: 'Conflict' };
        }
        if (current.kind !== 'PreparingExchange') {
          return 'exchangeSaid' in current && current.exchangeSaid === prepared.exchangeSaid
            ? { kind: 'Acknowledged', admission: current }
            : { kind: 'Conflict' };
        }
        const next: StableBaselineRunAdmission = {
          ...current,
          kind: 'ExchangePrepared',
          exchangeSaid: prepared.exchangeSaid,
        };
        await this.#replace(key, next);
        return { kind: 'Acknowledged', admission: next };
      } finally {
        await lock.close();
        await unlink(this.#lockPath(key)).catch(() => undefined);
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async recordRun(
    binding: BaselineRunBinding,
    disposition: 'Created' | 'Reconciled',
    projection: Type.Static<typeof runProjectionSchema>,
  ): Promise<BaselineRunAdmissionTransition> {
    if (!Value.Check(bindingSchema, binding) || !Value.Check(runProjectionSchema, projection)) {
      return { kind: 'Conflict' };
    }
    try {
      await this.#prepareDirectory();
      const key = this.#key(binding);
      const lock = await this.#lock(key);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const current = await this.#read(key, binding.taskId);
        if (current === undefined || !sameBinding(current.binding, binding)) {
          return { kind: 'Conflict' };
        }
        if (current.kind === 'RunAccepted' || current.kind === 'LeaseAccepted') {
          return current.runAdmission === disposition && isDeepStrictEqual(current.run, projection)
            ? { kind: 'Acknowledged', admission: current }
            : { kind: 'Conflict' };
        }
        if (current.kind !== 'ExchangePrepared') {
          return { kind: 'Conflict' };
        }
        const next: StableBaselineRunAdmission = {
          ...current,
          kind: 'RunAccepted',
          runAdmission: disposition,
          run: projection,
        };
        if (!runMatches(next)) {
          return { kind: 'Conflict' };
        }
        await this.#replace(key, next);
        return { kind: 'Acknowledged', admission: next };
      } finally {
        await lock.close();
        await unlink(this.#lockPath(key)).catch(() => undefined);
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async recordLease(
    binding: BaselineRunBinding,
    projection: Type.Static<typeof runLeaseProjectionSchema>,
  ): Promise<BaselineRunAdmissionTransition> {
    if (
      !Value.Check(bindingSchema, binding) ||
      !Value.Check(runLeaseProjectionSchema, projection)
    ) {
      return { kind: 'Conflict' };
    }
    try {
      await this.#prepareDirectory();
      const key = this.#key(binding);
      const lock = await this.#lock(key);
      if (lock === undefined) {
        return { kind: 'Unavailable' };
      }
      try {
        const current = await this.#read(key, binding.taskId);
        if (current === undefined || !sameBinding(current.binding, binding)) {
          return { kind: 'Conflict' };
        }
        if (current.kind === 'LeaseAccepted') {
          return isDeepStrictEqual(current.lease, projection)
            ? { kind: 'Acknowledged', admission: current }
            : { kind: 'Conflict' };
        }
        if (current.kind !== 'RunAccepted') {
          return { kind: 'Conflict' };
        }
        const next: StableBaselineRunAdmission = {
          ...current,
          kind: 'LeaseAccepted',
          lease: projection,
        };
        if (!documentIsConsistent(next, binding.taskId)) {
          return { kind: 'Conflict' };
        }
        await this.#replace(key, next);
        return { kind: 'Acknowledged', admission: next };
      } finally {
        await lock.close();
        await unlink(this.#lockPath(key)).catch(() => undefined);
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #read(key: string, taskId = key): Promise<StableBaselineRunAdmission | undefined> {
    const path = this.#path(key);
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
      throw new Error('Run admission file is insecure');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error('Run admission file changed while opening');
      }
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!Value.Check(admissionSchema, parsed)) {
        throw new Error('Run admission file is invalid');
      }
      const document = Value.Parse(admissionSchema, parsed);
      if (!documentIsConsistent(document, taskId)) {
        throw new Error('Run admission binding is invalid');
      }
      return decodeDocument(document);
    } finally {
      await handle.close();
    }
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const status = await lstat(this.#directory);
    if (!status.isDirectory() || status.isSymbolicLink() || !ownedByCurrentUser(status)) {
      throw new Error('Run admission directory is insecure');
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

  async #replace(key: string, admission: StableBaselineRunAdmission): Promise<void> {
    const document = { ...admission, version: 1 as const };
    if (
      !Value.Check(admissionSchema, document) ||
      !documentIsConsistent(document, admission.binding.taskId)
    ) {
      throw new Error('Run admission cannot be encoded');
    }
    const path = this.#path(key);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
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

  #key(binding: BaselineRunBinding): string {
    return binding.purpose.kind === 'Retained'
      ? binding.taskId
      : `${binding.taskId}.${binding.purpose.campaignId}.${String(binding.purpose.ordinal)}`;
  }

  #path(key: string): string {
    if (!/^[0-9a-f.-]+$/.test(key) || key.includes('..')) {
      throw new Error('Run admission identity is invalid');
    }
    return join(this.#directory, `${key}.json`);
  }

  #lockPath(key: string): string {
    return `${this.#path(key)}.lock`;
  }
}

function isAbsent(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function ownedByCurrentUser(status: Stats): boolean {
  return typeof process.getuid !== 'function' || status.uid === process.getuid();
}
