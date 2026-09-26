import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import { ProtectedCredentials } from '@devrandom/domain';
import { identifyCheckpointFileContent } from '@devrandom/protocol';

import type {
  CheckpointRepository,
  CheckpointRepositoryCapture,
} from '../application/verified-run-checkpoint.js';
import type { PreparedRunWorktree } from '../application/run-worktree.js';
import type {
  ProposedWorktreeWrite,
  WorktreeWriteInspection,
} from '../application/worktree-write-admission.js';

type GitOutput =
  | { readonly kind: 'Completed'; readonly bytes: Uint8Array }
  | { readonly kind: 'LimitExceeded' }
  | { readonly kind: 'Failed' };

type ChangedPath =
  | {
      readonly kind: 'Tracked';
      readonly path: string;
      readonly disposition:
        'Added' | 'Modified' | 'Deleted' | 'Renamed' | 'TypeChanged' | 'Unmerged';
      readonly mode: string;
      readonly content: { readonly kind: 'Base' } | { readonly kind: 'Worktree' };
    }
  | { readonly kind: 'Untracked'; readonly path: string };

type ChangedPathParsing =
  | { readonly kind: 'Parsed'; readonly changes: readonly ChangedPath[] }
  | { readonly kind: 'ChangedFileLimitExceeded' }
  | { readonly kind: 'Invalid' };

type FileContent =
  | { readonly kind: 'Read'; readonly bytes: Uint8Array; readonly mode: string }
  | { readonly kind: 'LimitExceeded' }
  | { readonly kind: 'Unavailable' };

const maximumChangedFiles = 256;
const maximumChangedWorktreeBytes = 16 * 1024 * 1024;
const relativePathPattern = new RegExp(
  '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))[^/]+(?:/[^/]+)*$',
  'u',
);
const modePattern = /^[0-7]{6}$/u;

function gitOutput(
  directory: string,
  arguments_: readonly string[],
  maximumBytes: number,
  signal: AbortSignal,
): Promise<GitOutput> {
  if (signal.aborted) return Promise.resolve({ kind: 'Failed' });
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...arguments_], {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        NODE_ENV: 'production',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_LITERAL_PATHSPECS: '1',
      },
    });
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let disposition: 'Running' | 'Failed' | 'LimitExceeded' = 'Running';
    const terminate = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      // Escaped descendants must not keep the direct child's output pipe open.
      child.stdout.destroy();
    };
    const fail = (): void => {
      if (disposition === 'Running') disposition = 'Failed';
      terminate();
    };
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    child.stdout.on('data', (chunk: unknown) => {
      if (disposition !== 'Running') return;
      if (!Buffer.isBuffer(chunk)) {
        fail();
        return;
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        disposition = 'LimitExceeded';
        terminate();
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', fail);
    child.on('error', fail);
    child.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', fail);
      if (disposition === 'LimitExceeded') {
        resolve({ kind: 'LimitExceeded' });
      } else if (disposition === 'Failed' || code !== 0 || terminationSignal !== null) {
        resolve({ kind: 'Failed' });
      } else {
        resolve({ kind: 'Completed', bytes: Buffer.concat(chunks, byteLength) });
      }
    });
  });
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function gitValue(
  directory: string,
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const output = await gitOutput(directory, arguments_, 4 * 1024, signal);
  if (output.kind !== 'Completed') return undefined;
  return utf8(output.bytes)?.trim();
}

async function gitRecord(
  directory: string,
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const output = await gitOutput(directory, arguments_, 4 * 1024, signal);
  if (output.kind !== 'Completed') return undefined;
  const text = utf8(output.bytes);
  if (text === '') return '';
  return text !== undefined && text.endsWith('\0') && text.indexOf('\0') === text.length - 1
    ? text.slice(0, -1)
    : undefined;
}

function pathIsValid(path: string): boolean {
  if (!relativePathPattern.test(path)) return false;
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return false;
    }
  }
  return new TextEncoder().encode(path).byteLength <= 512;
}

function fields(record: string, fieldCount: number): readonly string[] | undefined {
  const parsed: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(' ', start);
    if (separator < 0) return undefined;
    parsed.push(record.slice(start, separator));
    start = separator + 1;
  }
  parsed.push(record.slice(start));
  return parsed;
}

function ordinaryDisposition(
  status: string,
): Extract<ChangedPath, { readonly kind: 'Tracked' }>['disposition'] | undefined {
  if (status.includes('U')) return 'Unmerged';
  if (status.includes('D')) return 'Deleted';
  if (status.includes('T')) return 'TypeChanged';
  if (status.includes('A')) return 'Added';
  if (status.includes('M')) return 'Modified';
  return undefined;
}

function parseChangedPaths(status: string, limit: number): ChangedPathParsing {
  const records = status.split('\u0000');
  if (records.at(-1) === '') records.pop();
  const changes: ChangedPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) return { kind: 'Invalid' };
    if (record.startsWith('? ') || record.startsWith('! ')) {
      const path = record.slice(2);
      if (!pathIsValid(path)) return { kind: 'Invalid' };
      changes.push({ kind: 'Untracked', path });
    } else if (record.startsWith('1 ')) {
      const parsed = fields(record, 8);
      const statusCode = parsed?.[1];
      const mode = parsed?.[5];
      const path = parsed?.[8];
      const disposition = statusCode === undefined ? undefined : ordinaryDisposition(statusCode);
      if (
        disposition === undefined ||
        mode === undefined ||
        path === undefined ||
        !modePattern.test(mode) ||
        !pathIsValid(path)
      ) {
        return { kind: 'Invalid' };
      }
      changes.push({
        kind: 'Tracked',
        path,
        disposition,
        mode,
        content: disposition === 'Deleted' ? { kind: 'Base' } : { kind: 'Worktree' },
      });
    } else if (record.startsWith('2 ')) {
      const parsed = fields(record, 9);
      const statusCode = parsed?.[1];
      const mode = parsed?.[5];
      const score = parsed?.[8];
      const path = parsed?.[9];
      const originalPath = records[index + 1];
      if (
        statusCode === undefined ||
        mode === undefined ||
        score === undefined ||
        path === undefined ||
        originalPath === undefined ||
        !modePattern.test(mode) ||
        !pathIsValid(path) ||
        !pathIsValid(originalPath) ||
        (!score.startsWith('R') && !score.startsWith('C'))
      ) {
        return { kind: 'Invalid' };
      }
      changes.push({
        kind: 'Tracked',
        path,
        disposition: score.startsWith('R') ? 'Renamed' : 'Added',
        mode,
        content: { kind: 'Worktree' },
      });
      index += 1;
    } else if (record.startsWith('u ')) {
      const parsed = fields(record, 10);
      const mode = parsed?.[6];
      const path = parsed?.[10];
      if (
        mode === undefined ||
        path === undefined ||
        !modePattern.test(mode) ||
        !pathIsValid(path)
      ) {
        return { kind: 'Invalid' };
      }
      changes.push({
        kind: 'Tracked',
        path,
        disposition: 'Unmerged',
        mode,
        content: { kind: 'Worktree' },
      });
    } else {
      return { kind: 'Invalid' };
    }
    if (changes.length > limit) return { kind: 'ChangedFileLimitExceeded' };
  }
  return { kind: 'Parsed', changes };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function currentContent(
  directory: string,
  change: ChangedPath,
  maximumBytes: number,
): Promise<FileContent> {
  const path = `${directory}/${change.path}`;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      const bytes = new TextEncoder().encode(await readlink(path));
      return bytes.byteLength <= maximumBytes
        ? { kind: 'Read', bytes, mode: '120000' }
        : { kind: 'LimitExceeded' };
    }
    if (!before.isFile() || before.size > maximumBytes) {
      return before.isFile() ? { kind: 'LimitExceeded' } : { kind: 'Unavailable' };
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size
      ) {
        return { kind: 'Unavailable' };
      }
      const bytes = await handle.readFile();
      const mode = (after.mode & 0o111) === 0 ? '100644' : '100755';
      return { kind: 'Read', bytes, mode };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: 'Unavailable' };
  }
}

async function baseContent(
  worktree: PreparedRunWorktree,
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<FileContent> {
  const object = `${worktree.repository.commit}:${path}`;
  const sizeValue = await gitValue(worktree.directory, ['cat-file', '-s', object], signal);
  if (sizeValue === undefined || !/^\d+$/u.test(sizeValue)) return { kind: 'Unavailable' };
  const size = Number(sizeValue);
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'Unavailable' };
  if (size > maximumBytes) return { kind: 'LimitExceeded' };
  const output = await gitOutput(worktree.directory, ['show', object], maximumBytes, signal);
  return output.kind === 'Completed'
    ? { kind: 'Read', bytes: output.bytes, mode: '000000' }
    : output.kind === 'LimitExceeded'
      ? { kind: 'LimitExceeded' }
      : { kind: 'Unavailable' };
}

async function worktreeBindingMatches(
  worktree: PreparedRunWorktree,
  signal: AbortSignal,
): Promise<boolean> {
  const [topLevel, branch, objectFormat, commit, tree] = await Promise.all([
    gitValue(worktree.directory, ['rev-parse', '--show-toplevel'], signal),
    gitValue(worktree.directory, ['branch', '--show-current'], signal),
    gitValue(worktree.directory, ['rev-parse', '--show-object-format'], signal),
    gitValue(worktree.directory, ['rev-parse', 'HEAD'], signal),
    gitValue(worktree.directory, ['rev-parse', 'HEAD^{tree}'], signal),
  ]);
  if (
    topLevel === undefined ||
    branch === undefined ||
    objectFormat === undefined ||
    commit === undefined ||
    tree === undefined
  ) {
    return false;
  }
  try {
    return (
      (await realpath(topLevel)) === (await realpath(worktree.directory)) &&
      branch === worktree.branch &&
      objectFormat === worktree.repository.objectFormat &&
      commit === worktree.repository.commit &&
      tree === worktree.repository.tree
    );
  } catch {
    return false;
  }
}

type RepositoryMeasurement =
  | Exclude<CheckpointRepositoryCapture, { readonly kind: 'Captured' }>
  | (Extract<CheckpointRepositoryCapture, { readonly kind: 'Captured' }> & {
      readonly fileBytes: ReadonlyMap<string, number>;
    });

export class GitWorktreeChanges implements CheckpointRepository {
  readonly #credentials: ProtectedCredentials;

  constructor(credentials = new ProtectedCredentials()) {
    this.#credentials = credentials;
  }

  async capture(
    worktree: PreparedRunWorktree,
    limits: { readonly changedFiles: number; readonly changedWorktreeBytes: number },
    signal?: AbortSignal,
  ): Promise<CheckpointRepositoryCapture> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(signal === undefined ? [] : [signal]),
    ]);
    const measured = await this.#measure(worktree, limits, deadline);
    signal?.throwIfAborted();
    if (deadline.aborted) return { kind: 'GitUnavailable' };
    return measured.kind === 'Captured'
      ? {
          kind: 'Captured',
          repository: measured.repository,
          changedWorktreeBytes: measured.changedWorktreeBytes,
        }
      : measured;
  }

  async inspectWrite(
    worktree: PreparedRunWorktree,
    limits: { readonly changedFiles: number; readonly changedWorktreeBytes: number },
    write: ProposedWorktreeWrite,
    signal: AbortSignal,
  ): Promise<WorktreeWriteInspection> {
    signal.throwIfAborted();
    const inspectionSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    if (!isAbsolute(write.path)) return { kind: 'DependencyUnavailable' };
    const path = relative(await realpath(worktree.directory), write.path)
      .split(sep)
      .join('/');
    if (!pathIsValid(path)) return { kind: 'DependencyUnavailable' };
    const measured = await this.#measure(worktree, limits, inspectionSignal);
    signal.throwIfAborted();
    if (measured.kind === 'WithheldSecret') return measured;
    if (
      measured.kind === 'ChangedFileLimitExceeded' ||
      measured.kind === 'ChangedWorktreeLimitExceeded'
    )
      return { kind: 'BudgetExhausted' };
    if (measured.kind !== 'Captured') return { kind: 'DependencyUnavailable' };
    let mode = '100644';
    try {
      const metadata = await lstat(write.path);
      if (!metadata.isFile() || metadata.nlink !== 1) return { kind: 'DependencyUnavailable' };
      mode = (metadata.mode & 0o111) === 0 ? '100644' : '100755';
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
        return { kind: 'DependencyUnavailable' };
    }
    signal.throwIfAborted();
    const base = await gitRecord(
      worktree.directory,
      ['ls-tree', '-z', worktree.repository.commit, '--', path],
      inspectionSignal,
    );
    const index = await gitRecord(
      worktree.directory,
      ['ls-files', '-z', '--stage', '--', path],
      inspectionSignal,
    );
    signal.throwIfAborted();
    if (base === undefined || index === undefined) return { kind: 'DependencyUnavailable' };
    const baseEntry = /^([0-7]{6}) blob ([0-9a-f]+)\t(.+)$/u.exec(base);
    let disposition: 'Changed' | 'Unchanged' = 'Changed';
    if (
      baseEntry !== null &&
      baseEntry[1] === mode &&
      baseEntry[3] === path &&
      index === `${mode} ${baseEntry[2] ?? ''} 0\t${path}`
    ) {
      const original = await baseContent(worktree, path, write.bytes.byteLength, inspectionSignal);
      signal.throwIfAborted();
      if (original.kind === 'Unavailable') return { kind: 'DependencyUnavailable' };
      if (original.kind === 'Read' && Buffer.from(original.bytes).equals(write.bytes))
        disposition = 'Unchanged';
    }
    const priorBytes = measured.fileBytes.get(path);
    const nextCount =
      measured.fileBytes.size -
      (priorBytes === undefined ? 0 : 1) +
      (disposition === 'Changed' ? 1 : 0);
    const nextBytes =
      measured.changedWorktreeBytes -
      (priorBytes ?? 0) +
      (disposition === 'Changed' ? write.bytes.byteLength : 0);
    signal.throwIfAborted();
    if (inspectionSignal.aborted) return { kind: 'DependencyUnavailable' };
    return { kind: 'Projected', changedFiles: nextCount, changedWorktreeBytes: nextBytes };
  }

  async #measure(
    worktree: PreparedRunWorktree,
    limits: { readonly changedFiles: number; readonly changedWorktreeBytes: number },
    signal: AbortSignal,
  ): Promise<RepositoryMeasurement> {
    if (
      !isAbsolute(worktree.directory) ||
      !Number.isSafeInteger(limits.changedFiles) ||
      !Number.isSafeInteger(limits.changedWorktreeBytes) ||
      limits.changedFiles < 0 ||
      limits.changedFiles > maximumChangedFiles ||
      limits.changedWorktreeBytes < 0 ||
      limits.changedWorktreeBytes > maximumChangedWorktreeBytes ||
      !(await worktreeBindingMatches(worktree, signal))
    ) {
      return { kind: 'RepositoryBindingRejected' };
    }
    const statusLimit = Math.max(1_024, limits.changedFiles * 2_048 + 1_024);
    const statusOutput = await gitOutput(
      worktree.directory,
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignored=traditional',
        '--find-renames=50%',
      ],
      statusLimit,
      signal,
    );
    if (statusOutput.kind === 'LimitExceeded') return { kind: 'ChangedFileLimitExceeded' };
    if (statusOutput.kind === 'Failed') return { kind: 'GitUnavailable' };
    const status = utf8(statusOutput.bytes);
    if (status === undefined) return { kind: 'GitUnavailable' };
    const parsed = parseChangedPaths(status, limits.changedFiles);
    if (parsed.kind === 'ChangedFileLimitExceeded') {
      return { kind: 'ChangedFileLimitExceeded' };
    }
    if (parsed.kind === 'Invalid') return { kind: 'GitUnavailable' };

    const sorted = [...parsed.changes].sort((left, right) => compareUtf8(left.path, right.path));
    const seen = new Set<string>();
    const changedFiles: Extract<
      CheckpointRepositoryCapture,
      { readonly kind: 'Captured' }
    >['repository']['changedFiles'][number][] = [];
    const fileBytes = new Map<string, number>();
    let changedWorktreeBytes = 0;
    for (const change of sorted) {
      if (signal.aborted) return { kind: 'GitUnavailable' };
      if (seen.has(change.path)) return { kind: 'GitUnavailable' };
      seen.add(change.path);
      const pathDisclosure = this.#credentials.inspect(new TextEncoder().encode(change.path));
      if (pathDisclosure.kind === 'WithheldSecret') return pathDisclosure;
      const remaining = limits.changedWorktreeBytes - changedWorktreeBytes;
      const content =
        change.kind === 'Tracked' && change.content.kind === 'Base'
          ? await baseContent(worktree, change.path, remaining, signal)
          : await currentContent(worktree.directory, change, remaining);
      if (content.kind === 'LimitExceeded') return { kind: 'ChangedWorktreeLimitExceeded' };
      if (content.kind === 'Unavailable') return { kind: 'GitUnavailable' };
      const contentDisclosure = this.#credentials.inspect(content.bytes);
      if (contentDisclosure.kind === 'WithheldSecret') return contentDisclosure;
      if (
        change.kind === 'Tracked' &&
        change.content.kind === 'Worktree' &&
        change.mode !== content.mode
      ) {
        return { kind: 'GitUnavailable' };
      }
      const identified = identifyCheckpointFileContent(content.bytes);
      if (identified.kind !== 'Identified') return { kind: 'GitUnavailable' };
      changedWorktreeBytes += identified.byteLength;
      fileBytes.set(change.path, identified.byteLength);
      changedFiles.push({
        path: change.path,
        disposition: change.kind === 'Untracked' ? 'Added' : change.disposition,
        mode: change.kind === 'Untracked' ? content.mode : change.mode,
        contentSaid: identified.contentSaid,
      });
    }
    return {
      kind: 'Captured',
      repository: {
        objectFormat: worktree.repository.objectFormat,
        baseCommit: worktree.repository.commit,
        baseTree: worktree.repository.tree,
        changedFiles,
      },
      changedWorktreeBytes,
      fileBytes,
    };
  }
}
