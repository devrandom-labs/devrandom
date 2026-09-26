import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  type BaselineHarnessRevision,
  type EvaluationExecutionProfile,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  DockerEvaluationCompartment,
  type EvaluationMount,
} from '../evaluation/infrastructure/docker-compartment.js';
import { digestEvaluationRuntimeMounts } from '../evaluation/infrastructure/runtime-mount-digest.js';

export interface RunRuntimeMount {
  readonly hostPath: string;
  readonly containerPath: string;
}

export interface RunEnvironmentOpeningInput {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly runtimeMounts: readonly RunRuntimeMount[];
  readonly worktreeDirectory: string;
  readonly executableRealpaths: readonly string[];
  readonly environmentCompatibility: BaselineHarnessRevision['environmentCompatibility'];
  readonly parentDeathCleanupReceipt: Uint8Array;
  readonly signal: AbortSignal;
}

export type RunEnvironmentOpening =
  | {
      readonly kind: 'Opened';
      readonly environment: DockerRunEnvironment;
      readonly effectiveLimitsReceipt: Uint8Array;
      readonly parentDeathCleanupReceipt: Uint8Array;
    }
  | { readonly kind: 'ProfileDrift' | 'Unavailable' | 'CleanupUnconfirmed' };

export type RunEnvironmentProbeInput = Omit<
  RunEnvironmentOpeningInput,
  'parentDeathCleanupReceipt' | 'environmentCompatibility'
>;

export type RunEnvironmentProbe =
  | {
      readonly kind: 'Observed';
      readonly toolchainDigest: string;
      readonly nodeVersion: string;
      readonly gitVersion: string;
      readonly effectiveLimitsReceipt: Uint8Array;
    }
  | { readonly kind: 'ProfileDrift' | 'Unavailable' | 'CleanupUnconfirmed' };

const cleanupSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('RunParentDeathCleanup'),
    imageDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    runtimeDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    architecture: Type.Union([Type.Literal('aarch64'), Type.Literal('x86_64')]),
    limits: Type.Object(
      {
        cpuCount: Type.Integer(),
        memoryBytes: Type.Integer(),
        processCount: Type.Integer(),
        scratchBytes: Type.Integer(),
        outputBytes: Type.Integer(),
        wallTimeSeconds: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    mechanism: Type.Literal('WatchdogParentLoss'),
    workerContainer: Type.String({ pattern: '^devrandom-evaluation-[0-9a-f-]{36}$' }),
    nativeContainer: Type.String({ pattern: '^devrandom-evaluation-[0-9a-f-]{36}$' }),
    workerRemoved: Type.Literal(true),
    nativeRemoved: Type.Literal(true),
    observedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: false },
);

interface InspectedCompartment {
  readonly Image?: string;
  readonly Config?: { readonly User?: string };
  readonly HostConfig?: {
    readonly NetworkMode?: string;
    readonly IpcMode?: string;
    readonly ReadonlyRootfs?: boolean;
    readonly Privileged?: boolean;
    readonly CapDrop?: readonly string[];
    readonly SecurityOpt?: readonly string[];
    readonly PidsLimit?: number;
    readonly Memory?: number;
    readonly NanoCpus?: number;
    readonly Tmpfs?: Readonly<Record<string, string>>;
  };
  readonly Mounts?: readonly {
    readonly Destination?: string;
    readonly RW?: boolean;
    readonly Type?: string;
  }[];
}

function artifactSaid(bytes: Uint8Array): string | undefined {
  const identified = prepareEvidenceArtifact(bytes, 'application/json');
  return identified.kind === 'Prepared' ? identified.artifact.d : undefined;
}

/** Checks the exact prior parent-loss observation claimed by a Run profile. */
export function inspectRunParentDeathCleanupReceipt(
  profile: EvaluationExecutionProfile,
  receipt: Uint8Array,
): boolean {
  if (artifactSaid(receipt) !== profile.parentDeathCleanupReceiptSaid) return false;
  let cleanup: unknown;
  try {
    cleanup = JSON.parse(Buffer.from(receipt).toString('utf8'));
  } catch {
    return false;
  }
  return (
    Value.Check(cleanupSchema, cleanup) &&
    cleanup.imageDigest === profile.imageDigest &&
    cleanup.runtimeDigest === profile.runtimeDigest &&
    cleanup.architecture === profile.architecture &&
    isDeepStrictEqual(cleanup.limits, profile.limits) &&
    cleanup.workerContainer !== cleanup.nativeContainer &&
    Number.isFinite(Date.parse(cleanup.observedAt)) &&
    new Date(cleanup.observedAt).toISOString() === cleanup.observedAt
  );
}

function receiptPart(raw: string): unknown {
  try {
    const received: unknown = JSON.parse(raw);
    if (!Array.isArray(received) || received.length !== 1) return undefined;
    const inspected = received[0] as InspectedCompartment;
    const host = inspected.HostConfig;
    if (
      host === undefined ||
      inspected.Image === undefined ||
      inspected.Config?.User === undefined ||
      inspected.Mounts === undefined ||
      host.Tmpfs === undefined
    )
      return undefined;
    return {
      imageDigest: inspected.Image,
      user: inspected.Config.User,
      networkMode: host.NetworkMode,
      ipcMode: host.IpcMode,
      readOnlyRoot: host.ReadonlyRootfs,
      privileged: host.Privileged,
      droppedCapabilities: [...(host.CapDrop ?? [])].sort(),
      securityOptions: [...(host.SecurityOpt ?? [])].sort(),
      processLimit: host.PidsLimit,
      memoryBytes: host.Memory,
      nanoCpus: host.NanoCpus,
      temporaryFilesystems: Object.entries(host.Tmpfs).sort(([a], [b]) => a.localeCompare(b)),
      mounts: inspected.Mounts.map((mount) => ({
        destination: mount.Destination,
        writable: mount.RW,
        type: mount.Type,
      })).sort((a, b) => (a.destination ?? '').localeCompare(b.destination ?? '')),
    };
  } catch {
    return undefined;
  }
}

function effectiveReceipt(input: {
  readonly profile: EvaluationExecutionProfile;
  readonly worker: string;
  readonly native: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly gitVersion: string;
}): Uint8Array | undefined {
  const worker = receiptPart(input.worker);
  const native = receiptPart(input.native);
  if (worker === undefined || native === undefined) return undefined;
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunEffectiveLimits',
      os: 'linux',
      architecture: input.architecture,
      nodeVersion: input.nodeVersion,
      gitVersion: input.gitVersion,
      imageDigest: input.profile.imageDigest,
      runtimeDigest: input.profile.runtimeDigest,
      worker,
      native,
    }),
    'utf8',
  );
}

async function outputOf(child: ChildProcessWithoutNullStreams): Promise<string | undefined> {
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) > 65_536) {
      child.kill();
    }
  });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return code === 0 && Buffer.byteLength(stdout) <= 65_536 ? stdout.trim() : undefined;
}

async function inspectToolchain(
  compartment: DockerEvaluationCompartment,
  paths: readonly string[],
): Promise<string | undefined> {
  const script = [
    "const fs=require('node:fs');",
    "const crypto=require('node:crypto');",
    'const paths=JSON.parse(process.argv[1]);',
    'const files=[];',
    '(async()=>{for(const path of paths){',
    ' if(fs.realpathSync(path)!==path) throw Error("not realpath");',
    ' const stat=fs.statSync(path);',
    ' if(!stat.isFile() || (stat.mode&0o111)===0) throw Error("not executable");',
    " const hash=crypto.createHash('sha256');",
    ' for await (const chunk of fs.createReadStream(path)) hash.update(chunk);',
    " files.push({path,sha256:hash.digest('hex')});",
    '}',
    'process.stdout.write(JSON.stringify(files));',
    '})().catch(()=>process.exit(1));',
  ].join('');
  const result = await outputOf(
    compartment.execute(['/usr/local/bin/node', '-e', script, JSON.stringify(paths)]),
  );
  if (result === undefined) return undefined;
  try {
    const received: unknown = JSON.parse(result);
    if (!Array.isArray(received) || received.length !== paths.length) return undefined;
    for (const [index, file] of (received as unknown[]).entries()) {
      if (
        typeof file !== 'object' ||
        file === null ||
        !('path' in file) ||
        file.path !== paths[index] ||
        !('sha256' in file) ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      )
        return undefined;
    }
    return `sha256:${createHash('sha256').update(result).digest('hex')}`;
  } catch {
    return undefined;
  }
}

async function inspectVersions(
  worker: DockerEvaluationCompartment,
  native: DockerEvaluationCompartment,
): Promise<{ nodeVersion: string; gitVersion: string } | undefined> {
  const node = await outputOf(worker.execute(['/usr/local/bin/node', '--version']));
  const git = await outputOf(native.execute(['/usr/bin/git', '--version']));
  if (node === undefined || git === undefined || !/^v\d+\.\d+\.\d+$/u.test(node)) return undefined;
  const gitMatch = /^git version (\d+\.\d+(?:\.\d+)?(?:\.[a-zA-Z0-9]+)?)$/u.exec(git);
  const gitVersion = gitMatch?.[1];
  return gitVersion === undefined ? undefined : { nodeVersion: node.slice(1), gitVersion };
}

function toolchainPaths(paths: readonly string[]): readonly string[] {
  return [...new Set([...paths, '/usr/local/bin/node', '/usr/bin/git'])].sort();
}

/** Run-specific pair of compartments: read-only Pi worker and separate Linux native effects. */
export class DockerRunEnvironment {
  readonly #worker: DockerEvaluationCompartment;
  readonly #profile: EvaluationExecutionProfile;
  readonly #image: string;
  readonly #worktreeDirectory: string;
  readonly #nativeReceipt: unknown;
  readonly #runtimeMounts: readonly RunRuntimeMount[];
  readonly #executables: ReadonlySet<string>;
  #activeNative: DockerEvaluationCompartment | undefined;
  #cleanupFailed = false;
  #closed = false;

  private constructor(
    worker: DockerEvaluationCompartment,
    profile: EvaluationExecutionProfile,
    image: string,
    worktreeDirectory: string,
    nativeReceipt: unknown,
    runtimeMounts: readonly RunRuntimeMount[],
    executables: readonly string[],
  ) {
    this.#worker = worker;
    this.#profile = profile;
    this.#image = image;
    this.#worktreeDirectory = worktreeDirectory;
    this.#nativeReceipt = nativeReceipt;
    this.#runtimeMounts = runtimeMounts;
    this.#executables = new Set(executables);
  }

  /** Observes exact mounted OCI bytes/settings for a draft; callers must issue and reopen the final SAID profile. */
  static async probe(input: RunEnvironmentProbeInput): Promise<RunEnvironmentProbe> {
    const profile = input.profile;
    if (
      decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
      input.signal.aborted ||
      !input.image.endsWith(profile.imageDigest) ||
      input.runtimeMounts.length === 0 ||
      input.executableRealpaths.length === 0 ||
      input.executableRealpaths.some((path) => !path.startsWith('/') || path.includes('\u0000'))
    )
      return { kind: 'ProfileDrift' };
    const runtimeMounts: readonly EvaluationMount[] = input.runtimeMounts.map((mount) => ({
      ...mount,
      writable: false,
    }));
    try {
      const worktree = await lstat(input.worktreeDirectory);
      if (
        !worktree.isDirectory() ||
        worktree.isSymbolicLink() ||
        (await realpath(input.worktreeDirectory)) !== input.worktreeDirectory ||
        (await digestEvaluationRuntimeMounts(runtimeMounts)) !== profile.runtimeDigest
      )
        return { kind: 'ProfileDrift' };
    } catch {
      return { kind: 'ProfileDrift' };
    }
    const worker = await DockerEvaluationCompartment.open({
      profile,
      image: input.image,
      mounts: [
        ...runtimeMounts,
        { hostPath: input.worktreeDirectory, containerPath: '/work/source', writable: false },
      ],
      signal: input.signal,
    });
    if (worker.kind !== 'Opened') return { kind: worker.kind };
    let native: DockerEvaluationCompartment | undefined;
    let observation: RunEnvironmentProbe;
    try {
      const opened = await DockerEvaluationCompartment.open({
        profile,
        image: input.image,
        mounts: [
          ...runtimeMounts,
          { hostPath: input.worktreeDirectory, containerPath: '/work/source', writable: true },
        ],
        signal: input.signal,
      });
      if (opened.kind !== 'Opened') observation = { kind: opened.kind };
      else {
        native = opened.compartment;
        const system = await outputOf(worker.compartment.execute(['/usr/bin/uname', '-sm']));
        const architecture = system?.split(/\s+/u)[1];
        const expectedArchitecture = profile.architecture === 'aarch64' ? 'aarch64' : 'x86_64';
        const versions = await inspectVersions(worker.compartment, native);
        const toolchainDigest = await inspectToolchain(
          native,
          toolchainPaths(input.executableRealpaths),
        );
        const effectiveLimitsReceipt = effectiveReceipt({
          profile,
          worker: worker.effectiveLimitsReceipt,
          native: opened.effectiveLimitsReceipt,
          architecture: profile.architecture,
          nodeVersion: versions?.nodeVersion ?? '',
          gitVersion: versions?.gitVersion ?? '',
        });
        observation =
          system?.startsWith('Linux ') === true &&
          architecture === expectedArchitecture &&
          versions !== undefined &&
          toolchainDigest !== undefined &&
          effectiveLimitsReceipt !== undefined
            ? { kind: 'Observed', toolchainDigest, effectiveLimitsReceipt, ...versions }
            : { kind: 'ProfileDrift' };
      }
    } catch {
      observation = { kind: 'Unavailable' };
    }
    const [workerClosed, nativeClosed] = await Promise.all([
      worker.compartment.close(),
      native?.close() ?? Promise.resolve(true),
    ]);
    return workerClosed && nativeClosed ? observation : { kind: 'CleanupUnconfirmed' };
  }

  static async open(input: RunEnvironmentOpeningInput): Promise<RunEnvironmentOpening> {
    const profile = input.profile;
    if (
      decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
      input.signal.aborted ||
      !input.image.endsWith(profile.imageDigest) ||
      input.runtimeMounts.length === 0 ||
      input.executableRealpaths.length === 0 ||
      input.executableRealpaths.some((path) => !path.startsWith('/') || path.includes('\u0000')) ||
      new Set(input.executableRealpaths).size !== input.executableRealpaths.length ||
      input.environmentCompatibility.operatingSystem !== 'linux' ||
      input.environmentCompatibility.architecture !==
        (profile.architecture === 'aarch64' ? 'arm64' : 'x64') ||
      !inspectRunParentDeathCleanupReceipt(profile, input.parentDeathCleanupReceipt)
    )
      return { kind: 'ProfileDrift' };
    const runtimeMounts: readonly EvaluationMount[] = input.runtimeMounts.map((mount) => ({
      ...mount,
      writable: false,
    }));
    try {
      const worktree = await lstat(input.worktreeDirectory);
      if (
        !worktree.isDirectory() ||
        worktree.isSymbolicLink() ||
        (await realpath(input.worktreeDirectory)) !== input.worktreeDirectory ||
        (await digestEvaluationRuntimeMounts(runtimeMounts)) !== profile.runtimeDigest
      )
        return { kind: 'ProfileDrift' };
    } catch {
      return { kind: 'ProfileDrift' };
    }
    let worker: DockerEvaluationCompartment | undefined;
    let native: DockerEvaluationCompartment | undefined;
    const openPair = async (): Promise<RunEnvironmentOpening> => {
      const workerOpened = await DockerEvaluationCompartment.open({
        profile,
        image: input.image,
        mounts: [
          ...runtimeMounts,
          {
            hostPath: input.worktreeDirectory,
            containerPath: '/work/source',
            writable: false,
          },
        ],
        signal: input.signal,
      });
      if (workerOpened.kind !== 'Opened') return { kind: workerOpened.kind };
      worker = workerOpened.compartment;
      const nativeOpened = await DockerEvaluationCompartment.open({
        profile,
        image: input.image,
        mounts: [
          ...runtimeMounts,
          {
            hostPath: input.worktreeDirectory,
            containerPath: '/work/source',
            writable: true,
          },
        ],
        signal: input.signal,
      });
      if (nativeOpened.kind !== 'Opened') return { kind: nativeOpened.kind };
      native = nativeOpened.compartment;
      const system = await outputOf(worker.execute(['/usr/bin/uname', '-sm']));
      const architecture = system?.split(/\s+/u)[1];
      const expectedArchitecture = profile.architecture === 'aarch64' ? 'aarch64' : 'x86_64';
      if (system?.startsWith('Linux ') !== true || architecture !== expectedArchitecture)
        return { kind: 'ProfileDrift' };
      const versions = await inspectVersions(worker, native);
      if (
        versions === undefined ||
        input.environmentCompatibility.nodeVersion !== versions.nodeVersion ||
        input.environmentCompatibility.gitVersion !== versions.gitVersion
      )
        return { kind: 'ProfileDrift' };
      const toolchainDigest = await inspectToolchain(
        native,
        toolchainPaths(input.executableRealpaths),
      );
      if (toolchainDigest !== profile.toolchainDigest) return { kind: 'ProfileDrift' };
      const limits = effectiveReceipt({
        profile,
        worker: workerOpened.effectiveLimitsReceipt,
        native: nativeOpened.effectiveLimitsReceipt,
        architecture: profile.architecture,
        ...versions,
      });
      if (limits === undefined || artifactSaid(limits) !== profile.effectiveLimitsReceiptSaid)
        return { kind: 'ProfileDrift' };
      const nativeReceipt = receiptPart(nativeOpened.effectiveLimitsReceipt);
      if (nativeReceipt === undefined || !(await native.close()))
        return { kind: 'CleanupUnconfirmed' };
      native = undefined;
      const environment = new DockerRunEnvironment(
        worker,
        profile,
        input.image,
        input.worktreeDirectory,
        nativeReceipt,
        input.runtimeMounts,
        input.executableRealpaths,
      );
      worker = undefined;
      return {
        kind: 'Opened',
        environment,
        effectiveLimitsReceipt: limits,
        parentDeathCleanupReceipt: input.parentDeathCleanupReceipt,
      };
    };
    let disposition: RunEnvironmentOpening;
    try {
      disposition = await openPair();
    } catch {
      disposition = { kind: 'Unavailable' };
    }
    if (disposition.kind === 'Opened') return disposition;
    const [workerClosed, nativeClosed] = await Promise.all([
      worker?.close() ?? Promise.resolve(true),
      native?.close() ?? Promise.resolve(true),
    ]);
    return workerClosed && nativeClosed ? disposition : { kind: 'CleanupUnconfirmed' };
  }

  startWorker(workerProgram: string, binding: string): ChildProcessWithoutNullStreams {
    if (
      this.#closed ||
      !/^[a-zA-Z0-9/_-]+\.js$/u.test(workerProgram) ||
      !this.#runtimeMounts.some((mount) => workerProgram.startsWith(`${mount.containerPath}/`)) ||
      binding.length === 0
    )
      throw new Error('Run worker program or binding invalid.');
    return this.#worker.execute(['/usr/local/bin/node', workerProgram, binding]);
  }

  async runNative(
    executableRealpath: string,
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'Running';
        readonly child: ChildProcessWithoutNullStreams;
        close(): Promise<boolean>;
      }
    | { readonly kind: 'ProfileDrift' | 'Unavailable' | 'CleanupUnconfirmed' }
  > {
    if (
      this.#closed ||
      this.#activeNative !== undefined ||
      !this.#executables.has(executableRealpath)
    )
      throw new Error('Run native executable outside pinned H1 inventory.');
    const opened = await DockerEvaluationCompartment.open({
      profile: this.#profile,
      image: this.#image,
      mounts: [
        ...this.#runtimeMounts.map((mount) => ({ ...mount, writable: false })),
        {
          hostPath: this.#worktreeDirectory,
          containerPath: '/work/source',
          writable: true,
        },
      ],
      signal,
    });
    if (opened.kind !== 'Opened') return { kind: opened.kind };
    const native = opened.compartment;
    if (!isDeepStrictEqual(receiptPart(opened.effectiveLimitsReceipt), this.#nativeReceipt)) {
      const closed = await native.close();
      if (!closed) this.#cleanupFailed = true;
      return closed ? { kind: 'ProfileDrift' } : { kind: 'CleanupUnconfirmed' };
    }
    this.#activeNative = native;
    try {
      const child = native.executeAt('/work/source', [executableRealpath, ...arguments_]);
      return {
        kind: 'Running',
        child,
        close: async () => {
          const closed = await native.close();
          if (!closed) this.#cleanupFailed = true;
          if (closed && this.#activeNative === native) this.#activeNative = undefined;
          return closed;
        },
      };
    } catch {
      const closed = await native.close();
      if (!closed) this.#cleanupFailed = true;
      if (closed) this.#activeNative = undefined;
      return { kind: closed ? 'Unavailable' : 'CleanupUnconfirmed' };
    }
  }

  async close(): Promise<boolean> {
    if (this.#closed) return !this.#cleanupFailed;
    this.#closed = true;
    const [workerClosed, nativeClosed] = await Promise.all([
      this.#worker.close(),
      this.#activeNative?.close() ?? Promise.resolve(true),
    ]);
    if (!workerClosed || !nativeClosed) this.#cleanupFailed = true;
    return !this.#cleanupFailed;
  }
}
