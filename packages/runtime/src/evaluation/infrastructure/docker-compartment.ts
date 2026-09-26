import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  decodeEvaluationExecutionProfile,
  type EvaluationExecutionProfile,
} from '@devrandom/protocol';

const runFile = promisify(execFile);

export interface EvaluationMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly writable: boolean;
}

export type CompartmentOpening =
  | {
      readonly kind: 'Opened';
      readonly compartment: DockerEvaluationCompartment;
      readonly effectiveLimitsReceipt: string;
    }
  | { readonly kind: 'Unavailable' | 'ProfileDrift' | 'CleanupUnconfirmed' };

/** Docker is a CLI-owned mechanism; the worker sees no daemon socket or parent credentials. */
export class DockerEvaluationCompartment {
  readonly #name: string;
  readonly #watchdog: ReturnType<typeof spawn>;
  #closed = false;

  private constructor(name: string, watchdog: ReturnType<typeof spawn>) {
    this.#name = name;
    this.#watchdog = watchdog;
  }

  static async open(input: {
    readonly profile: EvaluationExecutionProfile;
    readonly image: string;
    readonly mounts: readonly EvaluationMount[];
    readonly signal: AbortSignal;
  }): Promise<CompartmentOpening> {
    if (decodeEvaluationExecutionProfile(input.profile).kind !== 'Accepted' || input.signal.aborted)
      return { kind: 'ProfileDrift' };
    if (!/^([-a-z0-9./_]+@)?sha256:[a-f0-9]{64}$/u.test(input.image))
      return { kind: 'ProfileDrift' };
    const imageDigest = input.image.slice(input.image.lastIndexOf('@') + 1);
    if (imageDigest !== input.profile.imageDigest) return { kind: 'ProfileDrift' };
    if (
      input.mounts.some(
        (mount) => !mount.hostPath.startsWith('/') || !mount.containerPath.startsWith('/'),
      )
    )
      return { kind: 'ProfileDrift' };
    const name = `devrandom-evaluation-${randomUUID()}`;
    const watchdogPath = fileURLToPath(new URL('./container-watchdog.js', import.meta.url));
    const watchdog = spawn(
      process.execPath,
      [
        watchdogPath,
        String(process.pid),
        name,
        String(Date.now() + input.profile.limits.wallTimeSeconds * 1000 + 5_000),
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_ENV: 'production',
        },
      },
    );
    watchdog.unref();
    const args = [
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      'none',
      '--ipc',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '65534:65534',
      '--pids-limit',
      String(input.profile.limits.processCount),
      '--memory',
      String(input.profile.limits.memoryBytes),
      '--cpus',
      String(input.profile.limits.cpuCount),
      '--tmpfs',
      `/tmp:rw,nosuid,nodev,mode=1777,size=${String(input.profile.limits.scratchBytes)}`,
      '--tmpfs',
      `/work:rw,exec,nosuid,nodev,mode=1777,size=${String(input.profile.limits.scratchBytes)}`,
      '--workdir',
      '/work',
    ];
    for (const mount of input.mounts) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath}${mount.writable ? '' : ',readonly'}`,
      );
    }
    args.push(input.image, 'sleep', String(input.profile.limits.wallTimeSeconds + 5));
    try {
      await runFile('docker', args, { timeout: 30_000, maxBuffer: 4096 });
      const [raw] = await Promise.all([
        runFile('docker', ['inspect', name], { timeout: 10_000, maxBuffer: 64 * 1024 }),
      ]);
      const inspected: unknown = JSON.parse(raw.stdout);
      if (!Array.isArray(inspected) || inspected.length !== 1)
        throw new Error('Docker inspect returned no compartment.');
      const effective = inspected[0] as {
        HostConfig?: {
          NetworkMode?: string;
          IpcMode?: string;
          ReadonlyRootfs?: boolean;
          CapDrop?: string[];
          PidsLimit?: number;
          Memory?: number;
          NanoCpus?: number;
          Privileged?: boolean;
          SecurityOpt?: string[];
          Tmpfs?: Record<string, string>;
        };
        Config?: { User?: string; Image?: string };
        State?: { Running?: boolean };
        Image?: string;
        Mounts?: { Source?: string; Destination?: string; RW?: boolean; Type?: string }[];
      };
      const host = effective.HostConfig;
      const temporary = host?.Tmpfs?.['/tmp'];
      const working = host?.Tmpfs?.['/work'];
      if (
        effective.State?.Running !== true ||
        effective.Image !== imageDigest ||
        host?.NetworkMode !== 'none' ||
        host.IpcMode !== 'none' ||
        host.ReadonlyRootfs !== true ||
        host.Privileged !== false ||
        !host.CapDrop?.includes('ALL') ||
        !host.SecurityOpt?.some((option) => option.includes('no-new-privileges')) ||
        host.PidsLimit !== input.profile.limits.processCount ||
        host.Memory !== input.profile.limits.memoryBytes ||
        host.NanoCpus !== input.profile.limits.cpuCount * 1_000_000_000 ||
        effective.Config?.User !== '65534:65534' ||
        !temporary?.includes('nosuid') ||
        !temporary.includes('nodev') ||
        !working?.includes('nosuid') ||
        !working.includes('nodev') ||
        !input.mounts.every((mount) =>
          effective.Mounts?.some(
            (actual) =>
              actual.Type === 'bind' &&
              actual.Source === mount.hostPath &&
              actual.Destination === mount.containerPath &&
              actual.RW === mount.writable,
          ),
        )
      )
        throw new Error('Effective Docker limits do not match the frozen profile.');
      return {
        kind: 'Opened',
        compartment: new DockerEvaluationCompartment(name, watchdog),
        effectiveLimitsReceipt: raw.stdout,
      };
    } catch {
      try {
        await runFile('docker', ['rm', '-f', name], { timeout: 10_000, maxBuffer: 4096 });
      } catch {
        /* container may never have been created */
      }
      watchdog.kill();
      return { kind: 'ProfileDrift' };
    }
  }

  execute(command: readonly string[]): ChildProcessWithoutNullStreams {
    return this.executeAt('/work', command);
  }

  /** The Run native-effect compartment invokes exact H1 executables from its mounted worktree. */
  executeAt(
    workdir: '/work' | '/work/source',
    command: readonly string[],
    options?: { readonly cargoTargetScratch?: boolean },
  ): ChildProcessWithoutNullStreams {
    if (this.#closed || command.length === 0 || command.some((part) => part.includes('\u0000')))
      throw new Error('Evaluation compartment is closed or command invalid.');
    return spawn(
      'docker',
      [
        'exec',
        '-i',
        '--user',
        '65534:65534',
        '--workdir',
        workdir,
        ...(options?.cargoTargetScratch === true
          ? ['--env', 'CARGO_TARGET_DIR=/work/cargo-target']
          : []),
        this.#name,
        ...command,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NODE_ENV: 'production',
        },
      },
    );
  }

  async copyInto(source: string, destination: string): Promise<void> {
    if (this.#closed || destination !== `/work/${basename(source)}`)
      throw new Error('Invalid compartment copy destination.');
    const archive = spawn('tar', ['-C', dirname(source), '-cf', '-', basename(source)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const receiver = this.execute(['tar', '-C', '/work', '-xf', '-']);
    let archiveError = '';
    let receiverError = '';
    archive.stderr.on('data', (chunk: Buffer) => {
      archiveError += String(chunk);
    });
    receiver.stderr.on('data', (chunk: Buffer) => {
      receiverError += String(chunk);
    });
    archive.stdout.pipe(receiver.stdin);
    const [archiveCode, receiverCode] = await Promise.all([
      new Promise<number | null>((resolve) => archive.once('close', resolve)),
      new Promise<number | null>((resolve) => receiver.once('close', resolve)),
    ]);
    if (archiveCode !== 0 || receiverCode !== 0)
      throw new Error(
        `Contained source transfer failed: ${String(archiveCode)}/${String(receiverCode)} ${archiveError} ${receiverError}`,
      );
  }

  async copyOut(source: string, destination: string): Promise<void> {
    if (this.#closed || !source.startsWith('/work/'))
      throw new Error('Invalid compartment copy source.');
    const sender = this.execute(['cat', source]);
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    sender.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) sender.kill();
    });
    sender.stdout.pipe(output);
    const [exit] = await Promise.all([
      new Promise<number | null>((resolve) => sender.once('close', resolve)),
      new Promise<void>((resolve, reject) => {
        output.once('finish', resolve);
        output.once('error', reject);
      }),
    ]);
    if (exit !== 0 || bytes === 0 || bytes > 32 * 1024 * 1024)
      throw new Error('Contained executable transfer failed.');
  }

  async copyDirectoryOut(source: string, destination: string): Promise<void> {
    if (this.#closed || !/^\/work\/[a-z][a-z0-9-]*$/u.test(source) || !destination.startsWith('/'))
      throw new Error('Invalid compartment directory transfer.');
    try {
      await lstat(destination);
      throw new Error('Compartment destination already exists.');
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const rootName = basename(source);
    const sender = this.execute(['tar', '--format=ustar', '-C', '/work', '-cf', '-', rootName]);
    const chunks: Buffer[] = [];
    let length = 0;
    let error = '';
    sender.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) sender.kill();
      else chunks.push(chunk);
    });
    sender.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString('utf8').slice(0, 4096);
    });
    const exit = await new Promise<number | null>((resolveExit) =>
      sender.once('close', resolveExit),
    );
    if (exit !== 0 || length > 32 * 1024 * 1024)
      throw new Error(`Contained source archive failed: ${error}`);
    const archive = Buffer.concat(chunks);
    const entries: { path: string; directory: boolean; bytes: Buffer }[] = [];
    const seen = new Set<string>();
    let offset = 0;
    const field = (block: Buffer, start: number, size: number): string => {
      const bytes = block.subarray(start, start + size);
      const zero = bytes.indexOf(0);
      return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('utf8');
    };
    while (offset + 512 <= archive.length) {
      const block = archive.subarray(offset, offset + 512);
      offset += 512;
      if (block.every((byte) => byte === 0)) break;
      if (!field(block, 257, 6).startsWith('ustar'))
        throw new Error('Contained source archive format invalid.');
      const sizeText = field(block, 124, 12).trim();
      if (!/^[0-7]+$/u.test(sizeText)) throw new Error('Contained source archive size invalid.');
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isSafeInteger(size) || offset + size > archive.length)
        throw new Error('Contained source archive truncated.');
      const prefix = field(block, 345, 155);
      const name = field(block, 0, 100);
      const path = `${prefix ? `${prefix}/` : ''}${name}`.replace(/\/$/u, '');
      const relative =
        path === rootName
          ? ''
          : path.startsWith(`${rootName}/`)
            ? path.slice(rootName.length + 1)
            : undefined;
      if (
        relative === undefined ||
        seen.has(path) ||
        relative.split('/').some(
          (part) =>
            part === '.' ||
            part === '..' ||
            (relative !== '' && part === '') ||
            part.includes('\\') ||
            Array.from(part).some((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code < 32 || code === 127;
            }),
        )
      )
        throw new Error('Contained source archive path invalid.');
      seen.add(path);
      const type = block[156];
      if (type !== 0 && type !== 48 && type !== 53)
        throw new Error('Contained source archive entry unsafe.');
      if (type === 53 && size !== 0) throw new Error('Contained source archive directory invalid.');
      if (relative !== '')
        entries.push({
          path: relative,
          directory: type === 53,
          bytes: archive.subarray(offset, offset + size),
        });
      offset += Math.ceil(size / 512) * 512;
    }
    if (!seen.has(rootName)) throw new Error('Contained source archive root missing.');
    await mkdir(destination, { mode: 0o700 });
    for (const entry of entries) {
      const path = join(destination, entry.path);
      if (entry.directory) await mkdir(path, { recursive: true, mode: 0o700 });
      else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, entry.bytes, { flag: 'wx', mode: 0o600 });
      }
    }
  }

  async prepareCopiedSource(path: string): Promise<void> {
    if (this.#closed || !path.startsWith('/work/')) throw new Error('Invalid copied source path.');
    const command = this.execute(['chmod', '-R', 'u+rwX', path]);
    const code = await new Promise<number | null>((resolve) => command.once('close', resolve));
    if (code !== 0) throw new Error('Contained source mode preparation failed.');
  }

  /** Stop every remaining non-init process before a provisional C2 source capture.
   * PID 1 is the compartment's inert sleep process; no worker can restart once
   * the second independent /proc inspection observes only it. */
  async stopWriters(): Promise<boolean> {
    if (this.#closed) return false;
    const script = `const fs=require('node:fs');const self=process.pid;for(const name of fs.readdirSync('/proc')){const pid=Number(name);if(!Number.isInteger(pid)||pid<=1||pid===self)continue;try{process.kill(pid,'SIGKILL')}catch{}}`;
    const inspect = `const fs=require('node:fs');const self=process.pid;const others=fs.readdirSync('/proc').map(Number).filter(pid=>{if(!Number.isInteger(pid)||pid<=1||pid===self)return false;try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2)[0]!=='Z'}catch{return false}});if(others.length)process.exit(3)`;
    try {
      await runFile('docker', ['exec', '--user', '65534:65534', this.#name, 'node', '-e', script], {
        timeout: 10_000,
        maxBuffer: 4096,
      });
      await runFile(
        'docker',
        ['exec', '--user', '65534:65534', this.#name, 'node', '-e', inspect],
        {
          timeout: 10_000,
          maxBuffer: 4096,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<boolean> {
    if (this.#closed) return true;
    this.#closed = true;
    try {
      await runFile('docker', ['rm', '-f', this.#name], { timeout: 10_000, maxBuffer: 4096 });
      const inspection = await runFile(
        'docker',
        ['ps', '-a', '--filter', `name=^/${this.#name}$`, '--format', '{{.ID}}'],
        { timeout: 10_000, maxBuffer: 4096 },
      );
      this.#watchdog.kill();
      return inspection.stdout.trim() === '';
    } catch {
      return false;
    }
  }
}
