import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ProtectedCredentials, taskBudgetNames, type Run } from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeEvidenceBatchAcknowledgement,
  decodeEvidenceEvent,
  decodeEvidenceStreamProjection,
  decodeVerifiedCheckpoint,
  evidenceArtifactReferences,
  evidenceBatchAcknowledgementSchema,
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import type {
  EvidenceAcknowledgementRecording,
  EvidenceArtifactInput,
  EvidenceArtifactReading,
  EvidenceArtifactRecording,
  EvidenceCheckpointInput,
  EvidenceCheckpointAcceptanceRecording,
  EvidenceCheckpointReading,
  EvidenceCheckpointRecording,
  EvidenceObservation,
  EvidencePaging,
  EvidenceReadinessInspection,
  EvidenceRecorder,
  EvidenceRecorderAcquisition,
  EvidenceRecorderOpening,
  EvidenceRecorders,
  EvidenceRecording,
  EvidenceSealAcknowledgementReading,
  EvidenceSealAcknowledgementRecording,
} from '@devrandom/runtime';
import Type from 'typebox';
import Value from 'typebox/value';

import type { PreparedCompatibilityEvidence } from '../application/prepared-compatibility-calibration-settlement.js';
import type { RunPredecessorReading } from '../application/run-predecessor-custody.js';
import { readPreparedCompatibilityProviderProof } from './sqlite-prepared-compatibility-proofs.js';

const outboxSoftBound = 60 * 1_024 * 1_024;
const outboxHardBound = 64 * 1_024 * 1_024;

function terminalCalibrationObservation(observation: EvidenceObservation): boolean {
  if (
    observation.producer.kind !== 'RunSupervisor' &&
    observation.producer.kind !== 'EvidenceRecorder'
  )
    return false;
  const event = observation.event;
  if (event.kind === 'BudgetDebited')
    return (
      (event.budget === 'changedFiles' || event.budget === 'changedWorktreeBytes') &&
      event.amount > 0
    );
  if (event.kind === 'RunCalibrationRecorded')
    return event.disposition.kind === 'Excluded' && event.disposition.reason === 'BudgetExhausted';
  return event.kind === 'CheckpointVerified' || event.kind === 'CheckpointAccepted';
}

function evidenceStoragePurpose(event: EvidenceObservation['event']): 'Execution' | 'Closure' {
  switch (event.kind) {
    case 'BudgetDebited':
    case 'FailureObserved':
    case 'CheckpointVerified':
    case 'CheckpointAccepted':
    case 'RunBlocked':
    case 'RunCalibrationRecorded':
    case 'DataWithheld':
    case 'SecurityViolation':
      return 'Closure';
    case 'RunStarted':
    case 'IncarnationStarted':
    case 'RunExecutionProfileBound':
    case 'MandateVerified':
    case 'ModelRequest':
    case 'ModelMessageCompleted':
    case 'ToolProposed':
    case 'ToolAuthorized':
    case 'ToolRejected':
    case 'ApprovalRequired':
    case 'EffectCompleted':
    case 'EffectFailed':
    case 'Observation':
    case 'ContextSummary':
    case 'ResultSubmitted':
    case 'TaskVerificationAccepted':
    case 'TaskVerificationRejected':
      return 'Execution';
  }
}
const transportEventLimit = 32;
const transportByteLimit = 256 * 1_024;
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

const safeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const streamStateRowSchema = Type.Object(
  {
    run_id: Type.String(),
    stream_id: Type.String(),
    task_id: Type.String(),
    task_revision_said: Type.String(),
    incarnation_id: Type.String(),
    harness_revision_said: Type.String(),
    personal_agent_aid: Type.String(),
    task_mandate_said: Type.String(),
    next_sequence: safeIntegerSchema,
    chain_head: Type.Union([Type.String(), Type.Null()]),
    next_delivery_sequence: safeIntegerSchema,
    acknowledged_chain_head: Type.Union([Type.String(), Type.Null()]),
    encoded_bytes: safeIntegerSchema,
    artifact_bytes: safeIntegerSchema,
  },
  { additionalProperties: false },
);
const eventRowSchema = Type.Object(
  {
    sequence: safeIntegerSchema,
    event_said: Type.String(),
    encoded_event: Type.String(),
    byte_length: safeIntegerSchema,
  },
  { additionalProperties: false },
);
const integrityRowSchema = Type.Object(
  { integrity_check: Type.String() },
  { additionalProperties: false },
);
const countRowSchema = Type.Object(
  {
    event_count: safeIntegerSchema,
    minimum_sequence: Type.Union([safeIntegerSchema, Type.Null()]),
    maximum_sequence: Type.Union([safeIntegerSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
const changesRowSchema = Type.Object(
  { changed: safeIntegerSchema },
  { additionalProperties: false },
);
const pendingBatchRowSchema = Type.Object(
  { batch_said: saidSchema, ending_sequence: safeIntegerSchema },
  { additionalProperties: false },
);
const acknowledgementRowSchema = Type.Object(
  {
    batch_said: saidSchema,
    encoded_batch: Type.String(),
    encoded_acknowledgement: Type.String(),
    ending_sequence: safeIntegerSchema,
  },
  { additionalProperties: false },
);
const artifactRowSchema = Type.Object(
  {
    artifact_said: saidSchema,
    encoded_artifact: Type.String(),
    byte_length: safeIntegerSchema,
  },
  { additionalProperties: false },
);
const completionConditionIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z][a-z0-9-]{0,62}$' }),
  { minItems: 1, maxItems: 32, uniqueItems: true },
);
const checkpointRowSchema = Type.Object(
  {
    checkpoint_said: saidSchema,
    encoded_checkpoint: Type.String(),
    encoded_condition_ids: Type.String(),
    byte_length: Type.Integer({ minimum: 1, maximum: 256 * 1_024 }),
  },
  { additionalProperties: false },
);
const sealAcknowledgementRowSchema = Type.Object(
  {
    encoded_projection: Type.String({ minLength: 1, maxLength: 16 * 1_024 }),
    seal_exchange_said: saidSchema,
    sealed_at: Type.String(),
  },
  { additionalProperties: false },
);

type StreamStateRow = Type.Static<typeof streamStateRowSchema>;

function pathKind(path: string): 'Missing' | 'RegularFile' | 'Directory' | 'Conflict' {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      return 'Conflict';
    }
    if (status.isFile()) {
      return 'RegularFile';
    }
    return status.isDirectory() ? 'Directory' : 'Conflict';
  } catch {
    return 'Missing';
  }
}

function isOwnerOnlyDirectory(path: string): boolean {
  const status = lstatSync(path);
  return status.isDirectory() && !status.isSymbolicLink() && (status.mode & 0o777) === 0o700;
}

function pragmaNumber(database: DatabaseSync, name: string, field: string): number | undefined {
  const row: unknown = database.prepare(`PRAGMA ${name}`).get();
  if (typeof row !== 'object' || row === null || !(field in row)) {
    return undefined;
  }
  const value: unknown = Reflect.get(row, field);
  return typeof value === 'number' ? value : undefined;
}

function pragmaText(database: DatabaseSync, name: string, field: string): string | undefined {
  const row: unknown = database.prepare(`PRAGMA ${name}`).get();
  if (typeof row !== 'object' || row === null || !(field in row)) {
    return undefined;
  }
  const value: unknown = Reflect.get(row, field);
  return typeof value === 'string' ? value : undefined;
}

function configure(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA cache_size=-2048;
    PRAGMA mmap_size=0;
    PRAGMA temp_store=FILE;
  `);
  database.enableDefensive(true);
  if (
    pragmaText(database, 'journal_mode', 'journal_mode') !== 'delete' ||
    pragmaNumber(database, 'synchronous', 'synchronous') !== 2 ||
    pragmaNumber(database, 'foreign_keys', 'foreign_keys') !== 1 ||
    pragmaNumber(database, 'busy_timeout', 'timeout') !== 5_000 ||
    pragmaNumber(database, 'cache_size', 'cache_size') !== -2_048 ||
    pragmaNumber(database, 'mmap_size', 'mmap_size') !== 0 ||
    pragmaNumber(database, 'temp_store', 'temp_store') !== 1
  ) {
    throw new Error('SQLite evidence durability profile is unavailable');
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE stream_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      run_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision_said TEXT NOT NULL,
      incarnation_id TEXT NOT NULL,
      harness_revision_said TEXT NOT NULL,
      personal_agent_aid TEXT NOT NULL,
      task_mandate_said TEXT NOT NULL,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
      chain_head TEXT,
      next_delivery_sequence INTEGER NOT NULL CHECK (
        next_delivery_sequence >= 0 AND next_delivery_sequence <= next_sequence
      ),
      acknowledged_chain_head TEXT,
      encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
      artifact_bytes INTEGER NOT NULL CHECK (artifact_bytes >= 0),
      CHECK ((next_sequence = 0 AND chain_head IS NULL) OR (next_sequence > 0 AND chain_head IS NOT NULL)),
      CHECK (
        (next_delivery_sequence = 0 AND acknowledged_chain_head IS NULL) OR
        (next_delivery_sequence > 0 AND acknowledged_chain_head IS NOT NULL)
      )
    ) STRICT;
    CREATE TABLE evidence_events (
      sequence INTEGER PRIMARY KEY CHECK (sequence >= 0),
      event_said TEXT NOT NULL UNIQUE,
      encoded_event TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 65536)
    ) STRICT;
    CREATE TABLE evidence_artifacts (
      artifact_said TEXT PRIMARY KEY,
      encoded_artifact TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 524288)
    ) STRICT;
    CREATE TABLE evidence_artifact_references (
      sequence INTEGER NOT NULL REFERENCES evidence_events(sequence),
      artifact_said TEXT NOT NULL REFERENCES evidence_artifacts(artifact_said),
      PRIMARY KEY (sequence, artifact_said)
    ) STRICT;
    CREATE TABLE pending_evidence_batch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      batch_said TEXT NOT NULL,
      ending_sequence INTEGER NOT NULL CHECK (ending_sequence >= 0)
    ) STRICT;
    CREATE TABLE evidence_acknowledgements (
      batch_said TEXT PRIMARY KEY,
      encoded_batch TEXT NOT NULL,
      encoded_acknowledgement TEXT NOT NULL,
      ending_sequence INTEGER NOT NULL UNIQUE CHECK (ending_sequence >= 0)
    ) STRICT;
    CREATE TABLE verified_checkpoints (
      checkpoint_said TEXT PRIMARY KEY,
      encoded_checkpoint TEXT NOT NULL,
      encoded_condition_ids TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 262144)
    ) STRICT;
    CREATE TABLE evidence_seal_acknowledgement (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      encoded_projection TEXT NOT NULL CHECK (
        length(encoded_projection) > 0 AND length(encoded_projection) <= 16384
      ),
      seal_exchange_said TEXT NOT NULL,
      sealed_at TEXT NOT NULL
    ) STRICT;
  `);
}

function state(database: DatabaseSync): StreamStateRow | undefined {
  const row: unknown = database
    .prepare(
      `
      SELECT run_id, stream_id, task_id, task_revision_said, incarnation_id,
             harness_revision_said, personal_agent_aid, task_mandate_said,
             next_sequence, chain_head, next_delivery_sequence,
             acknowledged_chain_head, encoded_bytes, artifact_bytes
      FROM stream_state
      WHERE singleton = 1
    `,
    )
    .get();
  return Value.Check(streamStateRowSchema, row) ? row : undefined;
}

function stateMatches(run: Run, current: StreamStateRow): boolean {
  return (
    current.run_id === run.binding.runId &&
    current.stream_id ===
      (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId) &&
    current.task_id === run.binding.taskId &&
    current.task_revision_said === run.binding.taskRevisionSaid &&
    run.lease.kind === 'Held' &&
    current.incarnation_id === run.lease.incarnationId &&
    current.harness_revision_said ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) &&
    current.personal_agent_aid === run.binding.personalAgentAid &&
    current.task_mandate_said === run.binding.taskMandateSaid
  );
}

function sealedProjectionMatchesState(
  database: DatabaseSync,
  current: StreamStateRow,
  projection: EvidenceStreamProjection,
): boolean {
  if (
    projection.runId !== current.run_id ||
    projection.evidenceStreamId !== current.stream_id ||
    projection.cursor.kind !== 'Accepted' ||
    projection.checkpoint.kind !== 'Accepted' ||
    projection.seal.kind !== 'Sealed' ||
    current.next_sequence !== projection.cursor.eventCount ||
    current.next_delivery_sequence !== current.next_sequence ||
    current.chain_head !== projection.cursor.chainHeadSaid ||
    current.acknowledged_chain_head !== projection.cursor.chainHeadSaid
  ) {
    return false;
  }
  const checkpoint: unknown = database
    .prepare('SELECT checkpoint_said FROM verified_checkpoints WHERE checkpoint_said = ?')
    .get(projection.checkpoint.checkpointSaid);
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    !('checkpoint_said' in checkpoint) ||
    Reflect.get(checkpoint, 'checkpoint_said') !== projection.checkpoint.checkpointSaid
  ) {
    return false;
  }
  const last: unknown = database
    .prepare(
      `SELECT sequence, event_said, encoded_event, byte_length
       FROM evidence_events
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .get();
  if (!Value.Check(eventRowSchema, last)) {
    return false;
  }
  try {
    const encoded: unknown = JSON.parse(last.encoded_event);
    const decoded = decodeEvidenceEvent(encoded);
    return (
      decoded.kind === 'Accepted' &&
      decoded.event.sequence === projection.cursor.acceptedThroughSequence &&
      decoded.event.d === projection.cursor.chainHeadSaid &&
      decoded.event.event.kind === 'CheckpointAccepted' &&
      decoded.event.event.checkpointSaid === projection.checkpoint.checkpointSaid
    );
  } catch {
    return false;
  }
}

function decodeSealAcknowledgementRow(
  row: Type.Static<typeof sealAcknowledgementRowSchema>,
): EvidenceStreamProjection | undefined {
  try {
    const encoded: unknown = JSON.parse(row.encoded_projection);
    const decoded = decodeEvidenceStreamProjection(encoded);
    return decoded.kind === 'Accepted' &&
      decoded.projection.seal.kind === 'Sealed' &&
      decoded.projection.seal.sealExchangeSaid === row.seal_exchange_said &&
      decoded.projection.seal.sealedAt === row.sealed_at
      ? decoded.projection
      : undefined;
  } catch {
    return undefined;
  }
}

function sealedProjectionsMatch(
  left: EvidenceStreamProjection,
  right: EvidenceStreamProjection,
): boolean {
  return (
    left.cursor.kind === 'Accepted' &&
    right.cursor.kind === 'Accepted' &&
    left.checkpoint.kind === 'Accepted' &&
    right.checkpoint.kind === 'Accepted' &&
    left.seal.kind === 'Sealed' &&
    right.seal.kind === 'Sealed' &&
    left.runId === right.runId &&
    left.evidenceStreamId === right.evidenceStreamId &&
    left.cursor.eventCount === right.cursor.eventCount &&
    left.cursor.acceptedThroughSequence === right.cursor.acceptedThroughSequence &&
    left.cursor.chainHeadSaid === right.cursor.chainHeadSaid &&
    left.checkpoint.checkpointSaid === right.checkpoint.checkpointSaid &&
    left.seal.sealExchangeSaid === right.seal.sealExchangeSaid &&
    left.seal.eventCount === right.seal.eventCount &&
    left.seal.finalSequence === right.seal.finalSequence &&
    left.seal.chainHeadSaid === right.seal.chainHeadSaid &&
    left.seal.sealedAt === right.seal.sealedAt
  );
}

function existingOutboxIsValid(database: DatabaseSync, opening: EvidenceRecorderOpening): boolean {
  const integrity: unknown = database.prepare('PRAGMA integrity_check').get();
  const current = state(database);
  if (
    !Value.Check(integrityRowSchema, integrity) ||
    integrity.integrity_check !== 'ok' ||
    current === undefined ||
    !stateMatches(opening.run, current)
  ) {
    return false;
  }
  const count: unknown = database
    .prepare(
      `
      SELECT COUNT(*) AS event_count,
             MIN(sequence) AS minimum_sequence,
             MAX(sequence) AS maximum_sequence
      FROM evidence_events
    `,
    )
    .get();
  if (!Value.Check(countRowSchema, count)) {
    return false;
  }
  if (
    (count.event_count === 0 &&
      (current.next_sequence !== 0 ||
        current.chain_head !== null ||
        count.minimum_sequence !== null ||
        count.maximum_sequence !== null)) ||
    (count.event_count > 0 &&
      (count.minimum_sequence !== 0 ||
        count.maximum_sequence !== count.event_count - 1 ||
        current.next_sequence !== count.event_count))
  ) {
    return false;
  }
  let lastSaid: string | undefined;
  let acknowledgedSaid: string | undefined;
  let totalBytes = 0;
  const rows = database
    .prepare(
      'SELECT sequence, event_said, encoded_event, byte_length FROM evidence_events ORDER BY sequence',
    )
    .iterate();
  for (const row of rows) {
    if (!Value.Check(eventRowSchema, row)) {
      return false;
    }
    let decoded;
    try {
      const parsed: unknown = JSON.parse(row.encoded_event);
      decoded = decodeEvidenceEvent(parsed);
    } catch {
      return false;
    }
    if (
      decoded.kind !== 'Accepted' ||
      decoded.event.sequence !== row.sequence ||
      decoded.event.d !== row.event_said ||
      new TextEncoder().encode(row.encoded_event).byteLength !== row.byte_length
    ) {
      return false;
    }
    lastSaid = row.event_said;
    if (row.sequence === current.next_delivery_sequence - 1) {
      acknowledgedSaid = row.event_said;
    }
    totalBytes += row.byte_length;
  }
  if (
    current.chain_head !== (lastSaid ?? null) ||
    current.acknowledged_chain_head !== (acknowledgedSaid ?? null) ||
    current.encoded_bytes !== totalBytes
  ) {
    return false;
  }
  let artifactBytes = 0;
  const artifactDirectory =
    opening.run.currentExecution === undefined
      ? join(opening.stateRoot, 'runs', opening.run.binding.runId, 'artifacts')
      : join(
          opening.stateRoot,
          'runs',
          opening.run.binding.runId,
          'incarnations',
          opening.run.lease.kind === 'Held' ? opening.run.lease.incarnationId : 'invalid',
          'artifacts',
        );
  const artifacts = database
    .prepare('SELECT artifact_said, encoded_artifact, byte_length FROM evidence_artifacts')
    .iterate();
  for (const row of artifacts) {
    if (!Value.Check(artifactRowSchema, row)) {
      return false;
    }
    const path = join(artifactDirectory, row.artifact_said);
    if (pathKind(path) !== 'RegularFile' || (lstatSync(path).mode & 0o777) !== 0o600) {
      return false;
    }
    const bytes = readFileSync(path);
    let decoded;
    try {
      const envelope: unknown = JSON.parse(row.encoded_artifact);
      decoded = decodeEvidenceArtifact(envelope, bytes);
    } catch {
      return false;
    }
    if (
      decoded.kind !== 'Accepted' ||
      decoded.artifact.d !== row.artifact_said ||
      row.byte_length !== bytes.byteLength
    ) {
      return false;
    }
    artifactBytes += bytes.byteLength;
  }
  if (current.artifact_bytes !== artifactBytes) {
    return false;
  }
  const checkpoints = database
    .prepare(
      `SELECT checkpoint_said, encoded_checkpoint, encoded_condition_ids, byte_length
       FROM verified_checkpoints`,
    )
    .iterate();
  for (const row of checkpoints) {
    if (!Value.Check(checkpointRowSchema, row)) {
      return false;
    }
    try {
      const checkpoint: unknown = JSON.parse(row.encoded_checkpoint);
      const conditionIds: unknown = JSON.parse(row.encoded_condition_ids);
      if (
        !Value.Check(completionConditionIdsSchema, conditionIds) ||
        new TextEncoder().encode(row.encoded_checkpoint).byteLength !== row.byte_length ||
        decodeVerifiedCheckpoint(checkpoint, conditionIds).kind !== 'Accepted'
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  const sealRow: unknown = database
    .prepare(
      `SELECT encoded_projection, seal_exchange_said, sealed_at
       FROM evidence_seal_acknowledgement
       WHERE singleton = 1`,
    )
    .get();
  if (sealRow !== undefined) {
    if (!Value.Check(sealAcknowledgementRowSchema, sealRow)) {
      return false;
    }
    const projection = decodeSealAcknowledgementRow(sealRow);
    if (projection === undefined || !sealedProjectionMatchesState(database, current, projection)) {
      return false;
    }
  }
  return true;
}

function decodeAcknowledgementRow(
  row: Type.Static<typeof acknowledgementRowSchema>,
): EvidenceBatchAcknowledgement | undefined {
  try {
    const decoded: unknown = JSON.parse(row.encoded_acknowledgement);
    return Value.Check(evidenceBatchAcknowledgementSchema, decoded) &&
      decoded.batchSaid === row.batch_said &&
      decoded.acceptedThroughSequence === row.ending_sequence
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function acknowledgementsMatch(
  left: EvidenceBatchAcknowledgement,
  right: EvidenceBatchAcknowledgement,
): boolean {
  return (
    left.disposition.kind === right.disposition.kind &&
    left.runId === right.runId &&
    left.evidenceStreamId === right.evidenceStreamId &&
    left.batchSaid === right.batchSaid &&
    left.acceptedThroughSequence === right.acceptedThroughSequence &&
    left.chainHeadSaid === right.chainHeadSaid &&
    left.receivedAt === right.receivedAt
  );
}

function writeDurableArtifact(directory: string, destination: string, bytes: Uint8Array): void {
  const temporary = join(directory, `.artifact-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (cause) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created or was already renamed.
    }
    throw cause;
  }
}

class SqliteEvidenceRecorder implements PreparedCompatibilityEvidence {
  readonly run;
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #artifactDirectory: string;
  readonly #credentials: ProtectedCredentials;
  readonly #now: () => string;
  readonly #storageByteCeiling: number;
  readonly #executionByteCeiling: number;
  readonly #terminalCalibrationOnly: boolean;

  constructor(
    opening: EvidenceRecorderOpening,
    database: DatabaseSync,
    path: string,
    artifactDirectory: string,
    credentials: ProtectedCredentials,
    now: () => string,
    terminalCalibrationOnly = false,
  ) {
    this.run = opening.run;
    this.#storageByteCeiling = Math.min(
      outboxHardBound,
      opening.run.binding.budget.evidencePlusArtifactsPerRunBytes,
    );
    this.#executionByteCeiling = Math.floor(
      this.#storageByteCeiling * (outboxSoftBound / outboxHardBound),
    );
    this.#database = database;
    this.#path = path;
    this.#artifactDirectory = artifactDirectory;
    this.#credentials = credentials;
    this.#now = now;
    this.#terminalCalibrationOnly = terminalCalibrationOnly;
  }

  readiness(): EvidenceReadinessInspection {
    try {
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        return { kind: 'LocalStateCorruption' };
      }
      if (current.next_sequence === 0) {
        return {
          kind: 'Ready',
          readiness: { kind: 'Genesis', streamId: current.stream_id },
        };
      }
      if (current.chain_head === null) {
        return { kind: 'LocalStateCorruption' };
      }
      return {
        kind: 'Ready',
        readiness: {
          kind: 'Continued',
          streamId: current.stream_id,
          nextSequence: current.next_sequence,
          previousEventSaid: current.chain_head,
        },
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  record(observation: EvidenceObservation): EvidenceRecording {
    if (
      (observation.event.kind === 'DataWithheld' &&
        observation.event.disposition.kind === 'WithheldSecret') ||
      (observation.event.kind === 'SecurityViolation' &&
        observation.event.violation === 'SecretDetected')
    )
      return { kind: 'ObservationRejected' };
    const disclosure = this.#credentials.inspect(
      new TextEncoder().encode(JSON.stringify(observation)),
    );
    if (disclosure.kind === 'WithheldSecret') {
      const withheld = this.withhold({
        occurredAt: this.#now(),
        producer: { kind: 'EvidenceRecorder' },
        disclosure,
      });
      return withheld.kind === 'SecretDetected' ? { kind: 'SecretDetected' } : withheld;
    }
    return this.#appendAtomically([observation]);
  }

  recordBudgetDebit(
    input: Parameters<EvidenceRecorder['recordBudgetDebit']>[0],
  ): EvidenceRecording {
    if (
      input.debits.length === 0 ||
      input.debits.length > taskBudgetNames.length ||
      new Set(input.debits.map(({ budget }) => budget)).size !== input.debits.length ||
      input.debits.some((debit) => debit.amount <= 0 || debit.consumed < debit.amount)
    )
      return { kind: 'ObservationRejected' };
    const disclosure = this.#credentials.inspect(new TextEncoder().encode(JSON.stringify(input)));
    if (disclosure.kind === 'WithheldSecret') {
      const withheld = this.withhold({
        occurredAt: this.#now(),
        producer: { kind: 'EvidenceRecorder' },
        disclosure,
      });
      return withheld.kind === 'SecretDetected' ? { kind: 'SecretDetected' } : withheld;
    }
    const [first, ...following] = input.debits.map((event) => ({
      occurredAt: input.occurredAt,
      producer: input.producer,
      event,
    }));
    if (first === undefined) return { kind: 'ObservationRejected' };
    return this.#appendAtomically([first, ...following]);
  }

  withhold(
    observation: Parameters<EvidenceRecorder['withhold']>[0],
  ): ReturnType<EvidenceRecorder['withhold']> {
    const recorded = this.#appendAtomically([
      {
        occurredAt: observation.occurredAt,
        producer: observation.producer,
        event: { kind: 'DataWithheld', disposition: observation.disclosure },
      },
      {
        occurredAt: observation.occurredAt,
        producer: observation.producer,
        event: { kind: 'SecurityViolation', violation: 'SecretDetected' },
      },
    ]);
    if (recorded.kind !== 'Recorded')
      return recorded.kind === 'SecretDetected' ? { kind: 'LocalStateCorruption' } : recorded;
    if (recorded.event.predecessor.kind !== 'Previous') return { kind: 'LocalStateCorruption' };
    return {
      kind: 'SecretDetected',
      dataWithheldEventSaid: recorded.event.predecessor.eventSaid,
      securityViolationEventSaid: recorded.event.d,
    };
  }

  #appendAtomically(
    observations: readonly [EvidenceObservation, ...EvidenceObservation[]],
  ): EvidenceRecording {
    if (
      this.#terminalCalibrationOnly &&
      observations.some((entry) => !terminalCalibrationObservation(entry))
    )
      return { kind: 'ObservationRejected' };
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const [first, ...following] = observations;
      let recorded = this.#appendEvent(first, statSync(this.#path).size);
      if (recorded.kind !== 'Recorded') {
        this.#database.exec('ROLLBACK');
        return recorded;
      }
      let pendingBytes = new TextEncoder().encode(JSON.stringify(recorded.event)).byteLength;
      for (const observation of following) {
        recorded = this.#appendEvent(observation, statSync(this.#path).size + pendingBytes);
        if (recorded.kind !== 'Recorded') {
          this.#database.exec('ROLLBACK');
          return recorded;
        }
        pendingBytes += new TextEncoder().encode(JSON.stringify(recorded.event)).byteLength;
      }
      this.#database.exec('COMMIT');
      return recorded;
    } catch {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      return { kind: 'Unavailable' };
    }
  }

  #appendEvent(observation: EvidenceObservation, allocatedBytesFloor: number): EvidenceRecording {
    const current = state(this.#database);
    if (current === undefined || !stateMatches(this.run, current)) {
      return { kind: 'LocalStateCorruption' };
    }
    const sealed = this.#database
      .prepare('SELECT singleton FROM evidence_seal_acknowledgement WHERE singleton = 1')
      .get();
    if (sealed !== undefined) {
      return { kind: 'ObservationRejected' };
    }
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence: current.next_sequence,
      predecessor:
        current.chain_head === null
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: current.chain_head },
      taskId: this.run.binding.taskId,
      taskRevisionSaid: this.run.binding.taskRevisionSaid,
      runId: this.run.binding.runId,
      incarnationId: current.incarnation_id,
      harnessRevisionSaid:
        this.run.currentExecution?.harnessRevisionSaid ??
        this.run.binding.initialHarnessRevisionSaid,
      personalAgentAid: this.run.binding.personalAgentAid,
      taskMandateSaid: this.run.binding.taskMandateSaid,
      occurredAt: observation.occurredAt,
      recordedAt: this.#now(),
      producer: observation.producer,
      event: observation.event,
    });
    if (prepared.kind !== 'Prepared') {
      return { kind: 'ObservationRejected' };
    }
    const artifactSaids = evidenceArtifactReferences(prepared.event.event);
    for (const artifactSaid of artifactSaids) {
      const artifact = this.artifact(artifactSaid);
      if (artifact.kind === 'ArtifactNotFound') {
        return { kind: 'ObservationRejected' };
      }
      if (artifact.kind === 'LocalStateCorruption') {
        return artifact;
      }
      if (artifact.kind === 'Unavailable') {
        return artifact;
      }
    }
    if (
      (prepared.event.event.kind === 'CheckpointVerified' ||
        prepared.event.event.kind === 'CheckpointAccepted') &&
      this.#checkpointRow(prepared.event.event.checkpointSaid) === undefined
    ) {
      return { kind: 'ObservationRejected' };
    }
    const encoded = JSON.stringify(prepared.event);
    const byteLength = new TextEncoder().encode(encoded).byteLength;
    const projectedUsage =
      Math.max(current.encoded_bytes, allocatedBytesFloor) + current.artifact_bytes + byteLength;
    if (projectedUsage > this.#storageByteCeiling) {
      return { kind: 'OutboxBoundReached' };
    }
    if (
      projectedUsage > this.#executionByteCeiling &&
      evidenceStoragePurpose(observation.event) === 'Execution'
    ) {
      return { kind: 'OutboxBackpressure' };
    }
    this.#database
      .prepare(
        `INSERT INTO evidence_events (sequence, event_said, encoded_event, byte_length)
         VALUES (?, ?, ?, ?)`,
      )
      .run(current.next_sequence, prepared.event.d, encoded, byteLength);
    const insertReference = this.#database.prepare(
      `INSERT INTO evidence_artifact_references (sequence, artifact_said)
       VALUES (?, ?)`,
    );
    for (const artifactSaid of artifactSaids) {
      insertReference.run(current.next_sequence, artifactSaid);
    }
    this.#database
      .prepare(
        `UPDATE stream_state
         SET next_sequence = ?, chain_head = ?, encoded_bytes = ?
         WHERE singleton = 1 AND next_sequence = ? AND chain_head IS ?`,
      )
      .run(
        current.next_sequence + 1,
        prepared.event.d,
        current.encoded_bytes + byteLength,
        current.next_sequence,
        current.chain_head,
      );
    const changes: unknown = this.#database.prepare('SELECT changes() AS changed').get();
    if (!Value.Check(changesRowSchema, changes) || changes.changed !== 1) {
      return { kind: 'LocalStateCorruption' };
    }
    return { kind: 'Recorded', event: prepared.event };
  }

  page(): EvidencePaging {
    try {
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        return { kind: 'LocalStateCorruption' };
      }
      const pending: unknown = this.#database
        .prepare(
          'SELECT batch_said, ending_sequence FROM pending_evidence_batch WHERE singleton = 1',
        )
        .get();
      if (
        pending !== undefined &&
        (!Value.Check(pendingBatchRowSchema, pending) ||
          pending.ending_sequence < current.next_delivery_sequence ||
          pending.ending_sequence >= current.next_sequence)
      )
        return { kind: 'LocalStateCorruption' };
      if (current.next_delivery_sequence === current.next_sequence) {
        return { kind: 'Empty' };
      }
      const events: EvidenceEvent[] = [];
      let encodedBytes = 0;
      const rows = this.#database
        .prepare(
          `SELECT sequence, event_said, encoded_event, byte_length
           FROM evidence_events
           WHERE sequence >= ? AND sequence <= ?
           ORDER BY sequence
           LIMIT ?`,
        )
        .iterate(
          current.next_delivery_sequence,
          pending === undefined ? current.next_sequence - 1 : pending.ending_sequence,
          transportEventLimit,
        );
      for (const row of rows) {
        if (!Value.Check(eventRowSchema, row)) {
          return { kind: 'LocalStateCorruption' };
        }
        if (encodedBytes + row.byte_length > transportByteLimit) {
          break;
        }
        const parsed: unknown = JSON.parse(row.encoded_event);
        const decoded = decodeEvidenceEvent(parsed);
        if (
          decoded.kind !== 'Accepted' ||
          decoded.event.sequence !== row.sequence ||
          decoded.event.d !== row.event_said
        ) {
          return { kind: 'LocalStateCorruption' };
        }
        events.push(decoded.event);
        encodedBytes += row.byte_length;
      }
      if (events.length === 0) {
        return { kind: 'LocalStateCorruption' };
      }
      const prepared = prepareEvidenceBatch({
        version: 1,
        runId: this.run.binding.runId,
        evidenceStreamId:
          this.run.currentExecution?.evidenceStreamId ?? this.run.binding.evidenceStreamId,
        events,
      });
      if (prepared.kind !== 'Prepared') return { kind: 'LocalStateCorruption' };
      if (pending === undefined) {
        this.#database
          .prepare(
            'INSERT INTO pending_evidence_batch (singleton, batch_said, ending_sequence) VALUES (1, ?, ?)',
          )
          .run(prepared.batch.d, prepared.batch.endingSequence);
      } else if (
        prepared.batch.d !== pending.batch_said ||
        prepared.batch.endingSequence !== pending.ending_sequence
      ) {
        return { kind: 'LocalStateCorruption' };
      }
      return { kind: 'Page', page: { batch: prepared.batch, events, encodedBytes } };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  acknowledge(acknowledgement: EvidenceBatchAcknowledgement): EvidenceAcknowledgementRecording {
    try {
      if (!Value.Check(evidenceBatchAcknowledgementSchema, acknowledgement)) {
        return { kind: 'AcknowledgementRejected' };
      }
      const existing: unknown = this.#database
        .prepare(
          `SELECT batch_said, encoded_batch, encoded_acknowledgement, ending_sequence
           FROM evidence_acknowledgements
           WHERE batch_said = ?`,
        )
        .get(acknowledgement.batchSaid);
      if (existing !== undefined) {
        if (!Value.Check(acknowledgementRowSchema, existing)) {
          return { kind: 'LocalStateCorruption' };
        }
        const decoded = decodeAcknowledgementRow(existing);
        if (decoded === undefined) {
          return { kind: 'LocalStateCorruption' };
        }
        return acknowledgementsMatch(decoded, acknowledgement)
          ? { kind: 'AlreadyAcknowledged', acknowledgement: decoded }
          : { kind: 'AcknowledgementRejected' };
      }
      const pending = this.page();
      if (pending.kind !== 'Page') {
        return pending.kind === 'Empty'
          ? { kind: 'AcknowledgementRejected' }
          : { kind: pending.kind };
      }
      const decoded = decodeEvidenceBatchAcknowledgement(acknowledgement, pending.page.batch);
      if (decoded.kind !== 'Accepted') {
        return { kind: 'AcknowledgementRejected' };
      }

      this.#database.exec('BEGIN IMMEDIATE');
      const current = state(this.#database);
      if (
        current === undefined ||
        !stateMatches(this.run, current) ||
        current.next_delivery_sequence !== pending.page.batch.startingSequence
      ) {
        this.#database.exec('ROLLBACK');
        return { kind: 'LocalStateCorruption' };
      }
      this.#database
        .prepare(
          `INSERT INTO evidence_acknowledgements (
             batch_said, encoded_batch, encoded_acknowledgement, ending_sequence
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          pending.page.batch.d,
          JSON.stringify(pending.page.batch),
          JSON.stringify(decoded.acknowledgement),
          pending.page.batch.endingSequence,
        );
      this.#database
        .prepare(
          `UPDATE stream_state
           SET next_delivery_sequence = ?, acknowledged_chain_head = ?
           WHERE singleton = 1 AND next_delivery_sequence = ?`,
        )
        .run(
          pending.page.batch.endingSequence + 1,
          decoded.acknowledgement.chainHeadSaid,
          current.next_delivery_sequence,
        );
      const changes: unknown = this.#database.prepare('SELECT changes() AS changed').get();
      if (!Value.Check(changesRowSchema, changes) || changes.changed !== 1) {
        this.#database.exec('ROLLBACK');
        return { kind: 'LocalStateCorruption' };
      }
      this.#database.exec('DELETE FROM pending_evidence_batch WHERE singleton = 1');
      this.#database.exec('COMMIT');
      return { kind: 'Acknowledged', acknowledgement: decoded.acknowledgement };
    } catch {
      if (this.#database.isTransaction) {
        this.#database.exec('ROLLBACK');
      }
      return { kind: 'Unavailable' };
    }
  }

  storeArtifact(input: EvidenceArtifactInput): EvidenceArtifactRecording {
    const disclosure = this.#credentials.inspect(input.bytes);
    if (disclosure.kind === 'WithheldSecret') {
      const withheld = this.withhold({
        occurredAt: this.#now(),
        producer: { kind: 'EvidenceRecorder' },
        disclosure,
      });
      switch (withheld.kind) {
        case 'SecretDetected':
          return { kind: 'SecretDetected' };
        case 'OutboxBackpressure':
        case 'OutboxBoundReached':
        case 'LocalStateCorruption':
        case 'Unavailable':
          return withheld;
        case 'ObservationRejected':
          return { kind: 'ArtifactRejected' };
      }
    }
    const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
    if (prepared.kind !== 'Prepared') {
      return { kind: 'ArtifactRejected' };
    }
    const artifact = prepared.artifact;
    const destination = join(this.#artifactDirectory, artifact.d);
    try {
      const existing: unknown = this.#database
        .prepare(
          `SELECT artifact_said, encoded_artifact, byte_length
           FROM evidence_artifacts
           WHERE artifact_said = ?`,
        )
        .get(artifact.d);
      if (existing !== undefined) {
        if (!Value.Check(artifactRowSchema, existing)) {
          return { kind: 'LocalStateCorruption' };
        }
        const reading = this.artifact(artifact.d);
        return reading.kind === 'Read' &&
          reading.artifact.contentDigest === artifact.contentDigest &&
          reading.artifact.mediaType === artifact.mediaType
          ? { kind: 'AlreadyStored', artifact: reading.artifact }
          : { kind: 'LocalStateCorruption' };
      }
      if (pathKind(destination) !== 'Missing') {
        return { kind: 'LocalStateCorruption' };
      }
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        return { kind: 'LocalStateCorruption' };
      }
      const projectedUsage =
        Math.max(current.encoded_bytes, statSync(this.#path).size) +
        current.artifact_bytes +
        artifact.byteLength;
      if (projectedUsage > this.#storageByteCeiling) {
        return { kind: 'OutboxBoundReached' };
      }
      if (projectedUsage > this.#executionByteCeiling) {
        return { kind: 'OutboxBackpressure' };
      }
      writeDurableArtifact(this.#artifactDirectory, destination, input.bytes);
      this.#database.exec('BEGIN IMMEDIATE');
      this.#database
        .prepare(
          `INSERT INTO evidence_artifacts (artifact_said, encoded_artifact, byte_length)
           VALUES (?, ?, ?)`,
        )
        .run(artifact.d, JSON.stringify(artifact), artifact.byteLength);
      this.#database
        .prepare(
          `UPDATE stream_state
           SET artifact_bytes = ?
           WHERE singleton = 1 AND artifact_bytes = ?`,
        )
        .run(current.artifact_bytes + artifact.byteLength, current.artifact_bytes);
      const changes: unknown = this.#database.prepare('SELECT changes() AS changed').get();
      if (!Value.Check(changesRowSchema, changes) || changes.changed !== 1) {
        this.#database.exec('ROLLBACK');
        return { kind: 'LocalStateCorruption' };
      }
      this.#database.exec('COMMIT');
      return { kind: 'Stored', artifact };
    } catch {
      if (this.#database.isTransaction) {
        this.#database.exec('ROLLBACK');
      }
      return { kind: 'Unavailable' };
    }
  }

  artifact(artifactSaid: string): EvidenceArtifactReading {
    if (!Value.Check(saidSchema, artifactSaid)) {
      return { kind: 'ArtifactNotFound' };
    }
    try {
      const row: unknown = this.#database
        .prepare(
          `SELECT artifact_said, encoded_artifact, byte_length
           FROM evidence_artifacts
           WHERE artifact_said = ?`,
        )
        .get(artifactSaid);
      const path = join(this.#artifactDirectory, artifactSaid);
      if (row === undefined) {
        return pathKind(path) === 'Missing'
          ? { kind: 'ArtifactNotFound' }
          : { kind: 'LocalStateCorruption' };
      }
      if (
        !Value.Check(artifactRowSchema, row) ||
        pathKind(path) !== 'RegularFile' ||
        (lstatSync(path).mode & 0o777) !== 0o600
      ) {
        return { kind: 'LocalStateCorruption' };
      }
      const bytes = new Uint8Array(readFileSync(path));
      const encoded: unknown = JSON.parse(row.encoded_artifact);
      const decoded = decodeEvidenceArtifact(encoded, bytes);
      return decoded.kind === 'Accepted' && decoded.artifact.d === artifactSaid
        ? { kind: 'Read', artifact: decoded.artifact, bytes }
        : { kind: 'LocalStateCorruption' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  storeCheckpoint(input: EvidenceCheckpointInput): EvidenceCheckpointRecording {
    const outcome = input.checkpoint.runState;
    if (
      this.#terminalCalibrationOnly &&
      (outcome.kind !== 'Ended' ||
        outcome.outcome.kind !== 'CalibrationExcluded' ||
        outcome.outcome.reason !== 'BudgetExhausted')
    )
      return { kind: 'CheckpointRejected' };
    if (
      !Value.Check(completionConditionIdsSchema, input.completionConditionIds) ||
      decodeVerifiedCheckpoint(input.checkpoint, input.completionConditionIds).kind !== 'Accepted'
    ) {
      return { kind: 'CheckpointRejected' };
    }
    try {
      const existing = this.#checkpointRow(input.checkpoint.d);
      if (existing !== undefined) {
        const reading = this.checkpoint(input.checkpoint.d);
        return reading.kind === 'Read' &&
          JSON.stringify(reading.checkpoint) === JSON.stringify(input.checkpoint)
          ? { kind: 'AlreadyStored', checkpoint: reading.checkpoint }
          : { kind: 'LocalStateCorruption' };
      }
      const encodedCheckpoint = JSON.stringify(input.checkpoint);
      const byteLength = new TextEncoder().encode(encodedCheckpoint).byteLength;
      if (byteLength > 256 * 1_024) {
        return { kind: 'CheckpointRejected' };
      }
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        return { kind: 'LocalStateCorruption' };
      }
      const projectedUsage =
        Math.max(current.encoded_bytes, statSync(this.#path).size) +
        current.artifact_bytes +
        byteLength;
      if (projectedUsage > this.#storageByteCeiling) {
        return { kind: 'OutboxBoundReached' };
      }
      this.#database
        .prepare(
          `INSERT INTO verified_checkpoints (
             checkpoint_said, encoded_checkpoint, encoded_condition_ids, byte_length
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          input.checkpoint.d,
          encodedCheckpoint,
          JSON.stringify(input.completionConditionIds),
          byteLength,
        );
      return { kind: 'Stored', checkpoint: input.checkpoint };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  checkpoint(checkpointSaid: string): EvidenceCheckpointReading {
    if (!Value.Check(saidSchema, checkpointSaid)) {
      return { kind: 'CheckpointNotFound' };
    }
    try {
      const row = this.#checkpointRow(checkpointSaid);
      if (row === undefined) {
        return { kind: 'CheckpointNotFound' };
      }
      const storedConditionIds: unknown = JSON.parse(row.encoded_condition_ids);
      const checkpoint: unknown = JSON.parse(row.encoded_checkpoint);
      if (!Value.Check(completionConditionIdsSchema, storedConditionIds)) {
        return { kind: 'LocalStateCorruption' };
      }
      const decoded = decodeVerifiedCheckpoint(checkpoint, storedConditionIds);
      return decoded.kind === 'Accepted' && decoded.checkpoint.d === checkpointSaid
        ? { kind: 'Read', checkpoint: decoded.checkpoint }
        : { kind: 'LocalStateCorruption' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  recordCheckpointAcceptance(checkpointSaid: string): EvidenceCheckpointAcceptanceRecording {
    try {
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current))
        return { kind: 'LocalStateCorruption' };
      const checkpoint = this.checkpoint(checkpointSaid);
      if (checkpoint.kind === 'Unavailable' || checkpoint.kind === 'LocalStateCorruption')
        return checkpoint;
      if (checkpoint.kind !== 'Read') return { kind: 'ObservationRejected' };
      let verified: EvidenceEvent | undefined;
      let accepted: EvidenceEvent | undefined;
      const rows = this.#database
        .prepare(
          `
        SELECT sequence, event_said, encoded_event, byte_length FROM evidence_events
        WHERE json_extract(encoded_event, '$.event.checkpointSaid') = ?
          AND json_extract(encoded_event, '$.event.kind') IN ('CheckpointVerified', 'CheckpointAccepted')
        ORDER BY sequence
      `,
        )
        .iterate(checkpointSaid);
      for (const row of rows) {
        if (!Value.Check(eventRowSchema, row)) return { kind: 'LocalStateCorruption' };
        const parsed: unknown = JSON.parse(row.encoded_event);
        const decoded = decodeEvidenceEvent(parsed);
        if (
          decoded.kind !== 'Accepted' ||
          decoded.event.sequence !== row.sequence ||
          decoded.event.d !== row.event_said ||
          row.sequence >= current.next_sequence ||
          decoded.event.runId !== this.run.binding.runId ||
          decoded.event.incarnationId !== current.incarnation_id ||
          decoded.event.taskRevisionSaid !== this.run.binding.taskRevisionSaid ||
          decoded.event.harnessRevisionSaid !==
            (this.run.currentExecution?.harnessRevisionSaid ??
              this.run.binding.initialHarnessRevisionSaid) ||
          decoded.event.taskId !== this.run.binding.taskId ||
          decoded.event.personalAgentAid !== this.run.binding.personalAgentAid ||
          decoded.event.taskMandateSaid !== this.run.binding.taskMandateSaid ||
          decoded.event.producer.kind !== 'EvidenceRecorder' ||
          new TextEncoder().encode(row.encoded_event).byteLength !== row.byte_length
        )
          return { kind: 'LocalStateCorruption' };
        if (decoded.event.event.kind === 'CheckpointVerified') {
          if (verified !== undefined || accepted !== undefined)
            return { kind: 'LocalStateCorruption' };
          verified = decoded.event;
        } else {
          if (verified === undefined || accepted !== undefined)
            return { kind: 'LocalStateCorruption' };
          accepted = decoded.event;
        }
      }
      if (verified === undefined || verified.sequence >= current.next_delivery_sequence)
        return { kind: 'ObservationRejected' };
      if (accepted !== undefined) return { kind: 'AlreadyRecorded', event: accepted };
      return this.record({
        occurredAt: this.#now(),
        producer: { kind: 'EvidenceRecorder' },
        event: { kind: 'CheckpointAccepted', checkpointSaid },
      });
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  recordSealAcknowledgement(
    projection: EvidenceStreamProjection,
  ): EvidenceSealAcknowledgementRecording {
    const decoded = decodeEvidenceStreamProjection(projection);
    if (decoded.kind !== 'Accepted' || decoded.projection.seal.kind !== 'Sealed') {
      return { kind: 'AcknowledgementRejected' };
    }
    const encodedProjection = JSON.stringify(decoded.projection);
    if (new TextEncoder().encode(encodedProjection).byteLength > 16 * 1_024) {
      return { kind: 'AcknowledgementRejected' };
    }
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        this.#database.exec('ROLLBACK');
        return { kind: 'LocalStateCorruption' };
      }
      if (!sealedProjectionMatchesState(this.#database, current, decoded.projection)) {
        this.#database.exec('ROLLBACK');
        return { kind: 'AcknowledgementRejected' };
      }
      const existing: unknown = this.#database
        .prepare(
          `SELECT encoded_projection, seal_exchange_said, sealed_at
           FROM evidence_seal_acknowledgement
           WHERE singleton = 1`,
        )
        .get();
      if (existing !== undefined) {
        this.#database.exec('ROLLBACK');
        if (!Value.Check(sealAcknowledgementRowSchema, existing)) {
          return { kind: 'LocalStateCorruption' };
        }
        const stored = decodeSealAcknowledgementRow(existing);
        if (stored === undefined) {
          return { kind: 'LocalStateCorruption' };
        }
        return sealedProjectionsMatch(stored, decoded.projection)
          ? { kind: 'AlreadyRecorded', projection: stored }
          : { kind: 'AcknowledgementRejected' };
      }
      this.#database
        .prepare(
          `INSERT INTO evidence_seal_acknowledgement (
             singleton, encoded_projection, seal_exchange_said, sealed_at
           ) VALUES (1, ?, ?, ?)`,
        )
        .run(
          encodedProjection,
          decoded.projection.seal.sealExchangeSaid,
          decoded.projection.seal.sealedAt,
        );
      this.#database.exec('COMMIT');
      return { kind: 'Recorded', projection: decoded.projection };
    } catch {
      if (this.#database.isTransaction) {
        this.#database.exec('ROLLBACK');
      }
      return { kind: 'Unavailable' };
    }
  }

  sealAcknowledgement(): EvidenceSealAcknowledgementReading {
    try {
      const current = state(this.#database);
      if (current === undefined || !stateMatches(this.run, current)) {
        return { kind: 'LocalStateCorruption' };
      }
      const row: unknown = this.#database
        .prepare(
          `SELECT encoded_projection, seal_exchange_said, sealed_at
           FROM evidence_seal_acknowledgement
           WHERE singleton = 1`,
        )
        .get();
      if (row === undefined) {
        return { kind: 'NotFound' };
      }
      if (!Value.Check(sealAcknowledgementRowSchema, row)) {
        return { kind: 'LocalStateCorruption' };
      }
      const projection = decodeSealAcknowledgementRow(row);
      return projection !== undefined &&
        sealedProjectionMatchesState(this.#database, current, projection)
        ? { kind: 'Read', projection }
        : { kind: 'LocalStateCorruption' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  read(run: Run) {
    return readPreparedCompatibilityProviderProof(this.#database, run);
  }

  #checkpointRow(checkpointSaid: string): Type.Static<typeof checkpointRowSchema> | undefined {
    const row: unknown = this.#database
      .prepare(
        `SELECT checkpoint_said, encoded_checkpoint, encoded_condition_ids, byte_length
         FROM verified_checkpoints
         WHERE checkpoint_said = ?`,
      )
      .get(checkpointSaid);
    return Value.Check(checkpointRowSchema, row) ? row : undefined;
  }

  close(): void {
    this.#database.close();
  }
}

export class SqliteEvidenceOutboxes implements EvidenceRecorders<PreparedCompatibilityEvidence> {
  readonly #now: () => string;

  readonly #credentials: ProtectedCredentials;

  constructor(now: () => string, credentials = new ProtectedCredentials()) {
    this.#now = now;
    this.#credentials = credentials;
  }

  readPredecessor(
    input: Parameters<RunPredecessorReading['readPredecessor']>[0],
  ): ReturnType<RunPredecessorReading['readPredecessor']> {
    const { run, stream } = input;
    if (
      run.lifecycle.kind !== 'Active' ||
      run.lifecycle.phase.kind !== 'Blocked' ||
      run.lease.kind !== 'Held' ||
      stream.seal.kind !== 'Sealed' ||
      stream.cursor.kind !== 'Accepted' ||
      stream.checkpoint.kind !== 'Accepted' ||
      stream.checkpoint.checkpointSaid !== run.lifecycle.phase.checkpointSaid ||
      stream.runId !== run.binding.runId ||
      stream.evidenceStreamId !==
        (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId)
    )
      return { kind: 'Rejected' };
    const root = join(input.stateRoot, 'runs', run.binding.runId);
    const directory =
      run.currentExecution === undefined
        ? root
        : join(root, 'incarnations', run.lease.incarnationId);
    const path = join(directory, 'outbox.sqlite');
    let database: DatabaseSync | undefined;
    try {
      if (
        !isOwnerOnlyDirectory(input.stateRoot) ||
        !isOwnerOnlyDirectory(directory) ||
        realpathSync(directory) !==
          (run.currentExecution === undefined
            ? join(realpathSync(input.stateRoot), 'runs', run.binding.runId)
            : join(
                realpathSync(input.stateRoot),
                'runs',
                run.binding.runId,
                'incarnations',
                run.lease.incarnationId,
              )) ||
        pathKind(path) !== 'RegularFile' ||
        (lstatSync(path).mode & 0o777) !== 0o600
      )
        return { kind: 'Rejected' };
      database = new DatabaseSync(path, { readOnly: true });
      if (!existingOutboxIsValid(database, input)) return { kind: 'Rejected' };
      const rows = database
        .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence')
        .all();
      const events: EvidenceEvent[] = [];
      for (const row of rows) {
        if (typeof row.encoded_event !== 'string') return { kind: 'Rejected' };
        const decoded = decodeEvidenceEvent(JSON.parse(row.encoded_event));
        if (decoded.kind !== 'Accepted') return { kind: 'Rejected' };
        events.push(decoded.event);
      }
      if (
        !isDeepStrictEqual(events, input.events) ||
        events.length !== stream.cursor.eventCount ||
        events.at(-1)?.d !== stream.cursor.chainHeadSaid ||
        events.at(-1)?.sequence !== stream.cursor.acceptedThroughSequence
      )
        return { kind: 'Rejected' };
      const recorder = new SqliteEvidenceRecorder(
        input,
        database,
        path,
        join(directory, 'artifacts'),
        this.#credentials,
        this.#now,
      );
      const checkpoint = recorder.checkpoint(stream.checkpoint.checkpointSaid);
      if (
        checkpoint.kind !== 'Read' ||
        !isDeepStrictEqual(checkpoint.checkpoint.budget.consumed, run.consumedBudget)
      )
        return { kind: 'Rejected' };
      const references = new Set(events.flatMap(({ event }) => evidenceArtifactReferences(event)));
      for (const said of checkpoint.checkpoint.outputArtifactSaids) references.add(said);
      if (checkpoint.checkpoint.version === 1)
        for (const file of checkpoint.checkpoint.repository.changedFiles)
          references.add(file.contentSaid);
      for (const receipt of checkpoint.checkpoint.verifierReceipts)
        if (receipt.outcome.kind === 'Accepted' || receipt.outcome.kind === 'Rejected')
          for (const said of receipt.outcome.outputArtifactSaids) references.add(said);
      const artifacts = [];
      for (const said of references) {
        const artifact = recorder.artifact(said);
        if (artifact.kind !== 'Read') return { kind: 'Rejected' };
        artifacts.push({ artifact: artifact.artifact, bytes: artifact.bytes });
      }
      return {
        kind: 'Read',
        custody: { checkpoint: checkpoint.checkpoint, events, artifacts, stream },
      };
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      database?.close();
    }
  }

  /** Reopens custody for terminal accounting only, never a Pi execution session. */
  reconcileCalibration(
    opening: EvidenceRecorderOpening,
    hostedPrefix: readonly EvidenceEvent[],
  ):
    | Exclude<
        EvidenceRecorderAcquisition<PreparedCompatibilityEvidence>,
        { readonly kind: 'Opened' }
      >
    | {
        readonly kind: 'Opened';
        readonly recorder: PreparedCompatibilityEvidence;
        readonly events: readonly EvidenceEvent[];
      } {
    const { run, stateRoot } = opening;
    if (
      !isAbsolute(stateRoot) ||
      run.lease.kind !== 'Held' ||
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      run.lifecycle.kind !== 'Active' ||
      !['Preparing', 'Running'].includes(run.lifecycle.phase.kind) ||
      !Number.isFinite(Date.parse(this.#now())) ||
      Date.parse(this.#now()) < Date.parse(run.lease.expiresAt) ||
      hostedPrefix.length === 0
    )
      return { kind: 'LocalStateCorruption' };
    const runDirectory = join(stateRoot, 'runs', run.binding.runId);
    const artifactDirectory = join(runDirectory, 'artifacts');
    const path = join(runDirectory, 'outbox.sqlite');
    let database: DatabaseSync | undefined;
    try {
      if (
        ![stateRoot, join(stateRoot, 'runs'), runDirectory, artifactDirectory].every(
          isOwnerOnlyDirectory,
        ) ||
        realpathSync(runDirectory) !== join(realpathSync(stateRoot), 'runs', run.binding.runId) ||
        pathKind(path) !== 'RegularFile' ||
        (lstatSync(path).mode & 0o777) !== 0o600
      )
        return { kind: 'LocalStateCorruption' };
      database = new DatabaseSync(path);
      configure(database);
      if (!existingOutboxIsValid(database, opening)) return { kind: 'LocalStateCorruption' };
      const rows = database
        .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence')
        .all();
      if (hostedPrefix.length > rows.length) return { kind: 'LocalStateCorruption' };
      let previous: string | undefined;
      let started = false;
      const events: EvidenceEvent[] = [];
      for (let index = 0; index < rows.length; index += 1) {
        const encoded = rows[index]?.encoded_event;
        if (typeof encoded !== 'string') return { kind: 'LocalStateCorruption' };
        const decoded = decodeEvidenceEvent(JSON.parse(encoded));
        if (decoded.kind !== 'Accepted') return { kind: 'LocalStateCorruption' };
        const event = decoded.event;
        if (
          event.sequence !== index ||
          event.runId !== run.binding.runId ||
          event.taskId !== run.binding.taskId ||
          event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
          event.incarnationId !== run.lease.incarnationId ||
          event.harnessRevisionSaid !==
            (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) ||
          event.personalAgentAid !== run.binding.personalAgentAid ||
          event.taskMandateSaid !== run.binding.taskMandateSaid ||
          (previous === undefined
            ? event.predecessor.kind !== 'Genesis'
            : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== previous) ||
          Date.parse(event.recordedAt) < Date.parse(run.lease.acquiredAt) ||
          (Date.parse(event.recordedAt) >= Date.parse(run.lease.expiresAt) &&
            !terminalCalibrationObservation(event)) ||
          (index < hostedPrefix.length && !isDeepStrictEqual(event, hostedPrefix[index]))
        )
          return { kind: 'LocalStateCorruption' };
        if (
          event.event.kind === 'RunStarted' &&
          event.producer.kind === 'RunSupervisor' &&
          index < hostedPrefix.length
        )
          started = true;
        previous = event.d;
        events.push(event);
      }
      if (!started) return { kind: 'LocalStateCorruption' };
      const recorder = new SqliteEvidenceRecorder(
        opening,
        database,
        path,
        artifactDirectory,
        this.#credentials,
        this.#now,
        true,
      );
      database = undefined;
      return { kind: 'Opened', recorder, events };
    } catch {
      return { kind: 'LocalStateCorruption' };
    } finally {
      database?.close();
    }
  }

  open(
    opening: EvidenceRecorderOpening,
  ): EvidenceRecorderAcquisition<PreparedCompatibilityEvidence> {
    if (!isAbsolute(opening.stateRoot) || opening.run.lease.kind !== 'Held') {
      return { kind: 'LocalStateCorruption' };
    }
    const runsDirectory = join(opening.stateRoot, 'runs');
    const runDirectory = join(runsDirectory, opening.run.binding.runId);
    if (
      opening.run.currentExecution !== undefined &&
      (opening.run.binding.purpose.kind !== 'Retained' ||
        opening.run.lease.segmentSaid !== opening.run.currentExecution.segmentSaid)
    )
      return { kind: 'LocalStateCorruption' };
    const executionDirectory =
      opening.run.currentExecution === undefined
        ? runDirectory
        : join(runDirectory, 'incarnations', opening.run.lease.incarnationId);
    const artifactDirectory = join(executionDirectory, 'artifacts');
    const path = join(executionDirectory, 'outbox.sqlite');
    try {
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      if (
        !isOwnerOnlyDirectory(opening.stateRoot) ||
        !isOwnerOnlyDirectory(runsDirectory) ||
        !isOwnerOnlyDirectory(runDirectory) ||
        !isOwnerOnlyDirectory(artifactDirectory) ||
        (opening.run.currentExecution !== undefined &&
          (!isOwnerOnlyDirectory(join(runDirectory, 'incarnations')) ||
            !isOwnerOnlyDirectory(executionDirectory) ||
            realpathSync(executionDirectory) !==
              join(realpathSync(runDirectory), 'incarnations', opening.run.lease.incarnationId))) ||
        realpathSync(runDirectory) !==
          join(realpathSync(opening.stateRoot), 'runs', opening.run.binding.runId)
      ) {
        return { kind: 'LocalStateCorruption' };
      }
      const existing = pathKind(path);
      if (existing === 'Conflict' || existing === 'Directory') {
        return { kind: 'LocalStateCorruption' };
      }
      if (existing === 'RegularFile') {
        if ((lstatSync(path).mode & 0o777) !== 0o600) {
          return { kind: 'LocalStateCorruption' };
        }
        const database = new DatabaseSync(path);
        try {
          configure(database);
          return existingOutboxIsValid(database, opening)
            ? { kind: 'ExistingOutboxRequiresLaterResume' }
            : { kind: 'LocalStateCorruption' };
        } finally {
          database.close();
        }
      }
      const database = new DatabaseSync(path);
      try {
        configure(database);
        createSchema(database);
        database
          .prepare(
            `INSERT INTO stream_state (
              singleton, run_id, stream_id, task_id, task_revision_said, incarnation_id,
              harness_revision_said, personal_agent_aid, task_mandate_said,
              next_sequence, chain_head, next_delivery_sequence,
              acknowledged_chain_head, encoded_bytes, artifact_bytes
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, 0, 0)`,
          )
          .run(
            opening.run.binding.runId,
            opening.run.currentExecution?.evidenceStreamId ?? opening.run.binding.evidenceStreamId,
            opening.run.binding.taskId,
            opening.run.binding.taskRevisionSaid,
            opening.run.lease.incarnationId,
            opening.run.currentExecution?.harnessRevisionSaid ??
              opening.run.binding.initialHarnessRevisionSaid,
            opening.run.binding.personalAgentAid,
            opening.run.binding.taskMandateSaid,
          );
        chmodSync(path, 0o600);
        return {
          kind: 'Opened',
          recorder: new SqliteEvidenceRecorder(
            opening,
            database,
            path,
            artifactDirectory,
            this.#credentials,
            this.#now,
          ),
        };
      } catch {
        database.close();
        return { kind: 'Unavailable' };
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
