import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  decodeHarnessPackage,
  privateHarnessForkSchema,
  publishHarnessCommandSchema,
  publishedHarnessSchema,
  type PrivateHarnessFork,
  type PublishHarnessCommand,
  type PublishedHarness,
} from '@devrandom/protocol';
import Value from 'typebox/value';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function read(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 300000)
        throw new Error('Publication custody rejected');
      const document: unknown = JSON.parse(await file.readFile('utf8'));
      return document;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function retain(directory: string, name: string, value: unknown): Promise<unknown> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700)
    throw new Error('Publication directory rejected');
  const path = join(directory, name);
  const temporary = join(directory, `${name}.${randomUUID()}.pending`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  } finally {
    await unlink(temporary);
  }
  const directoryFile = await open(directory, constants.O_RDONLY);
  try {
    await directoryFile.sync();
  } finally {
    await directoryFile.close();
  }
  return read(path);
}
/** Local immutable command/verified-package custody, never an active pointer or a task/mandate model. */
export class PrivatePublicationFiles {
  readonly #root: string;
  constructor(stateRoot: string) {
    if (!isAbsolute(stateRoot)) throw new Error('Absolute publication root required');
    this.#root = join(stateRoot, 'publications');
  }
  async command(commandId: string): Promise<PublishHarnessCommand | undefined> {
    if (!uuid.test(commandId)) return undefined;
    const value = await read(join(this.#root, 'commands', `${commandId}.json`));
    return Value.Check(publishHarnessCommandSchema, value) && value.commandId === commandId
      ? value
      : undefined;
  }
  async stage(command: PublishHarnessCommand): Promise<'Staged' | 'Conflict'> {
    if (!Value.Check(publishHarnessCommandSchema, command)) return 'Conflict';
    const retained = await retain(
      join(this.#root, 'commands'),
      `${command.commandId}.json`,
      command,
    );
    return JSON.stringify(retained) === JSON.stringify(command) ? 'Staged' : 'Conflict';
  }
  async retainVerified(published: PublishedHarness): Promise<'Retained' | 'Conflict'> {
    if (
      !Value.Check(publishedHarnessSchema, published) ||
      decodeHarnessPackage(published.package).kind !== 'Accepted'
    )
      return 'Conflict';
    const retained = await retain(
      join(this.#root, 'packages'),
      `${published.package.d}.json`,
      published,
    );
    return JSON.stringify(retained) === JSON.stringify(published) ? 'Retained' : 'Conflict';
  }
  async package(packageSaid: string): Promise<PublishedHarness | undefined> {
    if (!said.test(packageSaid)) return undefined;
    const value = await read(join(this.#root, 'packages', `${packageSaid}.json`));
    return Value.Check(publishedHarnessSchema, value) &&
      decodeHarnessPackage(value.package).kind === 'Accepted' &&
      value.package.d === packageSaid
      ? value
      : undefined;
  }
  async fork(
    packageSaid: string,
    commandId: string,
  ): Promise<
    { readonly kind: 'Forked'; readonly fork: PrivateHarnessFork } | { readonly kind: 'Rejected' }
  > {
    if (!uuid.test(commandId)) return { kind: 'Rejected' };
    const published = await this.package(packageSaid);
    if (published === undefined) return { kind: 'Rejected' };
    const proposed: PrivateHarnessFork = {
      version: 1,
      kind: 'PrivateHarnessFork',
      commandId,
      lineageId: randomUUID(),
      sourcePackageSaid: packageSaid,
      behavior: published.package.behavior,
      requiredCapabilities: published.package.requiredCapabilities,
    };
    const retained = await retain(join(this.#root, 'forks'), `${commandId}.json`, proposed);
    return Value.Check(privateHarnessForkSchema, retained) &&
      retained.commandId === commandId &&
      retained.sourcePackageSaid === packageSaid &&
      JSON.stringify(retained.behavior) === JSON.stringify(published.package.behavior) &&
      JSON.stringify(retained.requiredCapabilities) ===
        JSON.stringify(published.package.requiredCapabilities)
      ? { kind: 'Forked', fork: retained }
      : { kind: 'Rejected' };
  }
}
