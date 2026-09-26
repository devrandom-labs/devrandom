import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { taskBudgetCeilings } from '@devrandom/domain';
import {
  decodeEvaluationEvidenceBatch,
  decodeProtectedEvaluationArtifact,
  decodePublicEvaluationArtifact,
  evaluationEvidenceAcknowledgementSchema,
  evaluationEvidenceUploadSchema,
  prepareEvaluationEvidenceBatch,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

export interface EvaluationEvidenceBinding {
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly streamId: string;
  readonly originRunId: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
}

export interface EvaluationEvidenceStaging {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly events: readonly EvaluationEvidenceEvent[];
  readonly publicArtifacts: readonly {
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }[];
  readonly protectedArtifacts: readonly ProtectedEvaluationArtifact[];
}

type Upload = Type.Static<typeof evaluationEvidenceUploadSchema>;
type Acknowledgement = Type.Static<typeof evaluationEvidenceAcknowledgementSchema>;
type Custody = 'Public' | 'ProtectedCiphertext';

const saidPattern = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const storageByteLimit = 256 * 1_024 * 1_024;
const integer = Type.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER });
const stateSchema = Type.Object(
  {
    singleton: Type.Literal(1),
    owner_aid: Type.String(),
    evaluation_id: Type.String(),
    stream_id: Type.String(),
    origin_run_id: Type.String(),
    task_id: Type.String(),
    task_revision_said: Type.String(),
    personal_agent_aid: Type.String(),
    task_mandate_said: Type.String(),
    next_sequence: integer,
    chain_head_said: Type.Union([Type.String(), Type.Null()]),
    acknowledged_sequence: integer,
    acknowledged_head_said: Type.Union([Type.String(), Type.Null()]),
    stored_bytes: integer,
  },
  { additionalProperties: false },
);
const uploadRowSchema = Type.Object(
  {
    batch_said: Type.String(),
    starting_sequence: integer,
    ending_sequence: integer,
    chain_head_said: Type.String(),
    encoded_upload: Type.String(),
    encoded_bytes: integer,
    acknowledgement: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
const artifactRowSchema = Type.Object(
  { artifact_said: Type.String(), custody: Type.String(), batch_said: Type.String() },
  { additionalProperties: false },
);

type StateRow = Type.Static<typeof stateSchema>;
type UploadRow = Type.Static<typeof uploadRowSchema>;

function belongsToBinding(upload: Upload, binding: EvaluationEvidenceBinding): boolean {
  return (
    upload.batch.evaluationId === binding.evaluationId &&
    upload.batch.streamId === binding.streamId &&
    upload.batch.originRunId === binding.originRunId &&
    upload.batch.taskId === binding.taskId &&
    upload.events.every(
      (event) =>
        event.evaluationId === binding.evaluationId &&
        event.streamId === binding.streamId &&
        event.originRunId === binding.originRunId &&
        event.taskId === binding.taskId &&
        event.taskRevisionSaid === binding.taskRevisionSaid &&
        event.personalAgentAid === binding.personalAgentAid &&
        event.taskMandateSaid === binding.taskMandateSaid,
    )
  );
}

function validUpload(upload: unknown, binding: EvaluationEvidenceBinding): upload is Upload {
  return (
    Value.Check(evaluationEvidenceUploadSchema, upload) &&
    decodeEvaluationEvidenceBatch(upload.batch, upload.events).kind === 'Accepted' &&
    belongsToBinding(upload, binding) &&
    upload.publicArtifacts.every(
      (envelope) => decodePublicEvaluationArtifact(envelope).kind === 'Accepted',
    ) &&
    upload.protectedArtifacts.every(
      (artifact) =>
        decodeProtectedEvaluationArtifact(artifact).kind === 'Accepted' &&
        artifact.evaluationId === binding.evaluationId,
    )
  );
}

function artifactReferences(event: EvaluationEvidenceEvent): readonly string[] {
  switch (event.detail.kind) {
    case 'ModelExchange':
      return [event.detail.rawArtifactSaid];
    case 'ToolProposed':
      return [event.detail.inputArtifactSaid];
    case 'ToolAuthorization':
    case 'EffectObserved':
      return [event.detail.receiptArtifactSaid];
    case 'EvaluationBudgetDebited':
      return [event.detail.receiptArtifactSaid];
    case 'ProviderUsageVerified':
      return [event.detail.receiptArtifactSaid, event.detail.providerReportArtifactSaid];
    case 'ArtifactCaptured':
      return [event.detail.artifactSaid];
    case 'SourceRead':
      return [event.detail.rawArtifactSaid];
    case 'UsageDebited':
    case 'EvaluationBudgetCovered':
    case 'TrialStopped':
    case 'DataWithheld':
      return [];
  }
}

function publicAndProtected(upload: Upload): Map<string, Custody> | undefined {
  const artifacts = new Map<string, Custody>();
  for (const envelope of upload.publicArtifacts) {
    if (artifacts.has(envelope.artifact.d)) return undefined;
    artifacts.set(envelope.artifact.d, 'Public');
  }
  for (const artifact of upload.protectedArtifacts) {
    if (artifacts.has(artifact.d)) return undefined;
    artifacts.set(artifact.d, 'ProtectedCiphertext');
  }
  return artifacts;
}

function referencesHaveCustody(upload: Upload, custody: ReadonlyMap<string, Custody>): boolean {
  for (const event of upload.events) {
    for (const artifactSaid of artifactReferences(event)) {
      // A Research SourceRead is authorized by the hosted source inventory and
      // exact Run custody, not by a duplicate Evaluation artifact upload.
      if (event.detail.kind === 'SourceRead' && event.phase.kind === 'Research') continue;
      const kind = custody.get(artifactSaid);
      if (kind === undefined) return false;
      if (event.detail.kind === 'ArtifactCaptured' && event.detail.custody !== kind) return false;
      if (event.detail.kind === 'SourceRead') {
        if (event.detail.sourceSaid !== artifactSaid || kind !== 'Public') return false;
      }
    }
  }
  return true;
}

function state(database: DatabaseSync): StateRow | undefined {
  const row: unknown = database.prepare('SELECT * FROM stream_state WHERE singleton = 1').get();
  return Value.Check(stateSchema, row) ? row : undefined;
}

function uploadRow(input: unknown): UploadRow | undefined {
  return Value.Check(uploadRowSchema, input) ? input : undefined;
}

function decodeStoredUpload(
  row: UploadRow,
  binding: EvaluationEvidenceBinding,
): Upload | undefined {
  if (Buffer.byteLength(row.encoded_upload, 'utf8') !== row.encoded_bytes) return undefined;
  if (row.encoded_bytes > taskBudgetCeilings.artifactRequestBodyBytes) return undefined;
  try {
    const upload: unknown = JSON.parse(row.encoded_upload);
    return validUpload(upload, binding) &&
      upload.batch.d === row.batch_said &&
      upload.batch.startingSequence === row.starting_sequence &&
      upload.batch.endingSequence === row.ending_sequence &&
      upload.events.at(-1)?.d === row.chain_head_said
      ? upload
      : undefined;
  } catch {
    return undefined;
  }
}

function matchingAcknowledgement(
  input: unknown,
  upload: Upload,
  binding: EvaluationEvidenceBinding,
): input is Acknowledgement {
  return (
    Value.Check(evaluationEvidenceAcknowledgementSchema, input) &&
    input.evaluationId === binding.evaluationId &&
    input.streamId === binding.streamId &&
    input.batchSaid === upload.batch.d &&
    input.acceptedThroughSequence === upload.batch.endingSequence &&
    input.chainHeadSaid === upload.events.at(-1)?.d
  );
}

function ownerOnlyDirectory(path: string): boolean {
  const status = lstatSync(path);
  return (
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    (status.mode & 0o777) === 0o700 &&
    status.uid === process.getuid?.()
  );
}

function configure(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive(true);
  const journal: unknown = database.prepare('PRAGMA journal_mode').get();
  const synchronous: unknown = database.prepare('PRAGMA synchronous').get();
  const foreignKeys: unknown = database.prepare('PRAGMA foreign_keys').get();
  if (
    typeof journal !== 'object' ||
    journal === null ||
    !('journal_mode' in journal) ||
    journal.journal_mode !== 'delete' ||
    typeof synchronous !== 'object' ||
    synchronous === null ||
    !('synchronous' in synchronous) ||
    synchronous.synchronous !== 2 ||
    typeof foreignKeys !== 'object' ||
    foreignKeys === null ||
    !('foreign_keys' in foreignKeys) ||
    foreignKeys.foreign_keys !== 1
  )
    throw new Error('Evaluation SQLite durability unavailable');
}

function createSchema(database: DatabaseSync, binding: EvaluationEvidenceBinding): void {
  database.exec(`
    CREATE TABLE stream_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_aid TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      origin_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision_said TEXT NOT NULL,
      personal_agent_aid TEXT NOT NULL,
      task_mandate_said TEXT NOT NULL,
      next_sequence INTEGER NOT NULL,
      chain_head_said TEXT,
      acknowledged_sequence INTEGER NOT NULL,
      acknowledged_head_said TEXT,
      stored_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE uploads (
      batch_said TEXT PRIMARY KEY,
      starting_sequence INTEGER NOT NULL UNIQUE,
      ending_sequence INTEGER NOT NULL,
      chain_head_said TEXT NOT NULL,
      encoded_upload TEXT NOT NULL,
      encoded_bytes INTEGER NOT NULL,
      acknowledgement TEXT
    ) STRICT;
    CREATE TABLE artifacts (
      artifact_said TEXT PRIMARY KEY,
      custody TEXT NOT NULL CHECK (custody IN ('Public', 'ProtectedCiphertext')),
      batch_said TEXT NOT NULL REFERENCES uploads(batch_said)
    ) STRICT;
    PRAGMA user_version=1;
  `);
  database
    .prepare(`INSERT INTO stream_state VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, -1, NULL, 0)`)
    .run(
      binding.ownerAid,
      binding.evaluationId,
      binding.streamId,
      binding.originRunId,
      binding.taskId,
      binding.taskRevisionSaid,
      binding.personalAgentAid,
      binding.taskMandateSaid,
    );
}

function validStoredState(database: DatabaseSync, binding: EvaluationEvidenceBinding): boolean {
  const integrity: unknown = database.prepare('PRAGMA integrity_check').get();
  const version: unknown = database.prepare('PRAGMA user_version').get();
  const row = state(database);
  if (
    typeof integrity !== 'object' ||
    integrity === null ||
    !('integrity_check' in integrity) ||
    integrity.integrity_check !== 'ok' ||
    typeof version !== 'object' ||
    version === null ||
    !('user_version' in version) ||
    version.user_version !== 1 ||
    row === undefined ||
    row.owner_aid !== binding.ownerAid ||
    row.evaluation_id !== binding.evaluationId ||
    row.stream_id !== binding.streamId ||
    row.origin_run_id !== binding.originRunId ||
    row.task_id !== binding.taskId ||
    row.task_revision_said !== binding.taskRevisionSaid ||
    row.personal_agent_aid !== binding.personalAgentAid ||
    row.task_mandate_said !== binding.taskMandateSaid
  )
    return false;
  let nextSequence = 0;
  let chainHead: string | null = null;
  let acknowledgedSequence = -1;
  let acknowledgedHead: string | null = null;
  let storedBytes = 0;
  let seenPending = false;
  const custody = new Map<string, Custody>();
  const artifactBatches = new Map<string, string>();
  const rows: unknown[] = database
    .prepare('SELECT * FROM uploads ORDER BY starting_sequence')
    .all();
  for (const candidate of rows) {
    const batch = uploadRow(candidate);
    if (batch === undefined) return false;
    const upload = decodeStoredUpload(batch, binding);
    if (
      upload === undefined ||
      batch.starting_sequence !== nextSequence ||
      (chainHead === null
        ? upload.batch.predecessor.kind !== 'Genesis'
        : upload.batch.predecessor.kind !== 'Previous' ||
          upload.batch.predecessor.eventSaid !== chainHead)
    )
      return false;
    const fresh = publicAndProtected(upload);
    if (fresh === undefined) return false;
    for (const [said, kind] of fresh) {
      if (custody.has(said)) return false;
      custody.set(said, kind);
      artifactBatches.set(said, upload.batch.d);
    }
    if (!referencesHaveCustody(upload, custody)) return false;
    nextSequence = upload.batch.endingSequence + 1;
    chainHead = batch.chain_head_said;
    storedBytes += batch.encoded_bytes;
    if (batch.acknowledgement === null) {
      seenPending = true;
    } else {
      if (seenPending) return false;
      let receipt: unknown;
      try {
        receipt = JSON.parse(batch.acknowledgement);
      } catch {
        return false;
      }
      if (!matchingAcknowledgement(receipt, upload, binding)) return false;
      acknowledgedSequence = batch.ending_sequence;
      acknowledgedHead = batch.chain_head_said;
    }
  }
  const artifactRows: unknown[] = database.prepare('SELECT * FROM artifacts').all();
  if (artifactRows.length !== custody.size) return false;
  for (const candidate of artifactRows) {
    if (!Value.Check(artifactRowSchema, candidate)) return false;
    if (
      custody.get(candidate.artifact_said) !== candidate.custody ||
      artifactBatches.get(candidate.artifact_said) !== candidate.batch_said
    )
      return false;
  }
  return (
    row.next_sequence === nextSequence &&
    row.chain_head_said === chainHead &&
    row.acknowledged_sequence === acknowledgedSequence &&
    row.acknowledged_head_said === acknowledgedHead &&
    row.stored_bytes === storedBytes &&
    storedBytes <= storageByteLimit
  );
}

/** Owner-bound durable transport custody for one native Evaluation evidence stream. */
export class SqliteEvaluationEvidenceOutbox {
  readonly #database: DatabaseSync;
  readonly #binding: EvaluationEvidenceBinding;

  private constructor(database: DatabaseSync, binding: EvaluationEvidenceBinding) {
    this.#database = database;
    this.#binding = binding;
  }

  static open(
    stateRoot: string,
    binding: EvaluationEvidenceBinding,
  ):
    | { readonly kind: 'Opened'; readonly outbox: SqliteEvaluationEvidenceOutbox }
    | { readonly kind: 'Corrupt' | 'Unavailable' } {
    if (
      !isAbsolute(stateRoot) ||
      !saidPattern.test(binding.ownerAid) ||
      !saidPattern.test(binding.taskRevisionSaid) ||
      !saidPattern.test(binding.personalAgentAid) ||
      !saidPattern.test(binding.taskMandateSaid) ||
      ![binding.evaluationId, binding.streamId, binding.originRunId, binding.taskId].every((id) =>
        uuidPattern.test(id),
      ) ||
      new Set([binding.evaluationId, binding.streamId, binding.originRunId]).size !== 3
    )
      return { kind: 'Corrupt' };
    const evaluations = join(stateRoot, 'evaluations');
    const directory = join(evaluations, binding.evaluationId);
    const path = join(directory, 'outbox.sqlite');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (
        !ownerOnlyDirectory(stateRoot) ||
        !ownerOnlyDirectory(evaluations) ||
        !ownerOnlyDirectory(directory) ||
        realpathSync(directory) !==
          join(realpathSync(stateRoot), 'evaluations', binding.evaluationId)
      )
        return { kind: 'Corrupt' };
      const status = lstatSync(path, { throwIfNoEntry: false });
      if (
        status !== undefined &&
        (!status.isFile() ||
          status.isSymbolicLink() ||
          status.nlink !== 1 ||
          (status.mode & 0o777) !== 0o600 ||
          status.uid !== process.getuid?.())
      )
        return { kind: 'Corrupt' };
      if (status === undefined) {
        const descriptor = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(descriptor);
      }
      const database = new DatabaseSync(path);
      try {
        configure(database);
        if (status === undefined) createSchema(database, binding);
        if (!validStoredState(database, binding)) {
          database.close();
          return { kind: 'Corrupt' };
        }
        return { kind: 'Opened', outbox: new SqliteEvaluationEvidenceOutbox(database, binding) };
      } catch {
        database.close();
        return { kind: 'Corrupt' };
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  /** Durable local and hosted-acknowledged cursors for exact successor staging. */
  position():
    | {
        readonly kind: 'Position';
        readonly nextSequence: number;
        readonly chainHeadSaid: string | null;
        readonly acknowledgedSequence: number;
        readonly acknowledgedHeadSaid: string | null;
      }
    | { readonly kind: 'Corrupt' } {
    try {
      if (!validStoredState(this.#database, this.#binding)) return { kind: 'Corrupt' };
      const current = state(this.#database);
      if (current === undefined) return { kind: 'Corrupt' };
      return {
        kind: 'Position',
        nextSequence: current.next_sequence,
        chainHeadSaid: current.chain_head_said,
        acknowledgedSequence: current.acknowledged_sequence,
        acknowledgedHeadSaid: current.acknowledged_head_said,
      };
    } catch {
      return { kind: 'Corrupt' };
    }
  }

  /** Exact staged successor, including a prior ACK, for crash and lost-response reconciliation. */
  following(predecessorSaid: string | null):
    | {
        readonly kind: 'Found';
        readonly upload: Upload;
        readonly acknowledgement: Acknowledgement | null;
      }
    | { readonly kind: 'Empty' | 'Corrupt' } {
    try {
      if (!validStoredState(this.#database, this.#binding)) return { kind: 'Corrupt' };
      const rows: unknown[] = this.#database
        .prepare('SELECT * FROM uploads ORDER BY starting_sequence')
        .all();
      for (const candidate of rows) {
        const row = uploadRow(candidate);
        if (row === undefined) return { kind: 'Corrupt' };
        const upload = decodeStoredUpload(row, this.#binding);
        if (upload === undefined) return { kind: 'Corrupt' };
        const previous = upload.events[0]?.previous;
        if (
          !(predecessorSaid === null
            ? previous?.kind === 'Genesis'
            : previous?.kind === 'Previous' && previous.eventSaid === predecessorSaid)
        )
          continue;
        if (row.acknowledgement === null) return { kind: 'Found', upload, acknowledgement: null };
        const receipt: unknown = JSON.parse(row.acknowledgement);
        if (!matchingAcknowledgement(receipt, upload, this.#binding)) return { kind: 'Corrupt' };
        return { kind: 'Found', upload, acknowledgement: receipt };
      }
      return { kind: 'Empty' };
    } catch {
      return { kind: 'Corrupt' };
    }
  }

  /** Exact protected ciphertext retained locally and acknowledged by hosted Evidence. */
  protectedArtifact(
    artifactSaid: string,
  ):
    | { readonly kind: 'Found'; readonly artifact: ProtectedEvaluationArtifact }
    | { readonly kind: 'Missing' | 'Corrupt' } {
    if (!saidPattern.test(artifactSaid)) return { kind: 'Corrupt' };
    try {
      if (!validStoredState(this.#database, this.#binding)) return { kind: 'Corrupt' };
      const candidate: unknown = this.#database
        .prepare('SELECT * FROM artifacts WHERE artifact_said = ?')
        .get(artifactSaid);
      if (candidate === undefined) return { kind: 'Missing' };
      if (!Value.Check(artifactRowSchema, candidate)) return { kind: 'Corrupt' };
      if (candidate.custody !== 'ProtectedCiphertext') return { kind: 'Missing' };
      const row = uploadRow(
        this.#database
          .prepare('SELECT * FROM uploads WHERE batch_said = ?')
          .get(candidate.batch_said),
      );
      if (row === undefined) return { kind: 'Corrupt' };
      const upload = decodeStoredUpload(row, this.#binding);
      if (upload === undefined) return { kind: 'Corrupt' };
      if (row.acknowledgement === null) return { kind: 'Missing' };
      const receipt: unknown = JSON.parse(row.acknowledgement);
      if (!matchingAcknowledgement(receipt, upload, this.#binding)) return { kind: 'Corrupt' };
      const artifact = upload.protectedArtifacts.find((item) => item.d === artifactSaid);
      if (artifact === undefined || decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted')
        return { kind: 'Corrupt' };
      return { kind: 'Found', artifact };
    } catch {
      return { kind: 'Corrupt' };
    }
  }

  stage(
    input: EvaluationEvidenceStaging,
  ):
    | { readonly kind: 'Staged' | 'AlreadyStaged'; readonly batchSaid: string }
    | { readonly kind: 'Rejected' | 'Conflict' | 'QuotaExceeded' | 'Corrupt' } {
    const prepared = prepareEvaluationEvidenceBatch(input.events);
    if (prepared.kind !== 'Prepared') return { kind: 'Rejected' };
    const upload = {
      version: 1 as const,
      commandId: input.commandId,
      fingerprint: input.fingerprint,
      batch: prepared.batch,
      events: [...input.events],
      publicArtifacts: input.publicArtifacts.map(({ artifact, bytes }) => ({
        artifact,
        bytesBase64Url: Buffer.from(bytes).toString('base64url'),
      })),
      protectedArtifacts: [...input.protectedArtifacts],
    };
    if (!validUpload(upload, this.#binding)) return { kind: 'Rejected' };
    const encoded = JSON.stringify(upload);
    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    if (encodedBytes > taskBudgetCeilings.artifactRequestBodyBytes)
      return { kind: 'QuotaExceeded' };
    const finalEvent = upload.events.at(-1);
    if (finalEvent === undefined) return { kind: 'Rejected' };
    const fresh = publicAndProtected(upload);
    if (fresh === undefined) return { kind: 'Rejected' };
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const prior = uploadRow(
        this.#database.prepare('SELECT * FROM uploads WHERE batch_said = ?').get(upload.batch.d),
      );
      if (prior !== undefined) {
        this.#database.exec('ROLLBACK');
        return prior.encoded_upload === encoded
          ? { kind: 'AlreadyStaged', batchSaid: upload.batch.d }
          : { kind: 'Conflict' };
      }
      const current = state(this.#database);
      if (current === undefined) throw new Error('outbox state invalid');
      if (
        upload.batch.startingSequence !== current.next_sequence ||
        (current.chain_head_said === null
          ? upload.batch.predecessor.kind !== 'Genesis'
          : upload.batch.predecessor.kind !== 'Previous' ||
            upload.batch.predecessor.eventSaid !== current.chain_head_said)
      ) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Conflict' };
      }
      if (current.stored_bytes + encodedBytes > storageByteLimit) {
        this.#database.exec('ROLLBACK');
        return { kind: 'QuotaExceeded' };
      }
      for (const artifactSaid of fresh.keys()) {
        if (
          this.#database
            .prepare('SELECT artifact_said FROM artifacts WHERE artifact_said = ?')
            .get(artifactSaid) !== undefined
        ) {
          this.#database.exec('ROLLBACK');
          return { kind: 'Conflict' };
        }
      }
      const custody = new Map<string, Custody>(fresh);
      for (const event of upload.events) {
        for (const artifactSaid of artifactReferences(event)) {
          if (custody.has(artifactSaid)) continue;
          const row: unknown = this.#database
            .prepare('SELECT custody FROM artifacts WHERE artifact_said = ?')
            .get(artifactSaid);
          if (
            typeof row === 'object' &&
            row !== null &&
            'custody' in row &&
            (row.custody === 'Public' || row.custody === 'ProtectedCiphertext')
          )
            custody.set(artifactSaid, row.custody);
        }
      }
      if (!referencesHaveCustody(upload, custody)) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Rejected' };
      }
      this.#database
        .prepare('INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(
          upload.batch.d,
          upload.batch.startingSequence,
          upload.batch.endingSequence,
          finalEvent.d,
          encoded,
          encodedBytes,
        );
      for (const [said, kind] of fresh)
        this.#database
          .prepare('INSERT INTO artifacts VALUES (?, ?, ?)')
          .run(said, kind, upload.batch.d);
      this.#database
        .prepare(
          `UPDATE stream_state SET next_sequence = ?, chain_head_said = ?, stored_bytes = ? WHERE singleton = 1`,
        )
        .run(upload.batch.endingSequence + 1, finalEvent.d, current.stored_bytes + encodedBytes);
      this.#database.exec('COMMIT');
      return { kind: 'Staged', batchSaid: upload.batch.d };
    } catch {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // No active transaction after an I/O failure.
      }
      return { kind: 'Corrupt' };
    }
  }

  pending():
    { readonly kind: 'Pending'; readonly upload: Upload } | { readonly kind: 'Empty' | 'Corrupt' } {
    try {
      const candidate: unknown = this.#database
        .prepare(
          'SELECT * FROM uploads WHERE acknowledgement IS NULL ORDER BY starting_sequence LIMIT 1',
        )
        .get();
      if (candidate === undefined) return { kind: 'Empty' };
      const row = uploadRow(candidate);
      const upload = row === undefined ? undefined : decodeStoredUpload(row, this.#binding);
      return upload === undefined ? { kind: 'Corrupt' } : { kind: 'Pending', upload };
    } catch {
      return { kind: 'Corrupt' };
    }
  }

  acknowledge(
    receipt: Acknowledgement,
  ):
    | { readonly kind: 'Recorded' | 'AlreadyRecorded' }
    | { readonly kind: 'Rejected' | 'Conflict' | 'Corrupt' } {
    if (!Value.Check(evaluationEvidenceAcknowledgementSchema, receipt)) return { kind: 'Rejected' };
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const candidate: unknown = this.#database
        .prepare(
          'SELECT * FROM uploads WHERE acknowledgement IS NULL ORDER BY starting_sequence LIMIT 1',
        )
        .get();
      const oldest = uploadRow(candidate);
      if (oldest === undefined || oldest.batch_said !== receipt.batchSaid) {
        const prior = uploadRow(
          this.#database
            .prepare('SELECT * FROM uploads WHERE batch_said = ?')
            .get(receipt.batchSaid),
        );
        this.#database.exec('ROLLBACK');
        if (prior === undefined || prior.acknowledgement === null) return { kind: 'Conflict' };
        const upload = decodeStoredUpload(prior, this.#binding);
        let recorded: unknown;
        try {
          recorded = JSON.parse(prior.acknowledgement);
        } catch {
          return { kind: 'Corrupt' };
        }
        if (upload === undefined || !matchingAcknowledgement(recorded, upload, this.#binding))
          return { kind: 'Corrupt' };
        return matchingAcknowledgement(receipt, upload, this.#binding)
          ? { kind: 'AlreadyRecorded' }
          : { kind: 'Conflict' };
      }
      const upload = decodeStoredUpload(oldest, this.#binding);
      const current = state(this.#database);
      if (upload === undefined || current === undefined) throw new Error('outbox row invalid');
      if (
        !matchingAcknowledgement(receipt, upload, this.#binding) ||
        current.acknowledged_sequence + 1 !== oldest.starting_sequence ||
        (current.acknowledged_head_said === null
          ? upload.batch.predecessor.kind !== 'Genesis'
          : upload.batch.predecessor.kind !== 'Previous' ||
            upload.batch.predecessor.eventSaid !== current.acknowledged_head_said)
      ) {
        this.#database.exec('ROLLBACK');
        return { kind: 'Conflict' };
      }
      this.#database
        .prepare('UPDATE uploads SET acknowledgement = ? WHERE batch_said = ?')
        .run(JSON.stringify(receipt), receipt.batchSaid);
      this.#database
        .prepare(
          `UPDATE stream_state SET acknowledged_sequence = ?, acknowledged_head_said = ? WHERE singleton = 1`,
        )
        .run(receipt.acceptedThroughSequence, receipt.chainHeadSaid);
      this.#database.exec('COMMIT');
      return { kind: 'Recorded' };
    } catch {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // No active transaction after an I/O failure.
      }
      return { kind: 'Corrupt' };
    }
  }

  close(): void {
    this.#database.close();
  }
}
