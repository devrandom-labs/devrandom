import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AesGcmProtectedCaseCustody, type ProtectedCaseCustody } from '@devrandom/runtime';

export interface ProtectedCaseKeyBinding {
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly personalAgentAid: string;
  readonly taskId: string;
  readonly taskMandateSaid: string;
}

type OpenedKeyCustody = { readonly custody: SqliteProtectedCaseKeyCustody };
type CreateOutcome =
  | ({ readonly kind: 'Created' } & OpenedKeyCustody)
  | { readonly kind: 'AlreadyExists' | 'InvalidBinding' | 'UnsafePath' | 'Unavailable' };
type ReopenOutcome =
  | ({ readonly kind: 'Opened' } & OpenedKeyCustody)
  | {
      readonly kind:
        'Missing' | 'InvalidBinding' | 'BindingMismatch' | 'Corrupt' | 'UnsafePath' | 'Unavailable';
    };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumNonce = Number.MAX_SAFE_INTEGER;

interface KeyRow {
  readonly singleton: number;
  readonly owner_aid: string;
  readonly evaluation_id: string;
  readonly personal_agent_aid: string;
  readonly task_id: string;
  readonly task_mandate_said: string;
  readonly key_bytes: Uint8Array;
  readonly nonce_prefix: Uint8Array;
  readonly next_nonce: number;
}

function validBinding(binding: ProtectedCaseKeyBinding): boolean {
  return (
    said.test(binding.ownerAid) &&
    said.test(binding.personalAgentAid) &&
    binding.ownerAid !== binding.personalAgentAid &&
    said.test(binding.taskMandateSaid) &&
    uuid.test(binding.evaluationId) &&
    uuid.test(binding.taskId) &&
    binding.evaluationId !== binding.taskId
  );
}

function ownerOnlyDirectory(path: string): boolean {
  const status = lstatSync(path, { throwIfNoEntry: false });
  return (
    status !== undefined &&
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    (status.mode & 0o777) === 0o700 &&
    status.uid === process.getuid?.()
  );
}

function ownerOnlyFile(path: string): ReturnType<typeof lstatSync> | undefined {
  const status = lstatSync(path, { throwIfNoEntry: false });
  return status !== undefined &&
    status.isFile() &&
    !status.isSymbolicLink() &&
    status.nlink === 1 &&
    (status.mode & 0o777) === 0o600 &&
    status.uid === process.getuid?.()
    ? status
    : undefined;
}

function directoryFor(
  stateRoot: string,
  binding: ProtectedCaseKeyBinding,
  create: boolean,
):
  | { readonly kind: 'Ready'; readonly directory: string }
  | { readonly kind: 'Missing' | 'UnsafePath' } {
  if (!isAbsolute(stateRoot) || !ownerOnlyDirectory(stateRoot)) return { kind: 'UnsafePath' };
  const evaluations = join(stateRoot, 'evaluations');
  const directory = join(evaluations, binding.evaluationId);
  try {
    for (const path of [evaluations, directory]) {
      const status = lstatSync(path, { throwIfNoEntry: false });
      if (status === undefined) {
        if (!create) return { kind: 'Missing' };
        mkdirSync(path, { mode: 0o700 });
      }
      if (!ownerOnlyDirectory(path)) return { kind: 'UnsafePath' };
    }
    if (
      realpathSync(directory) !== join(realpathSync(stateRoot), 'evaluations', binding.evaluationId)
    )
      return { kind: 'UnsafePath' };
    return { kind: 'Ready', directory };
  } catch {
    return { kind: 'UnsafePath' };
  }
}

function configure(database: DatabaseSync): boolean {
  database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA temp_store=MEMORY;
    PRAGMA busy_timeout=5000;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive(true);
  const journal: unknown = database.prepare('PRAGMA journal_mode').get();
  const synchronous: unknown = database.prepare('PRAGMA synchronous').get();
  return (
    typeof journal === 'object' &&
    journal !== null &&
    'journal_mode' in journal &&
    journal.journal_mode === 'delete' &&
    typeof synchronous === 'object' &&
    synchronous !== null &&
    'synchronous' in synchronous &&
    synchronous.synchronous === 2
  );
}

function createSchema(database: DatabaseSync, binding: ProtectedCaseKeyBinding): void {
  database.exec(`
    CREATE TABLE key_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_aid TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      personal_agent_aid TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_mandate_said TEXT NOT NULL,
      key_bytes BLOB NOT NULL CHECK (length(key_bytes) = 32),
      nonce_prefix BLOB NOT NULL CHECK (length(nonce_prefix) = 4),
      next_nonce INTEGER NOT NULL CHECK (next_nonce BETWEEN 0 AND 9007199254740991)
    ) STRICT;
    PRAGMA user_version=1;
  `);
  database
    .prepare('INSERT INTO key_state VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)')
    .run(
      binding.ownerAid,
      binding.evaluationId,
      binding.personalAgentAid,
      binding.taskId,
      binding.taskMandateSaid,
      randomBytes(32),
      randomBytes(4),
    );
}

function keyRow(database: DatabaseSync): KeyRow | undefined {
  const row: unknown = database.prepare('SELECT * FROM key_state WHERE singleton=1').get();
  if (typeof row !== 'object' || row === null) return undefined;
  if (
    !('singleton' in row) ||
    row.singleton !== 1 ||
    !('owner_aid' in row) ||
    typeof row.owner_aid !== 'string' ||
    !('evaluation_id' in row) ||
    typeof row.evaluation_id !== 'string' ||
    !('personal_agent_aid' in row) ||
    typeof row.personal_agent_aid !== 'string' ||
    !('task_id' in row) ||
    typeof row.task_id !== 'string' ||
    !('task_mandate_said' in row) ||
    typeof row.task_mandate_said !== 'string' ||
    !('key_bytes' in row) ||
    !(row.key_bytes instanceof Uint8Array) ||
    row.key_bytes.byteLength !== 32 ||
    !('nonce_prefix' in row) ||
    !(row.nonce_prefix instanceof Uint8Array) ||
    row.nonce_prefix.byteLength !== 4 ||
    !('next_nonce' in row) ||
    typeof row.next_nonce !== 'number' ||
    !Number.isSafeInteger(row.next_nonce) ||
    row.next_nonce < 0
  )
    return undefined;
  return row as KeyRow;
}

function validSchema(database: DatabaseSync): boolean {
  const integrity: unknown = database.prepare('PRAGMA integrity_check').get();
  const version: unknown = database.prepare('PRAGMA user_version').get();
  const objects: unknown[] = database
    .prepare("SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all();
  return (
    typeof integrity === 'object' &&
    integrity !== null &&
    'integrity_check' in integrity &&
    integrity.integrity_check === 'ok' &&
    typeof version === 'object' &&
    version !== null &&
    'user_version' in version &&
    version.user_version === 1 &&
    objects.length === 1 &&
    typeof objects[0] === 'object' &&
    objects[0] !== null &&
    'name' in objects[0] &&
    objects[0].name === 'key_state' &&
    'type' in objects[0] &&
    objects[0].type === 'table'
  );
}

/** Private local key custody; its file must never be mounted into candidate or native workers. */
export class SqliteProtectedCaseKeyCustody implements ProtectedCaseCustody {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #identity: { readonly dev: number | bigint; readonly ino: number | bigint };
  readonly #cases: AesGcmProtectedCaseCustody;
  readonly #binding: ProtectedCaseKeyBinding;
  readonly #keyDigest: Buffer;
  readonly #noncePrefix: Buffer;
  #nextMinimum: number;
  #closed = false;

  private constructor(
    database: DatabaseSync,
    path: string,
    row: KeyRow,
    binding: ProtectedCaseKeyBinding,
  ) {
    this.#database = database;
    this.#path = path;
    const status = ownerOnlyFile(path);
    if (status === undefined) throw new Error('Protected key file changed during open');
    this.#identity = { dev: status.dev, ino: status.ino };
    this.#binding = binding;
    this.#keyDigest = createHash('sha256').update(row.key_bytes).digest();
    this.#noncePrefix = Buffer.from(row.nonce_prefix);
    this.#nextMinimum = row.next_nonce;
    this.#cases = new AesGcmProtectedCaseCustody(row.key_bytes, () => this.#reserveNonce());
  }

  static create(stateRoot: string, binding: ProtectedCaseKeyBinding): CreateOutcome {
    if (!validBinding(binding)) return { kind: 'InvalidBinding' };
    const directory = directoryFor(stateRoot, binding, true);
    if (directory.kind !== 'Ready') return { kind: 'UnsafePath' };
    const path = join(directory.directory, 'protected-cases.sqlite');
    try {
      if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
        return { kind: ownerOnlyFile(path) === undefined ? 'UnsafePath' : 'AlreadyExists' };
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
      if (ownerOnlyFile(path) === undefined) return { kind: 'UnsafePath' };
      const database = new DatabaseSync(path);
      try {
        if (!configure(database)) throw new Error('SQLite FULL synchronization unavailable');
        createSchema(database, binding);
        const row = keyRow(database);
        if (!validSchema(database) || row === undefined)
          throw new Error('Protected key initialization failed');
        return {
          kind: 'Created',
          custody: new SqliteProtectedCaseKeyCustody(database, path, row, binding),
        };
      } catch {
        database.close();
        return { kind: 'Unavailable' };
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  static reopen(stateRoot: string, binding: ProtectedCaseKeyBinding): ReopenOutcome {
    if (!validBinding(binding)) return { kind: 'InvalidBinding' };
    const directory = directoryFor(stateRoot, binding, false);
    if (directory.kind === 'Missing') return { kind: 'Missing' };
    if (directory.kind !== 'Ready') return { kind: 'UnsafePath' };
    const path = join(directory.directory, 'protected-cases.sqlite');
    try {
      const before = lstatSync(path, { throwIfNoEntry: false });
      if (before === undefined) return { kind: 'Missing' };
      if (ownerOnlyFile(path) === undefined) return { kind: 'UnsafePath' };
      const database = new DatabaseSync(path);
      try {
        const after = ownerOnlyFile(path);
        if (after === undefined || after.dev !== before.dev || after.ino !== before.ino)
          throw new Error('Protected key file changed during open');
        if (!configure(database) || !validSchema(database)) {
          database.close();
          return { kind: 'Corrupt' };
        }
        const row = keyRow(database);
        if (row === undefined) {
          database.close();
          return { kind: 'Corrupt' };
        }
        if (
          row.owner_aid !== binding.ownerAid ||
          row.evaluation_id !== binding.evaluationId ||
          row.personal_agent_aid !== binding.personalAgentAid ||
          row.task_id !== binding.taskId ||
          row.task_mandate_said !== binding.taskMandateSaid
        ) {
          database.close();
          return { kind: 'BindingMismatch' };
        }
        return {
          kind: 'Opened',
          custody: new SqliteProtectedCaseKeyCustody(database, path, row, binding),
        };
      } catch {
        database.close();
        return { kind: 'Corrupt' };
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  #reserveNonce(): Uint8Array {
    if (this.#closed) throw new Error('Protected key custody is closed');
    const status = ownerOnlyFile(this.#path);
    if (
      status === undefined ||
      status.dev !== this.#identity.dev ||
      status.ino !== this.#identity.ino
    )
      throw new Error('Protected key file changed');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = keyRow(this.#database);
      if (
        row === undefined ||
        row.owner_aid !== this.#binding.ownerAid ||
        row.evaluation_id !== this.#binding.evaluationId ||
        row.personal_agent_aid !== this.#binding.personalAgentAid ||
        row.task_id !== this.#binding.taskId ||
        row.task_mandate_said !== this.#binding.taskMandateSaid ||
        !timingSafeEqual(createHash('sha256').update(row.key_bytes).digest(), this.#keyDigest) ||
        !timingSafeEqual(Buffer.from(row.nonce_prefix), this.#noncePrefix) ||
        row.next_nonce < this.#nextMinimum ||
        row.next_nonce >= maximumNonce
      )
        throw new Error('Protected nonce capacity exhausted');
      const updated = this.#database
        .prepare('UPDATE key_state SET next_nonce = ? WHERE singleton=1 AND next_nonce = ?')
        .run(row.next_nonce + 1, row.next_nonce);
      if (updated.changes !== 1) throw new Error('Protected nonce reservation conflicted');
      this.#database.exec('COMMIT');
      this.#nextMinimum = row.next_nonce + 1;
      const nonce = Buffer.alloc(12);
      Buffer.from(row.nonce_prefix).copy(nonce, 0);
      nonce.writeBigUInt64BE(BigInt(row.next_nonce), 4);
      return nonce;
    } catch (cause) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // A failed or completed transaction cannot license another nonce.
      }
      throw cause;
    }
  }

  seal(
    input: Parameters<ProtectedCaseCustody['seal']>[0],
  ): ReturnType<ProtectedCaseCustody['seal']> {
    return this.#closed ? Promise.resolve({ kind: 'Unavailable' }) : this.#cases.seal(input);
  }

  open(
    input: Parameters<ProtectedCaseCustody['open']>[0],
  ): ReturnType<ProtectedCaseCustody['open']> {
    return this.#closed ? Promise.resolve({ kind: 'KeyUnavailable' }) : this.#cases.open(input);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}
