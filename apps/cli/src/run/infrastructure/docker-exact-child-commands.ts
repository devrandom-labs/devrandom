import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { CredentialDisclosure, ProtectedCredentials } from '@devrandom/domain';
import type {
  AcceptedRunBudgetReservation,
  DockerRunEnvironment,
  RunBudgetCommitment,
  RunResourceBudget,
} from '@devrandom/runtime';

import type {
  CapturedChildOutput,
  ChildBudgetCommitmentFailure,
  ExactChildCommand,
  ExactChildCommandOutcome,
  ExactChildCommands,
} from '../application/exact-child-command.js';

export interface DockerExactChildCommandsOptions {
  readonly environment: Pick<DockerRunEnvironment, 'runNative' | 'close'>;
  readonly outputRoot: string;
  readonly maximumOutputBytes: number;
  readonly budget: RunResourceBudget;
  readonly protectedCredentials: ProtectedCredentials;
  monotonicNow(): number;
}

class DockerCapturedChildOutput implements CapturedChildOutput {
  readonly disclosure: CredentialDisclosure;
  readonly stdout: { readonly path: string; readonly byteLength: number };
  readonly stderr: { readonly path: string; readonly byteLength: number };
  readonly #directory: string;
  #cleaned = false;

  constructor(input: {
    readonly directory: string;
    readonly disclosure: CredentialDisclosure;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
  }) {
    this.#directory = input.directory;
    this.disclosure = input.disclosure;
    this.stdout = { path: join(input.directory, 'stdout'), byteLength: input.stdoutBytes };
    this.stderr = { path: join(input.directory, 'stderr'), byteLength: input.stderrBytes };
  }

  async acknowledge() {
    if (this.#cleaned) return { kind: 'AlreadyCleaned' as const };
    try {
      await rm(this.#directory, { recursive: true, force: true });
      this.#cleaned = true;
      return { kind: 'Cleaned' as const };
    } catch {
      return { kind: 'Unavailable' as const };
    }
  }
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

function elapsedMilliseconds(start: number, end: number): number {
  const elapsed = Math.ceil(end - start);
  return Number.isSafeInteger(elapsed) && elapsed > 0 ? elapsed : 0;
}

/** The parent runs one exact H1 command in a disposable OCI compartment. */
export class DockerExactChildCommands implements ExactChildCommands {
  readonly #options: DockerExactChildCommandsOptions;

  constructor(options: DockerExactChildCommandsOptions) {
    this.#options = options;
  }

  async run(command: ExactChildCommand, signal: AbortSignal): Promise<ExactChildCommandOutcome> {
    if (signal.aborted) return { kind: 'AbortedBeforeStart' };
    if (
      !isAbsolute(command.executableRealpath) ||
      !Number.isSafeInteger(command.timeoutSeconds) ||
      command.timeoutSeconds < 1 ||
      command.timeoutSeconds > 300 ||
      !Number.isSafeInteger(command.expectedExitCode) ||
      command.expectedExitCode < 0 ||
      command.expectedExitCode > 255
    )
      return { kind: 'ExecutableUnavailable' };
    const reservation = this.#options.budget.reserve([
      { budget: 'aggregateChildCommandTimeSeconds', amount: command.timeoutSeconds + 2 },
      { budget: 'oneChildCommandTimeSeconds', amount: command.timeoutSeconds },
    ]);
    if (reservation.kind === 'Exhausted') return { kind: 'BudgetExhausted' };
    if (reservation.kind !== 'Reserved') return { kind: 'DependencyUnavailable' };
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
    const startedAt = this.#options.monotonicNow();
    let opened: Awaited<ReturnType<DockerRunEnvironment['runNative']>>;
    try {
      opened = await this.#options.environment.runNative(
        command.executableRealpath,
        command.arguments,
        signal,
      );
    } catch {
      this.#options.budget.release(reservation.reservation);
      await rm(directory, { recursive: true, force: true });
      return { kind: 'ExecutableUnavailable' };
    }
    if (opened.kind !== 'Running') {
      if (opened.kind === 'ProfileDrift') {
        this.#options.budget.release(reservation.reservation);
        await rm(directory, { recursive: true, force: true });
        await this.#options.environment.close();
        return { kind: 'WorktreeAdmissionRejected', failure: 'EvidenceIntegrityFailure' };
      }
      if (opened.kind === 'CleanupUnconfirmed') {
        await this.#options.environment.close();
        const elapsed = elapsedMilliseconds(startedAt, this.#options.monotonicNow());
        this.#commitElapsed(reservation.reservation, command, elapsed);
        try {
          await Promise.all([
            writeFile(join(directory, 'stdout'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 }),
            writeFile(join(directory, 'stderr'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 }),
          ]);
        } catch {
          await rm(directory, { recursive: true, force: true });
          return { kind: 'DependencyUnavailable' };
        }
        return {
          kind: 'ProcessCleanupUnconfirmed',
          exitCode: null,
          terminationSignal: null,
          elapsedMilliseconds: elapsed,
          output: new DockerCapturedChildOutput({
            directory,
            disclosure: { kind: 'Recordable' },
            stdoutBytes: 0,
            stderrBytes: 0,
          }),
        };
      }
      this.#options.budget.release(reservation.reservation);
      await rm(directory, { recursive: true, force: true });
      return { kind: 'ExecutableUnavailable' };
    }
    const { child } = opened;
    let interruption: 'TimedOut' | 'OutputLimitExceeded' | 'Aborted' | undefined;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closure: Promise<boolean> | undefined;
    const close = (): Promise<boolean> => {
      closure ??= opened.close().catch(() => false);
      return closure;
    };
    const interruptedExit = Promise.withResolvers<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly failed: boolean;
    }>();
    const interrupt = (reason: Exclude<typeof interruption, undefined>) => {
      if (interruption !== undefined) return;
      interruption = reason;
      void close().then((removed) => {
        child.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        interruptedExit.resolve({ code: null, signal: null, failed: !removed });
      });
    };
    const capture = (chunk: Buffer, destination: Buffer[]) => {
      if (interruption !== undefined) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > this.#options.maximumOutputBytes) {
        interrupt('OutputLimitExceeded');
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      capture(chunk, stdout);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(chunk, stderr);
    });
    const exit = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly failed: boolean;
    }>((resolve) => {
      child.once('close', (code, signalCode) => {
        resolve({ code, signal: signalCode, failed: false });
      });
      child.once('error', () => {
        resolve({ code: null, signal: null, failed: true });
      });
    });
    const abort = () => {
      interrupt('Aborted');
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
    } catch {
      abort();
    }
    const timeout = setTimeout(() => {
      interrupt('TimedOut');
    }, command.timeoutSeconds * 1_000);
    const observation = await Promise.race([exit, interruptedExit.promise]);
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    const containerRemoved = await close();
    const elapsed = elapsedMilliseconds(startedAt, this.#options.monotonicNow());
    const commitment = this.#commitElapsed(reservation.reservation, command, elapsed);
    if (!containerRemoved) {
      await this.#options.environment.close();
      try {
        await Promise.all([
          writeFile(join(directory, 'stdout'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 }),
          writeFile(join(directory, 'stderr'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 }),
        ]);
      } catch {
        await rm(directory, { recursive: true, force: true });
        return { kind: 'DependencyUnavailable' };
      }
      return {
        kind: 'ProcessCleanupUnconfirmed',
        exitCode: observation.code,
        terminationSignal: observation.signal,
        elapsedMilliseconds: elapsed,
        output: new DockerCapturedChildOutput({
          directory,
          disclosure: { kind: 'Recordable' },
          stdoutBytes: 0,
          stderrBytes: 0,
        }),
      };
    }
    if (observation.failed) {
      await this.#options.environment.close();
      await rm(directory, { recursive: true, force: true });
      return { kind: 'DependencyUnavailable' };
    }
    const stdoutBytes = Buffer.concat(stdout);
    const stderrBytes = Buffer.concat(stderr);
    const stdoutDisclosure = this.#options.protectedCredentials.inspect(stdoutBytes);
    const stderrDisclosure = this.#options.protectedCredentials.inspect(stderrBytes);
    const disclosure =
      stdoutDisclosure.kind === 'WithheldSecret'
        ? stdoutDisclosure
        : stderrDisclosure.kind === 'WithheldSecret'
          ? stderrDisclosure
          : { kind: 'Recordable' as const };
    const writeable = disclosure.kind === 'Recordable';
    try {
      await Promise.all([
        writeFile(join(directory, 'stdout'), writeable ? stdoutBytes : Buffer.alloc(0), {
          flag: 'wx',
          mode: 0o600,
        }),
        writeFile(join(directory, 'stderr'), writeable ? stderrBytes : Buffer.alloc(0), {
          flag: 'wx',
          mode: 0o600,
        }),
      ]);
    } catch {
      await this.#options.environment.close();
      await rm(directory, { recursive: true, force: true });
      return { kind: 'DependencyUnavailable' };
    }
    const output = new DockerCapturedChildOutput({
      directory,
      disclosure,
      stdoutBytes: writeable ? stdoutBytes.byteLength : 0,
      stderrBytes: writeable ? stderrBytes.byteLength : 0,
    });
    const observed = {
      exitCode: observation.code,
      terminationSignal: observation.signal,
      elapsedMilliseconds: elapsed,
      output,
    };
    if (disclosure.kind === 'WithheldSecret') return { kind: 'SecretDetected', ...observed };
    if (commitment.kind !== 'Committed') {
      await this.#options.environment.close();
      return { kind: 'BudgetCommitmentFailed', failure: budgetFailure(commitment), ...observed };
    }
    if (interruption !== undefined) return { kind: interruption, ...observed };
    if (observation.code === command.expectedExitCode)
      return { kind: 'Completed', ...observed, exitCode: observation.code };
    if (observation.code !== null)
      return { kind: 'ExitCodeMismatch', ...observed, exitCode: observation.code };
    await output.acknowledge();
    await this.#options.environment.close();
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
