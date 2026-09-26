import { randomUUID } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  evaluationConsumables,
  validateExecutionBinding,
  type EvaluationExecutionBinding,
} from '@devrandom/domain';
import {
  decodeEvaluationManifest,
  decodeEvaluationPolicy,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';
import type {
  EvaluationProviderAllowance,
  EvaluationProviderCustody,
  EvaluationResearchProviderCustody,
} from '@devrandom/runtime';

type ProviderCustody = EvaluationProviderCustody | EvaluationResearchProviderCustody;
type ResearchCurrent = Extract<
  Awaited<ReturnType<EvaluationResearchProviderCustody['inspect']>>,
  { readonly kind: 'ResearchCurrent' }
>;

type Current = Extract<
  Awaited<ReturnType<EvaluationProviderCustody['inspect']>>,
  { readonly kind: 'Current' }
>;
type Maximum = Parameters<EvaluationProviderAllowance['reserve']>[0]['maximum'];
type Usage = Parameters<EvaluationProviderAllowance['record']>[0]['usage'];
type Verified = Extract<Usage, { readonly kind: 'Verified' }>;
type Accepted = Current['accepted'][number];
type State = 'Pending' | 'AwaitingEvidence' | 'Accepted' | 'Unresolved';

interface ReservationRow {
  readonly reservation_id: string;
  readonly request_ordinal: number;
  readonly slot_key: string;
  readonly attempt_key: string;
  readonly maximum_json: string;
  readonly state: State;
  readonly usage_json: string | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const dimensions = ['providerRequests', 'inputTokens', 'outputTokens', 'spendMicroUsd'] as const;
type Dimension = (typeof dimensions)[number];

function privateDirectory(path: string): boolean {
  const status = lstatSync(path, { throwIfNoEntry: false });
  return (
    status !== undefined &&
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    (status.mode & 0o777) === 0o700 &&
    status.uid === process.getuid?.()
  );
}

function directoryFor(stateRoot: string, evaluationId: string): string | undefined {
  if (!isAbsolute(stateRoot) || !privateDirectory(stateRoot) || !uuid.test(evaluationId))
    return undefined;
  const evaluations = join(stateRoot, 'evaluations');
  const directory = join(evaluations, evaluationId);
  try {
    for (const path of [evaluations, directory]) {
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined)
        mkdirSync(path, { mode: 0o700 });
      if (!privateDirectory(path)) return undefined;
    }
    return directory;
  } catch {
    return undefined;
  }
}

function privateDatabase(path: string): boolean {
  try {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
    }
    const status = lstatSync(path);
    return (
      status.isFile() &&
      !status.isSymbolicLink() &&
      status.nlink === 1 &&
      (status.mode & 0o777) === 0o600 &&
      status.uid === process.getuid?.() &&
      realpathSync(path) === join(realpathSync(dirname(path)), basename(path))
    );
  } catch {
    return false;
  }
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface RawProviderAmounts {
  readonly kind?: unknown;
  readonly providerRequests?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly spendMicroUsd?: unknown;
  readonly responseId?: unknown;
  readonly providerReportArtifactSaid?: unknown;
}

function validMaximum(value: unknown): value is Maximum {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as RawProviderAmounts;
  return fields.providerRequests === 1 && dimensions.every((name) => count(fields[name]));
}

function validUsage(value: unknown): value is Verified {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as RawProviderAmounts;
  return (
    fields.kind === 'Verified' &&
    fields.providerRequests === 1 &&
    dimensions.every((name) => count(fields[name])) &&
    typeof fields.responseId === 'string' &&
    fields.responseId.length > 0 &&
    fields.responseId.length <= 256 &&
    typeof fields.providerReportArtifactSaid === 'string' &&
    said.test(fields.providerReportArtifactSaid)
  );
}

function amount(value: Maximum | Verified, name: Dimension): number {
  return value[name];
}

function providerLimits(
  current: Current | ResearchCurrent,
  binding: EvaluationExecutionBinding,
):
  | {
      readonly scopeKey: string;
      readonly total: Readonly<Record<Dimension, number>>;
      readonly perEntry: Readonly<Record<Dimension, number>>;
      readonly searchAttempt: Readonly<Record<Dimension, number>>;
    }
  | undefined {
  if (current.kind === 'ResearchCurrent') return researchProviderLimits(current, binding);
  const { admission, manifest, lock, lease, ownerAid } = current;
  const phase = binding.phase;
  if (
    validateExecutionBinding(binding).kind !== 'Accepted' ||
    phase.kind !== 'Trial' ||
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    !said.test(ownerAid) ||
    ownerAid === binding.personalAgentAid ||
    !uuid.test(admission.commandId) ||
    admission.evaluationId !== binding.evaluationId ||
    admission.evidenceStreamId !== binding.evidenceStreamId ||
    admission.originRunId !== binding.originRunId ||
    admission.leaseId !== binding.evaluationLeaseId ||
    phase.manifestSaid !== manifest.d ||
    manifest.evaluationId !== binding.evaluationId ||
    manifest.originRunId !== binding.originRunId ||
    manifest.taskId !== binding.taskId ||
    manifest.taskRevisionSaid !== binding.taskRevisionSaid ||
    manifest.ownerAid !== ownerAid ||
    manifest.personalAgentAid !== binding.personalAgentAid ||
    manifest.taskMandateSaid !== binding.taskMandateSaid ||
    manifest.revisions[phase.arm === 'H1TaskSearch' ? 'H1' : phase.arm] !==
      binding.harnessRevisionSaid ||
    !manifest.slots.some(
      (slot) =>
        slot.arm === phase.arm &&
        slot.repetition === phase.repetition &&
        slot.attempt === phase.attempt,
    ) ||
    lock.evaluationId !== binding.evaluationId ||
    lock.manifestSaid !== manifest.d ||
    lock.ownerAid !== ownerAid ||
    lock.policySaid !== manifest.policySaid ||
    lock.leaseId !== binding.evaluationLeaseId ||
    lease.evaluationId !== binding.evaluationId ||
    lease.leaseId !== binding.evaluationLeaseId ||
    lease.version !== lock.currentLeaseVersion ||
    !Number.isSafeInteger(lease.version) ||
    !Number.isFinite(Date.parse(lease.serverTime)) ||
    !Number.isFinite(Date.parse(lease.expiresAt)) ||
    Date.parse(lease.expiresAt) <= Date.now() ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.serverTime)
  )
    return undefined;
  const reserved: Record<string, number> = {};
  for (const name of evaluationConsumables) {
    const value =
      manifest.allocation.diagnosis[name] +
      15 * manifest.allocation.perEntry[name] +
      manifest.allocation.finalization[name];
    if (!count(value)) return undefined;
    reserved[name] = value;
  }
  const reservation = prepareEvidenceArtifact(
    new TextEncoder().encode(
      JSON.stringify({
        evaluationId: admission.evaluationId,
        ownerAid,
        commandId: admission.commandId,
        originRunId: admission.originRunId,
        reserved,
      }),
    ),
    'application/json',
  );
  if (reservation.kind !== 'Prepared' || reservation.artifact.d !== admission.reservationSaid)
    return undefined;
  const total = {
    providerRequests: 15 * manifest.allocation.perEntry.providerRequests,
    inputTokens: 15 * manifest.allocation.perEntry.providerInputTokens,
    outputTokens: 15 * manifest.allocation.perEntry.providerOutputTokens,
    spendMicroUsd: 15 * manifest.allocation.perEntry.providerSpendMicroUsd,
  };
  const perEntry = {
    providerRequests: manifest.allocation.perEntry.providerRequests,
    inputTokens: manifest.allocation.perEntry.providerInputTokens,
    outputTokens: manifest.allocation.perEntry.providerOutputTokens,
    spendMicroUsd: manifest.allocation.perEntry.providerSpendMicroUsd,
  };
  if (dimensions.some((name) => !count(total[name]) || !count(perEntry[name]))) return undefined;
  return {
    scopeKey: JSON.stringify({
      ownerAid,
      evaluationId: admission.evaluationId,
      streamId: admission.evidenceStreamId,
      originRunId: admission.originRunId,
      leaseId: admission.leaseId,
      manifestSaid: manifest.d,
      reservationSaid: admission.reservationSaid,
    }),
    total,
    perEntry,
    searchAttempt: Object.fromEntries(
      dimensions.map((name) => [name, Math.floor(perEntry[name] / 2)]),
    ) as Record<Dimension, number>,
  };
}

function researchProviderLimits(
  current: ResearchCurrent,
  binding: EvaluationExecutionBinding,
): ReturnType<typeof providerLimits> {
  const { policy, admission, lease, ownerAid } = current;
  if (
    validateExecutionBinding(binding).kind !== 'Accepted' ||
    binding.phase.kind !== 'Research' ||
    decodeEvaluationPolicy(policy).kind !== 'Accepted' ||
    binding.phase.policySaid !== policy.d ||
    binding.taskId !== policy.taskId ||
    binding.taskRevisionSaid !== policy.taskRevisionSaid ||
    binding.originRunId !== policy.originRunId ||
    binding.harnessRevisionSaid !== policy.expectedActiveRevisionSaid ||
    !said.test(ownerAid) ||
    ownerAid === binding.personalAgentAid ||
    !uuid.test(admission.commandId) ||
    admission.evaluationId !== binding.evaluationId ||
    admission.evidenceStreamId !== binding.evidenceStreamId ||
    admission.originRunId !== binding.originRunId ||
    admission.leaseId !== binding.evaluationLeaseId ||
    lease.evaluationId !== binding.evaluationId ||
    lease.leaseId !== binding.evaluationLeaseId ||
    !Number.isSafeInteger(lease.version) ||
    lease.version < 1 ||
    !Number.isFinite(Date.parse(lease.serverTime)) ||
    !Number.isFinite(Date.parse(lease.expiresAt)) ||
    Date.parse(lease.expiresAt) <= Date.now() ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.serverTime)
  )
    return undefined;
  const reserved: Record<string, number> = {};
  for (const name of evaluationConsumables) {
    const value =
      policy.allocation.diagnosis[name] +
      15 * policy.allocation.perEntry[name] +
      policy.allocation.finalization[name];
    if (!count(value)) return undefined;
    reserved[name] = value;
  }
  const reservation = prepareEvidenceArtifact(
    new TextEncoder().encode(
      JSON.stringify({
        evaluationId: admission.evaluationId,
        ownerAid,
        commandId: admission.commandId,
        originRunId: admission.originRunId,
        reserved,
      }),
    ),
    'application/json',
  );
  if (reservation.kind !== 'Prepared' || reservation.artifact.d !== admission.reservationSaid)
    return undefined;
  const total = {
    providerRequests: policy.allocation.diagnosis.providerRequests,
    inputTokens: policy.allocation.diagnosis.providerInputTokens,
    outputTokens: policy.allocation.diagnosis.providerOutputTokens,
    spendMicroUsd: policy.allocation.diagnosis.providerSpendMicroUsd,
  };
  if (dimensions.some((name) => !count(total[name]))) return undefined;
  return {
    scopeKey: JSON.stringify({
      ownerAid,
      evaluationId: admission.evaluationId,
      streamId: admission.evidenceStreamId,
      originRunId: admission.originRunId,
      leaseId: admission.leaseId,
      policySaid: policy.d,
      reservationSaid: admission.reservationSaid,
    }),
    total,
    perEntry: total,
    searchAttempt: total,
  };
}

function reservationRow(value: unknown): ReservationRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Partial<ReservationRow>;
  return typeof row.reservation_id === 'string' &&
    uuid.test(row.reservation_id) &&
    count(row.request_ordinal) &&
    typeof row.slot_key === 'string' &&
    typeof row.attempt_key === 'string' &&
    typeof row.maximum_json === 'string' &&
    ['Pending', 'AwaitingEvidence', 'Accepted', 'Unresolved'].includes(row.state ?? '') &&
    (row.usage_json === null || typeof row.usage_json === 'string')
    ? (row as ReservationRow)
    : undefined;
}

function matchesAccepted(row: ReservationRow, accepted: Accepted): boolean {
  if (row.usage_json === null || !said.test(accepted.eventSaid)) return false;
  let usage: unknown;
  try {
    usage = JSON.parse(row.usage_json);
  } catch {
    return false;
  }
  if (typeof usage !== 'object' || usage === null) return false;
  const verified = usage as Verified;
  return (
    validUsage(verified) &&
    accepted.requestOrdinal === row.request_ordinal &&
    accepted.responseId === verified.responseId &&
    accepted.providerReportArtifactSaid === verified.providerReportArtifactSaid &&
    accepted.inputTokens === verified.inputTokens &&
    accepted.outputTokens === verified.outputTokens &&
    accepted.spendMicroUsd === verified.spendMicroUsd
  );
}

/** Private, durable Evaluation-only pre-provider capacity; unknown calls retain their maximum. */
export class SqliteEvaluationProviderAllowance implements EvaluationProviderAllowance {
  readonly #database: DatabaseSync;
  readonly #binding: EvaluationExecutionBinding;
  readonly #custody: ProviderCustody;
  readonly #scopeKey: string;

  private constructor(
    database: DatabaseSync,
    binding: EvaluationExecutionBinding,
    custody: ProviderCustody,
    scopeKey: string,
  ) {
    this.#database = database;
    this.#binding = binding;
    this.#custody = custody;
    this.#scopeKey = scopeKey;
  }

  static async open(
    stateRoot: string,
    binding: EvaluationExecutionBinding,
    custody: ProviderCustody,
  ): Promise<
    | { readonly kind: 'Opened'; readonly allowance: SqliteEvaluationProviderAllowance }
    | { readonly kind: 'UnsafePath' | 'Unavailable' }
  > {
    let current: Awaited<ReturnType<ProviderCustody['inspect']>>;
    try {
      current = await custody.inspect(binding);
    } catch {
      return { kind: 'Unavailable' };
    }
    const limits =
      current.kind === 'Current' || current.kind === 'ResearchCurrent'
        ? providerLimits(current, binding)
        : undefined;
    if (limits === undefined) return { kind: 'Unavailable' };
    const directory = directoryFor(stateRoot, binding.evaluationId);
    if (directory === undefined) return { kind: 'UnsafePath' };
    const path = join(
      directory,
      binding.phase.kind === 'Research'
        ? 'research-provider-allowance.sqlite'
        : 'provider-allowance.sqlite',
    );
    if (!privateDatabase(path)) return { kind: 'UnsafePath' };
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      database.exec('PRAGMA journal_mode=WAL');
      database.exec('PRAGMA synchronous=FULL');
      database.exec('PRAGMA busy_timeout=3000');
      database.exec(
        'CREATE TABLE IF NOT EXISTS scope (singleton INTEGER PRIMARY KEY CHECK (singleton=1), scope_key TEXT NOT NULL)',
      );
      database.exec(
        'CREATE TABLE IF NOT EXISTS reservations (reservation_id TEXT PRIMARY KEY, request_ordinal INTEGER NOT NULL UNIQUE, slot_key TEXT NOT NULL, attempt_key TEXT NOT NULL, maximum_json TEXT NOT NULL, state TEXT NOT NULL, usage_json TEXT)',
      );
      const existing = database.prepare('SELECT scope_key FROM scope WHERE singleton=1').get() as
        { scope_key: string } | undefined;
      if (existing === undefined)
        database.prepare('INSERT INTO scope VALUES (1, ?)').run(limits.scopeKey);
      else if (existing.scope_key !== limits.scopeKey) {
        database.close();
        return { kind: 'Unavailable' };
      }
      return {
        kind: 'Opened',
        allowance: new SqliteEvaluationProviderAllowance(
          database,
          binding,
          custody,
          limits.scopeKey,
        ),
      };
    } catch {
      database?.close();
      return { kind: 'Unavailable' };
    }
  }

  close(): void {
    this.#database.close();
  }

  async reserve(
    input: Parameters<EvaluationProviderAllowance['reserve']>[0],
  ): ReturnType<EvaluationProviderAllowance['reserve']> {
    const binding = input.binding;
    if (
      !validMaximum(input.maximum) ||
      binding.evaluationId !== this.#binding.evaluationId ||
      binding.evidenceStreamId !== this.#binding.evidenceStreamId ||
      binding.evaluationLeaseId !== this.#binding.evaluationLeaseId ||
      binding.originRunId !== this.#binding.originRunId ||
      binding.taskId !== this.#binding.taskId ||
      binding.taskRevisionSaid !== this.#binding.taskRevisionSaid ||
      binding.personalAgentAid !== this.#binding.personalAgentAid ||
      binding.taskMandateSaid !== this.#binding.taskMandateSaid ||
      !count(input.requestOrdinal)
    )
      return { kind: 'Unavailable' };
    let current: Awaited<ReturnType<ProviderCustody['inspect']>>;
    try {
      current = await this.#custody.inspect(binding);
    } catch {
      return { kind: 'Unavailable' };
    }
    const limits =
      current.kind === 'Current' || current.kind === 'ResearchCurrent'
        ? providerLimits(current, binding)
        : undefined;
    if (
      (current.kind !== 'Current' && current.kind !== 'ResearchCurrent') ||
      limits === undefined ||
      limits.scopeKey !== this.#scopeKey
    )
      return { kind: 'Unavailable' };
    const slotKey = `${binding.phase.kind}:${binding.phase.kind === 'Trial' ? binding.phase.arm : ''}:${binding.phase.kind === 'Trial' ? String(binding.phase.repetition) : ''}`;
    const attemptKey =
      binding.phase.kind === 'Trial' ? `${slotKey}:${String(binding.phase.attempt)}` : slotKey;
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const rows = this.#database
        .prepare('SELECT * FROM reservations ORDER BY request_ordinal')
        .all()
        .map(reservationRow);
      if (rows.some((row) => row === undefined)) throw new Error('corrupt allowance ledger');
      const known = rows as ReservationRow[];
      const accepted = new Map(current.accepted.map((item) => [item.requestOrdinal, item]));
      if (
        accepted.size !== current.accepted.length ||
        known.some((row) => row.request_ordinal >= input.requestOrdinal) ||
        known.some((row) => row.state === 'Pending' || row.state === 'Unresolved') ||
        known.some((row) => {
          const proof = accepted.get(row.request_ordinal);
          return row.state === 'Accepted'
            ? proof === undefined || !matchesAccepted(row, proof)
            : row.state === 'AwaitingEvidence'
              ? proof === undefined || !matchesAccepted(row, proof)
              : proof !== undefined;
        }) ||
        current.accepted.some(
          (proof) => !known.some((row) => row.request_ordinal === proof.requestOrdinal),
        )
      ) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Unavailable' };
      }
      for (const row of known) {
        if (row.state === 'AwaitingEvidence')
          this.#database
            .prepare("UPDATE reservations SET state='Accepted' WHERE reservation_id=?")
            .run(row.reservation_id);
      }
      const totals = Object.fromEntries(dimensions.map((name) => [name, 0])) as Record<
        Dimension,
        number
      >;
      const slot = { ...totals };
      const attempt = { ...totals };
      for (const row of known) {
        const maximum: unknown = JSON.parse(row.maximum_json);
        const usage: unknown = row.usage_json === null ? undefined : JSON.parse(row.usage_json);
        if (
          typeof maximum !== 'object' ||
          maximum === null ||
          !validMaximum(maximum) ||
          (row.state === 'Accepted' && !validUsage(usage))
        )
          throw new Error('corrupt allowance amount');
        const charged = row.state === 'Accepted' && validUsage(usage) ? usage : maximum;
        for (const name of dimensions) {
          totals[name] += amount(charged, name);
          if (row.slot_key === slotKey) slot[name] += amount(charged, name);
          if (row.attempt_key === attemptKey) attempt[name] += amount(charged, name);
        }
      }
      const attemptLimit =
        binding.phase.kind === 'Trial' && binding.phase.arm === 'H1TaskSearch'
          ? limits.searchAttempt
          : limits.perEntry;
      if (
        dimensions.some(
          (name) =>
            !Number.isSafeInteger(totals[name] + input.maximum[name]) ||
            totals[name] + input.maximum[name] > limits.total[name] ||
            slot[name] + input.maximum[name] > limits.perEntry[name] ||
            attempt[name] + input.maximum[name] > attemptLimit[name],
        )
      ) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Exhausted' };
      }
      const reservationId = randomUUID();
      this.#database
        .prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(
          reservationId,
          input.requestOrdinal,
          slotKey,
          attemptKey,
          JSON.stringify(input.maximum),
          'Pending',
        );
      this.#database.exec('COMMIT');
      return { kind: 'Reserved', reservationId };
    } catch {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // A storage failure may already have rolled back.
      }
      return { kind: 'Unavailable' };
    }
  }

  record(
    input: Parameters<EvaluationProviderAllowance['record']>[0],
  ): ReturnType<EvaluationProviderAllowance['record']> {
    return Promise.resolve(this.#record(input));
  }

  #record(
    input: Parameters<EvaluationProviderAllowance['record']>[0],
  ): Awaited<ReturnType<EvaluationProviderAllowance['record']>> {
    if (!uuid.test(input.reservationId)) return { kind: 'Unavailable' };
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const row = reservationRow(
        this.#database
          .prepare('SELECT * FROM reservations WHERE reservation_id=?')
          .get(input.reservationId),
      );
      if (row === undefined) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Unavailable' };
      }
      const maximum: unknown = JSON.parse(row.maximum_json);
      if (typeof maximum !== 'object' || maximum === null || !validMaximum(maximum))
        throw new Error('corrupt reservation maximum');
      const exactRetry = row.usage_json === JSON.stringify(input.usage);
      if (row.state !== 'Pending') {
        if (exactRetry && row.state !== 'Unresolved') {
          this.#database.exec('ROLLBACK');
          return { kind: 'Recorded' };
        }
        this.#database
          .prepare(
            "UPDATE reservations SET state='Unresolved', usage_json=NULL WHERE reservation_id=?",
          )
          .run(input.reservationId);
        this.#database.exec('COMMIT');
        return { kind: 'Unavailable' };
      }
      if (input.usage.kind === 'Unresolved') {
        this.#database
          .prepare("UPDATE reservations SET state='Unresolved' WHERE reservation_id=?")
          .run(input.reservationId);
        this.#database.exec('COMMIT');
        return { kind: 'Recorded' };
      }
      const verified = input.usage;
      if (!validUsage(verified) || dimensions.some((name) => verified[name] > maximum[name])) {
        this.#database
          .prepare("UPDATE reservations SET state='Unresolved' WHERE reservation_id=?")
          .run(input.reservationId);
        this.#database.exec('COMMIT');
        return { kind: 'Exhausted' };
      }
      this.#database
        .prepare(
          "UPDATE reservations SET state='AwaitingEvidence', usage_json=? WHERE reservation_id=?",
        )
        .run(JSON.stringify(input.usage), input.reservationId);
      this.#database.exec('COMMIT');
      return { kind: 'Recorded' };
    } catch {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // A storage failure may already have rolled back.
      }
      return { kind: 'Unavailable' };
    }
  }
}
