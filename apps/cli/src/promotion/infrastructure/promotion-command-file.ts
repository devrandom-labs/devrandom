import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { decodeActivationCommitCommand, type ActivationCommitCommand } from '@devrandom/protocol';
import type { PromotionCommands } from '@devrandom/runtime';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumBytes = 32 * 1024;

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function exists(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}

/** Crash-safe exact command custody before any hosted activation request. */
export class PromotionCommandFile implements PromotionCommands {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async inspect(commandId: string): ReturnType<PromotionCommands['inspect']> {
    if (!isAbsolute(this.#directory) || !uuid.test(commandId)) return { kind: 'Unavailable' };
    try {
      await this.#checkDirectory(false);
      const command = await this.#read(commandId);
      return command.commandId === commandId
        ? { kind: 'Staged', command }
        : { kind: 'Unavailable' };
    } catch (cause) {
      return { kind: absent(cause) ? 'Absent' : 'Unavailable' };
    }
  }

  async stage(command: ActivationCommitCommand): ReturnType<PromotionCommands['stage']> {
    if (!isAbsolute(this.#directory) || decodeActivationCommitCommand(command).kind !== 'Accepted')
      return 'Unavailable';
    const bytes = Buffer.from(JSON.stringify(command), 'utf8');
    if (bytes.byteLength > maximumBytes) return 'Unavailable';
    try {
      await this.#checkDirectory(true);
      const prior = await this.inspect(command.commandId);
      if (prior.kind === 'Staged')
        return JSON.stringify(prior.command) === bytes.toString('utf8') ? 'Same' : 'Conflict';
      if (prior.kind === 'Unavailable') return 'Unavailable';
      const temporary = `${this.#path(command.commandId)}.${String(process.pid)}.${randomUUID()}.tmp`;
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, this.#path(command.commandId));
        } catch (cause) {
          if (!exists(cause)) throw cause;
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const stored = await this.inspect(command.commandId);
      if (stored.kind !== 'Staged') return 'Unavailable';
      return JSON.stringify(stored.command) === bytes.toString('utf8') ? 'Staged' : 'Conflict';
    } catch {
      return 'Unavailable';
    }
  }

  async #checkDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = await directory.stat();
      if (
        !status.isDirectory() ||
        (status.mode & 0o777) !== 0o700 ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new Error('Promotion command directory custody invalid');
    } finally {
      await directory.close();
    }
  }

  async #read(commandId: string): Promise<ActivationCommitCommand> {
    const file = await open(this.#path(commandId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = await file.stat();
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        status.size < 2 ||
        status.size > maximumBytes ||
        (status.mode & 0o777) !== 0o600 ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new Error('Promotion command custody invalid');
      const bytes = await file.readFile();
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const decoded = decodeActivationCommitCommand(parsed);
      if (decoded.kind !== 'Accepted' || JSON.stringify(decoded.command) !== bytes.toString('utf8'))
        throw new Error('Promotion command bytes invalid');
      return decoded.command;
    } finally {
      await file.close();
    }
  }

  #path(commandId: string): string {
    return join(this.#directory, `${commandId}.json`);
  }
}
