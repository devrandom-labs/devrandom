import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ManagedWorktreeInstructionInspection,
  ManagedWorktreeInstructions,
  MaterializedInstruction,
} from '../application/baseline-execution-inputs.js';

type GitInvocation =
  | { readonly kind: 'Completed'; readonly bytes: Uint8Array }
  | { readonly kind: 'OutputLimitExceeded' }
  | { readonly kind: 'Unavailable' };

type InstructionReading =
  | { readonly kind: 'Read'; readonly instruction: MaterializedInstruction }
  | Extract<
      ManagedWorktreeInstructionInspection,
      {
        readonly kind:
          | 'UnsafeInstructionPath'
          | 'InstructionUnavailable'
          | 'InstructionContentLimitExceeded'
          | 'InstructionEncodingInvalid';
      }
    >;

const maximumInstructionCount = 64;
const maximumInstructionBytes = 131_072;
const maximumInventoryBytes = 1_048_576;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function runGit(
  directory: string,
  arguments_: readonly string[],
  maximumBytes: number,
  signal: AbortSignal,
): Promise<GitInvocation> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn('git', arguments_, {
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
      },
    });
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let disposition: 'Running' | 'OutputLimitExceeded' | 'Unavailable' = 'Running';
    const terminate = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      child.stdout.destroy();
    };
    const interrupted = (): void => {
      disposition = 'Unavailable';
      terminate();
    };
    signal.addEventListener('abort', interrupted, { once: true });
    child.stdout.on('data', (chunk: unknown) => {
      if (disposition !== 'Running') return;
      if (!Buffer.isBuffer(chunk)) {
        disposition = 'Unavailable';
        terminate();
        return;
      }
      byteLength += chunk.byteLength;
      if (byteLength > maximumBytes) {
        disposition = 'OutputLimitExceeded';
        terminate();
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', interrupted);
    child.on('error', interrupted);
    child.on('close', (code) => {
      signal.removeEventListener('abort', interrupted);
      switch (disposition) {
        case 'OutputLimitExceeded':
          resolve({ kind: 'OutputLimitExceeded' });
          break;
        case 'Unavailable':
          resolve({ kind: 'Unavailable' });
          break;
        case 'Running':
          resolve(
            code === 0
              ? { kind: 'Completed', bytes: Buffer.concat(chunks, byteLength) }
              : { kind: 'Unavailable' },
          );
          break;
      }
    });
  });
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

async function gitText(
  directory: string,
  arguments_: readonly string[],
  maximumBytes: number,
  signal: AbortSignal,
): Promise<GitInvocation | { readonly kind: 'Decoded'; readonly text: string }> {
  const invocation = await runGit(directory, arguments_, maximumBytes, signal);
  signal.throwIfAborted();
  if (invocation.kind !== 'Completed') return invocation;
  const text = decode(invocation.bytes);
  return text === undefined ? { kind: 'Unavailable' } : { kind: 'Decoded', text };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte !== undefined && rightByte !== undefined && leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function instructionPathIsSafe(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    utf8Encoder.encode(path).byteLength > 512
  ) {
    return false;
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      return false;
    }
  }
  return path === 'AGENTS.md' || path.endsWith('/AGENTS.md');
}

function inventoryPaths(text: string): readonly string[] | undefined {
  if (text.length === 0) return [];
  const records = text.split('\u0000');
  if (records.at(-1) !== '') return undefined;
  records.pop();
  return records;
}

async function readInstruction(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<InstructionReading> {
  signal.throwIfAborted();
  if (!instructionPathIsSafe(path)) {
    return { kind: 'UnsafeInstructionPath', path };
  }
  const segments = path.split('/');
  let candidate = root;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      signal.throwIfAborted();
      const segment = segments[index];
      if (segment === undefined) return { kind: 'UnsafeInstructionPath', path };
      candidate = join(candidate, segment);
      const status = await lstat(candidate);
      signal.throwIfAborted();
      const final = index === segments.length - 1;
      if (status.isSymbolicLink() || (final ? !status.isFile() : !status.isDirectory())) {
        return { kind: 'UnsafeInstructionPath', path };
      }
      if (!final) continue;
      if (!Number.isSafeInteger(status.size) || status.size < 1) {
        return { kind: 'InstructionUnavailable', path };
      }
      if (status.size > maximumInstructionBytes) {
        return { kind: 'InstructionContentLimitExceeded', path };
      }
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        signal.throwIfAborted();
        const openedStatus = await handle.stat();
        signal.throwIfAborted();
        if (
          !openedStatus.isFile() ||
          openedStatus.dev !== status.dev ||
          openedStatus.ino !== status.ino
        ) {
          return { kind: 'UnsafeInstructionPath', path };
        }
        const content = Buffer.alloc(maximumInstructionBytes + 1);
        let offset = 0;
        while (offset < content.byteLength) {
          signal.throwIfAborted();
          const reading = await handle.read(content, offset, content.byteLength - offset, offset);
          signal.throwIfAborted();
          if (reading.bytesRead === 0) break;
          offset += reading.bytesRead;
        }
        if (offset > maximumInstructionBytes) {
          return { kind: 'InstructionContentLimitExceeded', path };
        }
        const finalStatus = await handle.stat();
        signal.throwIfAborted();
        if (
          finalStatus.dev !== status.dev ||
          finalStatus.ino !== status.ino ||
          finalStatus.size !== offset
        ) {
          return { kind: 'InstructionUnavailable', path };
        }
        const decoded = decode(content.subarray(0, offset));
        return decoded === undefined
          ? { kind: 'InstructionEncodingInvalid', path }
          : { kind: 'Read', instruction: { path, content: decoded } };
      } finally {
        await handle.close();
      }
    }
  } catch {
    return { kind: 'InstructionUnavailable', path };
  }
  return { kind: 'InstructionUnavailable', path };
}

async function repositoryBindingMatches(
  worktree: Parameters<ManagedWorktreeInstructions['inspect']>[0]['worktree'],
  signal: AbortSignal,
): Promise<'Matches' | 'Mismatch' | 'Unavailable'> {
  signal.throwIfAborted();
  const directory = await realpath(worktree.directory).catch(() => undefined);
  signal.throwIfAborted();
  if (directory === undefined) return 'Unavailable';
  const queries = [
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--show-object-format'],
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['rev-parse', '--verify', 'HEAD^{tree}'],
  ] as const;
  const values: string[] = [];
  for (const query of queries) {
    const result = await gitText(directory, query, 4_096, signal);
    if (result.kind !== 'Decoded') return 'Unavailable';
    values.push(result.text.trim());
  }
  const topLevel = values[0];
  if (topLevel === undefined) return 'Unavailable';
  const topLevelRealpath = await realpath(topLevel).catch(() => undefined);
  signal.throwIfAborted();
  if (topLevelRealpath === undefined) return 'Unavailable';
  return topLevelRealpath === directory &&
    values[1] === worktree.repository.objectFormat &&
    values[2] === worktree.repository.commit &&
    values[3] === worktree.repository.tree
    ? 'Matches'
    : 'Mismatch';
}

export class GitWorktreeInstructions implements ManagedWorktreeInstructions {
  async inspect(
    input: Parameters<ManagedWorktreeInstructions['inspect']>[0],
    signal: AbortSignal,
  ): Promise<ManagedWorktreeInstructionInspection> {
    try {
      signal.throwIfAborted();
      const inspected = await this.#inspect(input, signal);
      signal.throwIfAborted();
      return inspected;
    } catch {
      return signal.aborted ? { kind: 'Interrupted' } : { kind: 'RepositoryUnavailable' };
    }
  }

  async #inspect(
    input: Parameters<ManagedWorktreeInstructions['inspect']>[0],
    signal: AbortSignal,
  ): Promise<ManagedWorktreeInstructionInspection> {
    const binding = await repositoryBindingMatches(input.worktree, signal);
    signal.throwIfAborted();
    if (binding === 'Mismatch') return { kind: 'RepositoryBindingMismatch' };
    if (binding === 'Unavailable') return { kind: 'RepositoryUnavailable' };
    const root = await realpath(input.worktree.directory).catch(() => undefined);
    signal.throwIfAborted();
    if (root === undefined) return { kind: 'RepositoryUnavailable' };
    const trackedAndUntracked = await gitText(
      root,
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      maximumInventoryBytes,
      signal,
    );
    const ignored = await gitText(
      root,
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
      maximumInventoryBytes,
      signal,
    );
    if (
      trackedAndUntracked.kind === 'OutputLimitExceeded' ||
      ignored.kind === 'OutputLimitExceeded'
    ) {
      return { kind: 'InventoryLimitExceeded' };
    }
    if (trackedAndUntracked.kind !== 'Decoded' || ignored.kind !== 'Decoded') {
      return { kind: 'RepositoryUnavailable' };
    }
    const ordinaryPaths = inventoryPaths(trackedAndUntracked.text);
    const ignoredPaths = inventoryPaths(ignored.text);
    if (ordinaryPaths === undefined || ignoredPaths === undefined) {
      return { kind: 'RepositoryUnavailable' };
    }
    const paths = [...new Set([...ordinaryPaths, ...ignoredPaths])]
      .filter((path) => path === 'AGENTS.md' || path.endsWith('/AGENTS.md'))
      .sort(compareUtf8);
    if (paths.length > maximumInstructionCount) {
      return { kind: 'InventoryLimitExceeded' };
    }
    if (
      paths.length !== input.expectedPaths.length ||
      paths.some((path, index) => path !== input.expectedPaths[index])
    ) {
      return { kind: 'InventoryMismatch' };
    }
    const instructions: MaterializedInstruction[] = [];
    for (const path of paths) {
      const reading = await readInstruction(root, path, signal);
      if (reading.kind !== 'Read') return reading;
      instructions.push(reading.instruction);
    }
    return { kind: 'Inspected', instructions };
  }
}
