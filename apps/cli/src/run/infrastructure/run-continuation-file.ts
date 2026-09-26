import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  runContinuationRequestSchema,
  decodeRunProjection,
  evidenceStreamProjectionSchema,
  decodeEvidenceEvent,
  type RunProjection,
  type EvidenceStreamProjection,
  type EvidenceEvent,
  runContinuationReceiptSchema,
  decodeRunSuccessorSegment,
  type RunContinuationReceipt,
  type RunContinuationRequest,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import type { RunContinuationCommands } from '../application/resume-task.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}
async function read(path: string, maximumBytes = 128 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (
      !status.isFile() ||
      (status.mode & 0o777) !== 0o600 ||
      status.size > maximumBytes ||
      (process.getuid !== undefined && status.uid !== process.getuid())
    )
      throw new Error('Continuation custody rejected');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
async function write(path: string, directory: string, value: object): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

/** Stable replacement-incarnation identity is written before its remote admission. */
export class RunContinuationFile implements RunContinuationCommands {
  readonly #directory: string;
  readonly #newIdentifier: () => string;
  constructor(directory: string, newIdentifier: () => string) {
    this.#directory = directory;
    this.#newIdentifier = newIdentifier;
  }

  async #directoryReady(): Promise<boolean> {
    if (!isAbsolute(this.#directory)) return false;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      (metadata.mode & 0o777) === 0o700 &&
      (await realpath(this.#directory)) === this.#directory
    );
  }

  async retainPredecessor(input: {
    readonly run: RunProjection;
    readonly stream: EvidenceStreamProjection;
    readonly events: readonly EvidenceEvent[];
  }): Promise<'Recorded' | 'Rejected'> {
    try {
      if (
        decodeRunProjection(input.run).kind !== 'Accepted' ||
        !Value.Check(evidenceStreamProjectionSchema, input.stream) ||
        !input.events.every((event) => decodeEvidenceEvent(event).kind === 'Accepted') ||
        !(await this.#directoryReady())
      )
        return 'Rejected';
      const path = join(
        this.#directory,
        `${input.run.runId}-${String(input.run.runVersion)}.predecessor.json`,
      );
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 16 * 1024 * 1024) return 'Rejected';
      try {
        await write(path, this.#directory, input);
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
      }
      return isDeepStrictEqual(await read(path, 16 * 1024 * 1024), input) ? 'Recorded' : 'Rejected';
    } catch {
      return 'Rejected';
    }
  }

  async readPredecessor(
    runId: string,
    runVersion: number,
  ): Promise<
    | {
        readonly run: RunProjection;
        readonly stream: EvidenceStreamProjection;
        readonly events: readonly EvidenceEvent[];
      }
    | undefined
  > {
    try {
      if (
        !uuid.test(runId) ||
        !Number.isSafeInteger(runVersion) ||
        runVersion < 0 ||
        !(await this.#directoryReady())
      )
        return undefined;
      const value = await read(
        join(this.#directory, `${runId}-${String(runVersion)}.predecessor.json`),
        16 * 1024 * 1024,
      );
      if (
        typeof value !== 'object' ||
        value === null ||
        !('run' in value) ||
        !('stream' in value) ||
        !('events' in value) ||
        !Value.Check(evidenceStreamProjectionSchema, value.stream) ||
        !Array.isArray(value.events)
      )
        return undefined;
      const decoded = decodeRunProjection(value.run);
      if (
        decoded.kind !== 'Accepted' ||
        decoded.run.binding.runId !== runId ||
        decoded.run.version !== runVersion
      )
        return undefined;
      const events: EvidenceEvent[] = [];
      for (const event of value.events) {
        const parsed = decodeEvidenceEvent(event);
        if (parsed.kind !== 'Accepted') return undefined;
        events.push(parsed.event);
      }
      return { run: value.run as RunProjection, stream: value.stream, events };
    } catch {
      return undefined;
    }
  }

  async verifyUnstarted(
    runId: string,
    command: RunContinuationRequest,
  ): Promise<'NeverStarted' | 'Uncertain'> {
    try {
      if (
        !uuid.test(runId) ||
        !Value.Check(runContinuationRequestSchema, command) ||
        !(await this.#directoryReady())
      )
        return 'Uncertain';
      const recorded = await read(
        join(this.#directory, `${runId}-${command.predecessorCheckpointSaid}.json`),
      );
      if (!isDeepStrictEqual(recorded, command)) return 'Uncertain';
      const stateRoot = dirname(this.#directory);
      for (const path of [
        stateRoot,
        join(stateRoot, 'runs'),
        join(stateRoot, 'runs', runId),
        join(stateRoot, 'runs', runId, 'incarnations'),
      ]) {
        try {
          const status = await lstat(path);
          if (
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            (await realpath(path)) !== path ||
            (process.getuid !== undefined && status.uid !== process.getuid())
          )
            return 'Uncertain';
        } catch (cause) {
          if (!absent(cause)) return 'Uncertain';
        }
      }
      for (const path of [
        join(this.#directory, `${runId}-${command.predecessorCheckpointSaid}.receipt.json`),
        join(
          dirname(this.#directory),
          'runs',
          runId,
          'incarnations',
          command.successorIncarnationId,
        ),
      ]) {
        try {
          await lstat(path);
          return 'Uncertain';
        } catch (cause) {
          if (!absent(cause)) return 'Uncertain';
        }
      }
      return 'NeverStarted';
    } catch {
      return 'Uncertain';
    }
  }

  async acquire(
    input: Parameters<RunContinuationCommands['acquire']>[0],
  ): ReturnType<RunContinuationCommands['acquire']> {
    try {
      if (
        !uuid.test(input.runId) ||
        !said.test(input.command.predecessorCheckpointSaid) ||
        !(await this.#directoryReady())
      )
        return { kind: 'Rejected' };
      const path = join(
        this.#directory,
        `${input.runId}-${input.command.predecessorCheckpointSaid}.json`,
      );
      let value: unknown;
      try {
        value = await read(path);
      } catch (cause) {
        if (!absent(cause)) throw cause;
        const command = {
          ...input.command,
          successorIncarnationId: this.#newIdentifier(),
          successorStreamId: this.#newIdentifier(),
        };
        if (
          !Value.Check(runContinuationRequestSchema, command) ||
          command.successorIncarnationId === command.successorStreamId
        )
          return { kind: 'Rejected' };
        try {
          await write(path, this.#directory, command);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        value = await read(path);
      }
      if (!Value.Check(runContinuationRequestSchema, value)) return { kind: 'Rejected' };
      const { successorIncarnationId, successorStreamId, ...expected } = value;
      if (
        !isDeepStrictEqual(expected, input.command) ||
        successorIncarnationId === successorStreamId
      )
        return { kind: 'Rejected' };
      return { kind: 'Recorded', command: value };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async recordReceipt(
    runId: string,
    command: RunContinuationRequest,
    receipt: RunContinuationReceipt,
  ): ReturnType<RunContinuationCommands['recordReceipt']> {
    try {
      if (
        !uuid.test(runId) ||
        !Value.Check(runContinuationRequestSchema, command) ||
        !Value.Check(runContinuationReceiptSchema, receipt) ||
        decodeRunSuccessorSegment(receipt.segment).kind !== 'Accepted' ||
        receipt.run.runId !== runId ||
        receipt.segment.successor.incarnationId !== command.successorIncarnationId ||
        receipt.segment.successor.evidenceStreamId !== command.successorStreamId ||
        receipt.segment.predecessor.checkpointSaid !== command.predecessorCheckpointSaid ||
        !(await this.#directoryReady())
      )
        return { kind: 'Rejected' };
      const path = join(
        this.#directory,
        `${runId}-${command.predecessorCheckpointSaid}.receipt.json`,
      );
      try {
        await write(path, this.#directory, receipt);
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
      }
      const stored = await read(path);
      return Value.Check(runContinuationReceiptSchema, stored) &&
        isDeepStrictEqual(stored.run, receipt.run) &&
        isDeepStrictEqual(stored.segment, receipt.segment)
        ? { kind: 'Recorded' }
        : { kind: 'Rejected' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
