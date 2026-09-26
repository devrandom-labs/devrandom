import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { prepareEvidenceArtifact, type EvaluationExecutionProfile } from '@devrandom/protocol';

import type {
  EvaluationRawArtifacts,
  ProtectedCaseCustody,
  ReceiptObservation,
  TaskArtifactConstruction,
} from '../application/evaluation-conversations.js';
import { DockerEvaluationCompartment } from './docker-compartment.js';
import type { SourceCustody } from './source-custody.js';

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

const runner = `use std::io::{self, Read};
use cesr_receipt_service::{parse_receipt_stream, ReceiptError, ReceiptVersion};
fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() { std::process::exit(3); }
    match parse_receipt_stream(&input) {
        Ok(receipts) => {
            let items: Vec<String> = receipts.iter().map(|receipt| {
                let version = match receipt.version { ReceiptVersion::Legacy => "Legacy", ReceiptVersion::Current => "Current" };
                format!("{}:{}", version, receipt.payload)
            }).collect();
            println!("DV1|P|{}", items.join(","));
        }
        Err(error) => {
            let name = match error { ReceiptError::InvalidFrame => "InvalidFrame", ReceiptError::InvalidPayload => "InvalidPayload", ReceiptError::UnsupportedVersion => "UnsupportedVersion" };
            println!("DV1|R|{}", name);
        }
    }
}
`;

function identifiedJson(value: unknown): string | undefined {
  const prepared = prepareEvidenceArtifact(Buffer.from(JSON.stringify(value)), 'application/json');
  return prepared.kind === 'Prepared' ? prepared.artifact.d : undefined;
}

async function recordJson(artifacts: EvaluationRawArtifacts, value: unknown): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared')
    throw new Error('Native observation receipt exceeds custody limit.');
  const stored = await artifacts.record({ bytes, mediaType: 'application/json' });
  if (stored.kind !== 'Stored' || stored.artifact.d !== prepared.artifact.d)
    throw new Error('Native observation receipt custody failed.');
  return stored.artifact.d;
}

function sha(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function observeContainedCommand(
  child: ReturnType<DockerEvaluationCompartment['execute']>,
  input: Uint8Array,
  limit: number,
  signal: AbortSignal,
): Promise<
  { readonly code: number | null; readonly output: string; readonly error: string } | undefined
> {
  let output = Buffer.alloc(0);
  let error = Buffer.alloc(0);
  const limitState = { exceeded: false };
  const collect = (target: 'output' | 'error', chunk: Buffer) => {
    if (target === 'output') output = Buffer.concat([output, chunk]);
    else error = Buffer.concat([error, chunk]);
    if (output.length + error.length > limit) {
      limitState.exceeded = true;
      child.kill();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    collect('output', chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    collect('error', chunk);
  });
  const abort = () => {
    child.kill();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  signal.removeEventListener('abort', abort);
  if (limitState.exceeded || interrupted(signal)) return undefined;
  return { code, output: output.toString('utf8'), error: error.toString('utf8') };
}

/** Immutable parent custody for the actual executable produced by a separate offline build. */
export class ExecutableCustody {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async freeze(
    path: string,
    binding: {
      readonly sourceSaid: string;
      readonly recipeSaid: string;
      readonly toolchainSaid: string;
    },
  ): Promise<{ readonly executableSaid: string; readonly bytes: number }> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new Error('Invalid produced executable.');
    const bytes = await readFile(path);
    const executableSaid = identifiedJson({
      version: 1,
      kind: 'FrozenExecutable',
      contentDigest: sha(bytes),
      byteLength: bytes.length,
      ...binding,
    });
    if (executableSaid === undefined) throw new Error('Executable identity failed.');
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.#root, executableSaid), bytes, { flag: 'wx', mode: 0o500 });
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
      const existing = await readFile(join(this.#root, executableSaid));
      if (!existing.equals(bytes))
        throw new Error('Frozen executable custody collision.', { cause });
    }
    return { executableSaid, bytes: bytes.length };
  }

  async open(executableSaid: string): Promise<string | undefined> {
    if (!/^[A-Z][A-Za-z0-9_-]{43}$/u.test(executableSaid)) return undefined;
    const path = join(this.#root, executableSaid);
    try {
      const bytes = await readFile(path);
      const metadata = await readFile(join(this.#root, `${executableSaid}.json`), 'utf8');
      const parsed: unknown = JSON.parse(metadata);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('contentDigest' in parsed) ||
        parsed.contentDigest !== sha(bytes) ||
        identifiedJson(parsed) !== executableSaid
      )
        return undefined;
      return path;
    } catch {
      return undefined;
    }
  }

  async sealMetadata(
    executableSaid: string,
    binding: {
      readonly sourceSaid: string;
      readonly recipeSaid: string;
      readonly toolchainSaid: string;
    },
  ): Promise<void> {
    const bytes = await readFile(join(this.#root, executableSaid));
    const metadata = {
      version: 1,
      kind: 'FrozenExecutable',
      contentDigest: sha(bytes),
      byteLength: bytes.length,
      ...binding,
    };
    if (identifiedJson(metadata) !== executableSaid)
      throw new Error('Executable metadata mismatch.');
    try {
      await writeFile(join(this.#root, `${executableSaid}.json`), JSON.stringify(metadata), {
        flag: 'wx',
        mode: 0o400,
      });
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
      const existing = await readFile(join(this.#root, `${executableSaid}.json`), 'utf8');
      if (existing !== JSON.stringify(metadata))
        throw new Error('Frozen executable metadata collision.', { cause });
    }
  }
}

export class DockerTaskArtifactConstruction implements TaskArtifactConstruction {
  readonly #source: SourceCustody;
  readonly #executables: ExecutableCustody;
  readonly #profile: EvaluationExecutionProfile;
  readonly #image: string;
  readonly #recipeSaid: string;
  readonly #toolchainSaid: string;
  readonly #artifacts: EvaluationRawArtifacts;

  constructor(input: {
    readonly source: SourceCustody;
    readonly executables: ExecutableCustody;
    readonly profile: EvaluationExecutionProfile;
    readonly image: string;
    readonly recipeSaid: string;
    readonly toolchainSaid: string;
    readonly artifacts: EvaluationRawArtifacts;
  }) {
    this.#source = input.source;
    this.#executables = input.executables;
    this.#profile = input.profile;
    this.#image = input.image;
    this.#recipeSaid = input.recipeSaid;
    this.#toolchainSaid = input.toolchainSaid;
    this.#artifacts = input.artifacts;
  }

  async build(
    input: Parameters<TaskArtifactConstruction['build']>[0],
  ): ReturnType<TaskArtifactConstruction['build']> {
    if (
      input.reviewedRecipeSaid !== this.#recipeSaid ||
      input.toolchainSaid !== this.#toolchainSaid ||
      input.containerProfileSaid !== this.#profile.d
    )
      return { kind: 'Invalid', reason: 'ProfileDrift' };
    if (input.signal.aborted) return { kind: 'Invalid', reason: 'Interrupted' };
    const captured = await this.#source.open(input.capturedSourceSaid);
    if (captured === undefined) return { kind: 'Invalid', reason: 'UnsafeSource' };
    const scratch = await mkdtemp(join(tmpdir(), 'devrandom-build-'));
    let compartment: DockerEvaluationCompartment | undefined;
    try {
      const sourceRoot = join(scratch, 'source');
      await mkdir(sourceRoot);
      if (captured.files.some((file) => file.path === 'src/bin/devrandom-observe.rs'))
        return { kind: 'Invalid', reason: 'UnsafeSource' };
      for (const file of captured.files) {
        const path = join(sourceRoot, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes, { flag: 'wx', mode: 0o644 });
      }
      const runnerPath = join(sourceRoot, 'src/bin/devrandom-observe.rs');
      await mkdir(dirname(runnerPath), { recursive: true });
      await writeFile(runnerPath, runner, { flag: 'wx', mode: 0o644 });
      const opened = await DockerEvaluationCompartment.open({
        profile: this.#profile,
        image: this.#image,
        mounts: [],
        signal: input.signal,
      });
      if (opened.kind !== 'Opened')
        return {
          kind: 'Invalid',
          reason: opened.kind === 'ProfileDrift' ? 'ProfileDrift' : 'CleanupUnconfirmed',
        };
      compartment = opened.compartment;
      await compartment.copyInto(sourceRoot, '/work/source');
      await compartment.prepareCopiedSource('/work/source');
      const build = await observeContainedCommand(
        compartment.execute([
          'env',
          'CARGO_NET_OFFLINE=true',
          'CARGO_BUILD_JOBS=1',
          'CARGO_HOME=/tmp/cargo',
          'CARGO_TARGET_DIR=/work/target',
          'cargo',
          'build',
          '--offline',
          '--locked',
          '--bin',
          'devrandom-observe',
          '--manifest-path',
          '/work/source/Cargo.toml',
        ]),
        new Uint8Array(),
        this.#profile.limits.outputBytes,
        input.signal,
      );
      if (build === undefined)
        return {
          kind: 'Invalid',
          reason: interrupted(input.signal) ? 'Interrupted' : 'CleanupUnconfirmed',
        };
      const buildReceiptSaid = await recordJson(this.#artifacts, {
        sourceSaid: input.capturedSourceSaid,
        recipeSaid: this.#recipeSaid,
        toolchainSaid: this.#toolchainSaid,
        exitCode: build.code,
        stdout: build.output,
        stderr: build.error,
        effectiveLimitsDigest: sha(Buffer.from(opened.effectiveLimitsReceipt)),
      });
      if (build.code !== 0) {
        const closed = await compartment.close();
        compartment = undefined;
        if (!closed) return { kind: 'Invalid', reason: 'CleanupUnconfirmed' };
        const cleanupReceiptSaid = await recordJson(this.#artifacts, {
          buildReceiptSaid,
          stopped: true,
        });
        return { kind: 'BuildFailed', buildReceiptSaid, cleanupReceiptSaid };
      }
      const localExecutable = join(scratch, 'devrandom-observe');
      await compartment.copyOut('/work/target/debug/devrandom-observe', localExecutable);
      const frozen = await this.#executables.freeze(localExecutable, {
        sourceSaid: input.capturedSourceSaid,
        recipeSaid: this.#recipeSaid,
        toolchainSaid: this.#toolchainSaid,
      });
      await this.#executables.sealMetadata(frozen.executableSaid, {
        sourceSaid: input.capturedSourceSaid,
        recipeSaid: this.#recipeSaid,
        toolchainSaid: this.#toolchainSaid,
      });
      const closed = await compartment.close();
      compartment = undefined;
      if (!closed) return { kind: 'Invalid', reason: 'CleanupUnconfirmed' };
      const cleanupReceiptSaid = await recordJson(this.#artifacts, {
        buildReceiptSaid,
        stopped: true,
      });
      return {
        kind: 'Frozen',
        executableSaid: frozen.executableSaid,
        sourceSaid: input.capturedSourceSaid,
        buildReceiptSaid,
        cleanupReceiptSaid,
      };
    } catch {
      return {
        kind: 'Invalid',
        reason: interrupted(input.signal) ? 'Interrupted' : 'UnsafeSource',
      };
    } finally {
      if (compartment !== undefined) await compartment.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export class DockerReceiptObservation implements ReceiptObservation {
  readonly #executables: ExecutableCustody;
  readonly #profile: EvaluationExecutionProfile;
  readonly #image: string;
  readonly #artifacts: EvaluationRawArtifacts;
  readonly #protectedCases: ProtectedCaseCustody | undefined;

  constructor(input: {
    readonly executables: ExecutableCustody;
    readonly profile: EvaluationExecutionProfile;
    readonly image: string;
    readonly artifacts: EvaluationRawArtifacts;
    readonly protectedCases?: ProtectedCaseCustody;
  }) {
    this.#executables = input.executables;
    this.#profile = input.profile;
    this.#image = input.image;
    this.#artifacts = input.artifacts;
    this.#protectedCases = input.protectedCases;
  }

  async observe(
    input: Parameters<ReceiptObservation['observe']>[0],
  ): ReturnType<ReceiptObservation['observe']> {
    if (input.signal.aborted) return { kind: 'Invalid', reason: 'Interrupted' };
    const protectedCases = this.#protectedCases;
    if (input.caseScope === 'Protected' && protectedCases === undefined)
      return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
    const executable = await this.#executables.open(input.executableSaid);
    const stimulusArtifact = prepareEvidenceArtifact(input.stimulus, 'text/plain; charset=utf-8');
    if (
      executable === undefined ||
      stimulusArtifact.kind !== 'Prepared' ||
      stimulusArtifact.artifact.d !== input.stimulusSaid
    )
      return { kind: 'Invalid', reason: 'ExecutableMismatch' };
    if (input.stimulus.byteLength > 64 * 1024) return { kind: 'Invalid', reason: 'ProfileDrift' };
    let compartment: DockerEvaluationCompartment | undefined;
    const scratch = await mkdtemp(join(tmpdir(), 'devrandom-observe-'));
    try {
      const opened = await DockerEvaluationCompartment.open({
        profile: this.#profile,
        image: this.#image,
        mounts: [],
        signal: input.signal,
      });
      if (opened.kind !== 'Opened') return { kind: 'Invalid', reason: 'ProfileDrift' };
      compartment = opened.compartment;
      const transferred = join(scratch, 'devrandom-observe');
      await copyFile(executable, transferred);
      await chmod(transferred, 0o500);
      await compartment.copyInto(transferred, '/work/devrandom-observe');
      await compartment.prepareCopiedSource('/work/devrandom-observe');
      const observed = await observeContainedCommand(
        compartment.execute(['/work/devrandom-observe']),
        input.stimulus,
        this.#profile.limits.outputBytes,
        input.signal,
      );
      if (observed === undefined || observed.code !== 0 || observed.error.length > 0)
        return {
          kind: 'Invalid',
          reason: interrupted(input.signal) ? 'Interrupted' : 'ProfileDrift',
        };
      const text = observed.output.trimEnd();
      let observation: Extract<
        Awaited<ReturnType<ReceiptObservation['observe']>>,
        { kind: 'Observed' }
      >['observation'];
      if (text.startsWith('DV1|P|') && !text.includes('\n')) {
        const raw = text.slice(6);
        const receipts =
          raw === ''
            ? []
            : raw.split(',').map((part) => {
                const [version, payload] = part.split(':');
                if (
                  (version !== 'Legacy' && version !== 'Current') ||
                  payload === undefined ||
                  !/^E[A-Za-z0-9_-]{43}$/u.test(payload)
                )
                  throw new Error('Invalid receipt observation.');
                const receipt: { version: 'Legacy' | 'Current'; payload: string } = {
                  version,
                  payload,
                };
                return receipt;
              });
        observation = { kind: 'Parsed', receipts };
      } else if (/^DV1\|R\|(InvalidFrame|InvalidPayload|UnsupportedVersion)$/u.test(text)) {
        observation = {
          kind: 'Rejected',
          error: text.slice(6) as 'InvalidFrame' | 'InvalidPayload' | 'UnsupportedVersion',
        };
      } else return { kind: 'Invalid', reason: 'ProfileDrift' };
      const observationRecord = {
        executableSaid: input.executableSaid,
        stimulusSaid: input.stimulusSaid,
        caseScope: input.caseScope,
        observation,
        stdout: observed.output,
        effectiveLimitsDigest: sha(Buffer.from(opened.effectiveLimitsReceipt)),
      };
      let rawObservationSaid: string;
      let protectedObservation: Awaited<ReturnType<ProtectedCaseCustody['seal']>> | undefined;
      if (input.caseScope === 'Protected') {
        if (protectedCases === undefined) return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
        protectedObservation = await protectedCases.seal({
          evaluationId: input.evaluationId,
          objectSaid: input.objectSaid,
          purpose: 'OracleObservation',
          segment: input.segment,
          plaintext: Buffer.from(JSON.stringify(observationRecord), 'utf8'),
        });
        if (protectedObservation.kind !== 'Sealed')
          return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
        rawObservationSaid = protectedObservation.artifact.d;
      } else {
        rawObservationSaid = await recordJson(this.#artifacts, observationRecord);
      }
      const closed = await compartment.close();
      compartment = undefined;
      if (!closed) return { kind: 'Invalid', reason: 'CleanupUnconfirmed' };
      const cleanupReceiptSaid = await recordJson(this.#artifacts, {
        rawObservationSaid,
        stopped: true,
      });
      return {
        kind: 'Observed',
        executableSaid: input.executableSaid,
        observation,
        rawObservationSaid,
        ...(protectedObservation?.kind === 'Sealed'
          ? { protectedObservation: protectedObservation.artifact }
          : {}),
        cleanupReceiptSaid,
      };
    } catch {
      return {
        kind: 'Invalid',
        reason: interrupted(input.signal) ? 'Interrupted' : 'ProfileDrift',
      };
    } finally {
      if (compartment !== undefined) await compartment.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
