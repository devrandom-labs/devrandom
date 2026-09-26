import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

import type {
  CompatibilityCalibrationRecordCommitment,
  CompatibilityCalibrationRecordReading,
  CompatibilityCalibrationRecords,
  PreparedCompatibilityCalibrationRecord,
} from '../application/prepared-compatibility-calibration.js';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const categorySchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessRevisionSaid: saidSchema,
    currentCommandSaid: saidSchema,
    tamperCommandSaid: saidSchema,
    legacyCommandSaid: saidSchema,
    legacyObservedExitCode: Type.Literal(101),
  },
  { additionalProperties: false },
);
const exclusionReasonSchema = Type.Union([
  Type.Literal('IdentityUnavailable'),
  Type.Literal('KERIAUnavailable'),
  Type.Literal('StorageUnavailable'),
  Type.Literal('ProviderUnavailable'),
  Type.Literal('NetworkUnavailable'),
  Type.Literal('ModelCredentialUnavailable'),
  Type.Literal('ModelConfigurationRequired'),
  Type.Literal('ModelUsageUnavailable'),
  Type.Literal('EffectAborted'),
  Type.Literal('BudgetExhausted'),
  Type.Literal('OutboxBackpressure'),
]);
const rejectionReasonSchema = Type.Union([
  Type.Literal('H1Passed'),
  Type.Literal('ReceiptPatternMismatch'),
  Type.Literal('FixtureBindingMismatch'),
  Type.Literal('CategoryChanged'),
]);
const entrySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Counted'),
      runId: uuidV4Schema,
      category: categorySchema,
      modelMessageEventSaid: saidSchema,
      toolProposalEventSaid: saidSchema,
      toolEffectEventSaid: saidSchema,
      verifierReceiptSaids: Type.Array(saidSchema, {
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Excluded'), runId: uuidV4Schema, reason: exclusionReasonSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Rejected'), runId: uuidV4Schema, reason: rejectionReasonSchema },
    { additionalProperties: false },
  ),
]);
const recordSchema = Type.Object(
  {
    version: Type.Literal(1),
    binding: Type.Union([
      Type.Object(
        { kind: Type.Literal('AwaitingConfirmedCategory') },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal('Bound'), category: categorySchema },
        { additionalProperties: false },
      ),
    ]),
    attempts: Type.Array(entrySchema, { maxItems: 5 }),
  },
  { additionalProperties: false },
);

type CalibrationDocument = Static<typeof recordSchema>;

const recordFileName = 'prepared-compatibility-calibration.json';
const lockFileName = 'prepared-compatibility-calibration.lock';
const maximumRecordBytes = 64 * 1_024;

function categoriesEqual(
  left: Static<typeof categorySchema>,
  right: Static<typeof categorySchema>,
) {
  return (
    left.taskId === right.taskId &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.harnessRevisionSaid === right.harnessRevisionSaid &&
    left.currentCommandSaid === right.currentCommandSaid &&
    left.tamperCommandSaid === right.tamperCommandSaid &&
    left.legacyCommandSaid === right.legacyCommandSaid
  );
}

function documentIsLawful(document: CalibrationDocument): boolean {
  const runIds = new Set(document.attempts.map(({ runId }) => runId));
  if (runIds.size !== document.attempts.length) return false;
  const rejectedIndex = document.attempts.findIndex(({ kind }) => kind === 'Rejected');
  if (rejectedIndex >= 0 && rejectedIndex !== document.attempts.length - 1) return false;
  const counted = document.attempts.filter(
    (entry): entry is Extract<CalibrationDocument['attempts'][number], { kind: 'Counted' }> =>
      entry.kind === 'Counted',
  );
  if (counted.length === 0) {
    return document.binding.kind === 'AwaitingConfirmedCategory';
  }
  if (document.binding.kind !== 'Bound') return false;
  const category = document.binding.category;
  return counted.every((entry) => categoriesEqual(entry.category, category));
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function isExisting(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}

export class PreparedCompatibilityCalibrationFile implements CompatibilityCalibrationRecords {
  readonly #directory: string;
  readonly #path: string;
  readonly #lockPath: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#path = join(directory, recordFileName);
    this.#lockPath = join(directory, lockFileName);
  }

  async load(): Promise<CompatibilityCalibrationRecordReading> {
    try {
      const metadata = await lstat(this.#path);
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size > maximumRecordBytes
      ) {
        return { kind: 'Corrupt' };
      }
      const input: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      if (!Value.Check(recordSchema, input) || !documentIsLawful(input)) {
        return { kind: 'Corrupt' };
      }
      return { kind: 'Loaded', record: input };
    } catch (cause) {
      return isMissing(cause) ? { kind: 'NotFound' } : { kind: 'Unavailable' };
    }
  }

  async commit(
    expectedAttemptCount: number,
    record: PreparedCompatibilityCalibrationRecord,
  ): Promise<CompatibilityCalibrationRecordCommitment> {
    if (
      !Number.isSafeInteger(expectedAttemptCount) ||
      expectedAttemptCount < 0 ||
      expectedAttemptCount > 5 ||
      record.attempts.length !== expectedAttemptCount + 1 ||
      !Value.Check(recordSchema, record) ||
      !documentIsLawful(record)
    ) {
      return { kind: 'Unavailable' };
    }
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    } catch {
      return { kind: 'Unavailable' };
    }
    let lock;
    try {
      lock = await open(this.#lockPath, 'wx', 0o600);
    } catch (cause) {
      return isExisting(cause) ? { kind: 'Conflict' } : { kind: 'Unavailable' };
    }
    const temporaryPath = join(this.#directory, `.${recordFileName}.${randomUUID()}`);
    try {
      const current = await this.load();
      if (
        (current.kind === 'NotFound' && expectedAttemptCount !== 0) ||
        (current.kind === 'Loaded' && current.record.attempts.length !== expectedAttemptCount)
      ) {
        return { kind: 'Conflict' };
      }
      if (current.kind === 'Unavailable' || current.kind === 'Corrupt') {
        return { kind: 'Unavailable' };
      }
      const encoded = `${JSON.stringify(record)}\n`;
      if (new TextEncoder().encode(encoded).byteLength > maximumRecordBytes) {
        return { kind: 'Unavailable' };
      }
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(encoded, 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, this.#path);
      return { kind: 'Committed' };
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      await lock.close().catch(() => undefined);
      await rm(this.#lockPath, { force: true }).catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
