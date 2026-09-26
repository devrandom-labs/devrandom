import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { constants, createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { CredentialDisclosure, ProtectedCredentials } from '@devrandom/domain';
import type {
  AcceptedRunBudgetReservation,
  RunBudgetCommitment,
  RunResourceBudget,
} from '@devrandom/runtime';

import type {
  ChildBudgetCommitmentFailure,
  CapturedChildOutput,
  ChildOutputAcknowledgement,
  ExactChildCommand,
  ExactChildCommandOutcome,
  ExactChildCommands,
} from '../application/exact-child-command.js';

export interface SanitizedChildEnvironment {
  readonly path: string;
  readonly temporaryDirectory: string;
  readonly language: 'C' | 'C.UTF-8';
}

export interface PosixExactChildCommandOptions {
  readonly workingDirectory: string;
  readonly outputRoot: string;
  readonly maximumOutputBytes: number;
  readonly environment: SanitizedChildEnvironment;
  readonly budget: RunResourceBudget;
  readonly protectedCredentials: ProtectedCredentials;
  monotonicNow(): number;
}

type CommandInterruption =
  | 'TimedOut'
  | 'OutputLimitExceeded'
  | 'Aborted'
  | 'ProcessGroupSurvived'
  | 'SecretDetected'
  | 'CaptureFailed';

type ChildObservation =
  | {
      readonly kind: 'Closed' | 'CleanupUnconfirmed';
      readonly exitCode: number | null;
      readonly terminationSignal: NodeJS.Signals | null;
    }
  | { readonly kind: 'SpawnFailed' };

type ExactChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type CaptureAdmission =
  | { readonly kind: 'Capturing'; readonly remainingBytes: number }
  | { readonly kind: 'OutputLimitExceeded' }
  | { readonly kind: 'CaptureFailed' }
  | Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }>;
const terminationGraceSeconds = 2;
const forcedExitObservationMilliseconds = 100;

class FileChildOutput implements CapturedChildOutput {
  readonly disclosure: CredentialDisclosure;
  readonly stdout: { readonly path: string; readonly byteLength: number };
  readonly stderr: { readonly path: string; readonly byteLength: number };
  readonly #directory: string;
  #custody: 'Held' | 'Cleaned' = 'Held';

  constructor(input: {
    readonly directory: string;
    readonly disclosure: CredentialDisclosure;
    readonly stdoutPath: string;
    readonly stdoutBytes: number;
    readonly stderrPath: string;
    readonly stderrBytes: number;
  }) {
    this.#directory = input.directory;
    this.disclosure = input.disclosure;
    this.stdout = { path: input.stdoutPath, byteLength: input.stdoutBytes };
    this.stderr = { path: input.stderrPath, byteLength: input.stderrBytes };
  }

  async acknowledge(): Promise<ChildOutputAcknowledgement> {
    if (this.#custody === 'Cleaned') {
      return { kind: 'AlreadyCleaned' };
    }
    try {
      await rm(this.#directory, { recursive: true, force: true });
      this.#custody = 'Cleaned';
      return { kind: 'Cleaned' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}

function environment(input: SanitizedChildEnvironment): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PATH: input.path,
    TMPDIR: input.temporaryDirectory,
    LANG: input.language,
    LC_ALL: input.language,
  };
}

function signalGroup(child: ExactChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // An already-empty process group satisfies termination.
  }
}

function groupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function writeBounded(
  source: NodeJS.ReadableStream,
  destination: WriteStream,
  capture: { admission: CaptureAdmission },
  credentials: ProtectedCredentials,
  onLimit: () => void,
  onSecret: () => void,
  onFailure: () => void,
): () => number {
  let byteLength = 0;
  let pending = Buffer.alloc(0);
  const fail = () => {
    if (capture.admission.kind !== 'Capturing') return;
    capture.admission = { kind: 'CaptureFailed' };
    pending = Buffer.alloc(0);
    source.pause();
    onFailure();
  };
  source.once('error', fail);
  destination.once('error', fail);
  const write = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    byteLength += bytes.byteLength;
    if (!destination.write(bytes)) {
      source.pause();
      destination.once('drain', () => source.resume());
    }
  };
  source.on('data', (chunk: Buffer) => {
    const admission = capture.admission;
    if (admission.kind !== 'Capturing') return;
    if (chunk.byteLength > admission.remainingBytes) {
      capture.admission = { kind: 'OutputLimitExceeded' };
      pending = Buffer.alloc(0);
      onLimit();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const disclosure = credentials.inspectPrefix(pending);
    if (disclosure.kind === 'WithheldSecret') {
      capture.admission = disclosure;
      pending = Buffer.alloc(0);
      onSecret();
      return;
    }
    capture.admission = {
      kind: 'Capturing',
      remainingBytes: admission.remainingBytes - chunk.byteLength,
    };
    write(pending.subarray(0, disclosure.byteLength));
    pending = pending.subarray(disclosure.byteLength);
  });
  source.once('end', () => {
    if (capture.admission.kind !== 'Capturing') {
      pending = Buffer.alloc(0);
      return;
    }
    const disclosure = credentials.inspect(pending);
    if (disclosure.kind === 'WithheldSecret') {
      capture.admission = disclosure;
      onSecret();
    } else {
      write(pending);
    }
    pending = Buffer.alloc(0);
  });
  return () => byteLength;
}

function elapsedMilliseconds(startedAt: number, endedAt: number): number {
  const elapsed = Math.ceil(endedAt - startedAt);
  return Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : 0;
}

function budgetFailure(
  commitment: Exclude<RunBudgetCommitment, { readonly kind: 'Committed' }>,
): ChildBudgetCommitmentFailure {
  switch (commitment.kind) {
    case 'SecretDetected':
      return 'SecretDetected';
    case 'Exhausted':
      return 'BudgetExhausted';
    case 'OutboxBackpressure':
      return 'OutboxBackpressure';
    case 'EvidenceIntegrityFailure':
    case 'ReservationRejected':
      return 'EvidenceIntegrityFailure';
    case 'Unavailable':
      return 'DependencyUnavailable';
  }
}

export class PosixExactChildCommands implements ExactChildCommands {
  readonly #options: PosixExactChildCommandOptions;

  constructor(options: PosixExactChildCommandOptions) {
    this.#options = options;
  }

  async run(command: ExactChildCommand, signal: AbortSignal): Promise<ExactChildCommandOutcome> {
    try {
      signal.throwIfAborted();
    } catch {
      return { kind: 'AbortedBeforeStart' };
    }
    if (
      !isAbsolute(command.executableRealpath) ||
      !Number.isSafeInteger(command.timeoutSeconds) ||
      command.timeoutSeconds < 1 ||
      command.timeoutSeconds > 300 ||
      !Number.isSafeInteger(command.expectedExitCode) ||
      command.expectedExitCode < 0 ||
      command.expectedExitCode > 255
    ) {
      return { kind: 'ExecutableUnavailable' };
    }
    try {
      await access(command.executableRealpath, constants.X_OK);
      if (!(await stat(command.executableRealpath)).isFile()) {
        return { kind: 'ExecutableUnavailable' };
      }
    } catch {
      return { kind: 'ExecutableUnavailable' };
    }
    try {
      signal.throwIfAborted();
    } catch {
      return { kind: 'AbortedBeforeStart' };
    }
    const reservation = this.#options.budget.reserve([
      {
        budget: 'aggregateChildCommandTimeSeconds',
        amount: command.timeoutSeconds + terminationGraceSeconds,
      },
      { budget: 'oneChildCommandTimeSeconds', amount: command.timeoutSeconds },
    ]);
    if (reservation.kind === 'Exhausted') {
      return { kind: 'BudgetExhausted' };
    }
    if (reservation.kind !== 'Reserved') {
      return { kind: 'DependencyUnavailable' };
    }
    let directory: string;
    try {
      await mkdir(this.#options.outputRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.#options.outputRoot, 'command-'));
    } catch {
      this.#options.budget.release(reservation.reservation);
      return { kind: 'DependencyUnavailable' };
    }
    try {
      signal.throwIfAborted();
    } catch {
      this.#options.budget.release(reservation.reservation);
      await rm(directory, { recursive: true, force: true });
      return { kind: 'AbortedBeforeStart' };
    }
    const stdoutPath = join(directory, 'stdout');
    const stderrPath = join(directory, 'stderr');
    const stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
    let child: ExactChildProcess;
    const startedAt = this.#options.monotonicNow();
    try {
      child = spawn(command.executableRealpath, command.arguments, {
        cwd: this.#options.workingDirectory,
        env: environment(this.#options.environment),
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.#options.budget.release(reservation.reservation);
      stdout.end();
      stderr.end();
      await Promise.allSettled([finished(stdout), finished(stderr)]);
      await rm(directory, { recursive: true, force: true });
      return { kind: 'DependencyUnavailable' };
    }

    let interruption: CommandInterruption | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const childObservation = Promise.withResolvers<ChildObservation>();
    const interrupt = (kind: CommandInterruption) => {
      if (interruption !== undefined) return;
      interruption = kind;
      signalGroup(child, 'SIGTERM');
      forceKill = setTimeout(
        () => {
          signalGroup(child, 'SIGKILL');
        },
        terminationGraceSeconds * 1_000 - forcedExitObservationMilliseconds,
      );
      cleanupDeadline = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        childObservation.resolve({
          kind: 'CleanupUnconfirmed',
          exitCode: child.exitCode,
          terminationSignal: child.signalCode,
        });
      }, terminationGraceSeconds * 1_000);
    };
    const exited = () => {
      if (interruption === undefined && child.pid !== undefined && groupExists(child.pid)) {
        interrupt('ProcessGroupSurvived');
      }
    };
    child.once('exit', exited);
    child.once('error', () => {
      childObservation.resolve({ kind: 'SpawnFailed' });
    });
    child.once('close', (exitCode, terminationSignal) => {
      childObservation.resolve({ kind: 'Closed', exitCode, terminationSignal });
    });
    const outputCapture: { admission: CaptureAdmission } = {
      admission: { kind: 'Capturing', remainingBytes: this.#options.maximumOutputBytes },
    };
    const stdoutBytes = writeBounded(
      child.stdout,
      stdout,
      outputCapture,
      this.#options.protectedCredentials,
      () => {
        interrupt('OutputLimitExceeded');
      },
      () => {
        interrupt('SecretDetected');
      },
      () => {
        interrupt('CaptureFailed');
      },
    );
    const stderrBytes = writeBounded(
      child.stderr,
      stderr,
      outputCapture,
      this.#options.protectedCredentials,
      () => {
        interrupt('OutputLimitExceeded');
      },
      () => {
        interrupt('SecretDetected');
      },
      () => {
        interrupt('CaptureFailed');
      },
    );
    const abort = () => {
      interrupt('Aborted');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => {
      interrupt('TimedOut');
    }, command.timeoutSeconds * 1_000);
    const observation = await childObservation.promise;
    const elapsed = elapsedMilliseconds(startedAt, this.#options.monotonicNow());
    clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    if (cleanupDeadline !== undefined) clearTimeout(cleanupDeadline);
    child.removeListener('exit', exited);
    signal.removeEventListener('abort', abort);
    stdout.end();
    stderr.end();
    const streams = await Promise.allSettled([finished(stdout), finished(stderr)]);
    if (
      observation.kind === 'SpawnFailed' ||
      outputCapture.admission.kind === 'CaptureFailed' ||
      streams.some(({ status }) => status === 'rejected')
    ) {
      if (child.pid !== undefined && groupExists(child.pid)) {
        signalGroup(child, 'SIGKILL');
      }
      const commitment = this.#commitElapsed(reservation.reservation, command, elapsed);
      await rm(directory, { recursive: true, force: true });
      if (commitment.kind !== 'Committed') {
        return { kind: 'DependencyUnavailable' };
      }
      return { kind: 'DependencyUnavailable' };
    }
    if (child.pid !== undefined && groupExists(child.pid)) {
      signalGroup(child, 'SIGKILL');
      interruption = 'ProcessGroupSurvived';
    }
    const output = new FileChildOutput({
      directory,
      disclosure:
        outputCapture.admission.kind === 'WithheldSecret'
          ? outputCapture.admission
          : { kind: 'Recordable' },
      stdoutPath,
      stdoutBytes: stdoutBytes(),
      stderrPath,
      stderrBytes: stderrBytes(),
    });
    const observed = {
      exitCode: observation.exitCode,
      terminationSignal: observation.terminationSignal,
      elapsedMilliseconds: elapsed,
      output,
    };
    const commitment = this.#commitElapsed(reservation.reservation, command, elapsed);
    if (outputCapture.admission.kind === 'WithheldSecret') {
      return { kind: 'SecretDetected', ...observed };
    }
    if (observation.kind === 'CleanupUnconfirmed') {
      return { kind: 'ProcessCleanupUnconfirmed', ...observed };
    }
    if (interruption === 'ProcessGroupSurvived') {
      return { kind: 'ProcessGroupSurvived', ...observed };
    }
    if (commitment.kind !== 'Committed') {
      return {
        kind: 'BudgetCommitmentFailed',
        failure: budgetFailure(commitment),
        ...observed,
      };
    }
    if (interruption === 'CaptureFailed') {
      return { kind: 'DependencyUnavailable' };
    }
    if (interruption !== undefined) {
      return { kind: interruption, ...observed };
    }
    if (observation.exitCode === command.expectedExitCode) {
      return {
        kind: 'Completed',
        exitCode: observation.exitCode,
        terminationSignal: observation.terminationSignal,
        elapsedMilliseconds: elapsed,
        output,
      };
    }
    if (observation.exitCode !== null) {
      return {
        kind: 'ExitCodeMismatch',
        exitCode: observation.exitCode,
        terminationSignal: observation.terminationSignal,
        elapsedMilliseconds: elapsed,
        output,
      };
    }
    return { kind: 'DependencyUnavailable' };
  }

  #commitElapsed(
    reservation: AcceptedRunBudgetReservation,
    command: ExactChildCommand,
    elapsed: number,
  ): RunBudgetCommitment {
    return this.#options.budget.commit(reservation, {
      producer: command.budgetProducer,
      actual: [{ budget: 'aggregateChildCommandTimeSeconds', amount: Math.ceil(elapsed / 1_000) }],
    });
  }
}
