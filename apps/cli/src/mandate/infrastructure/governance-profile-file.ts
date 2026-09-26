import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import Type from 'typebox';
import Value from 'typebox/value';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';

const aidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

const governanceProfileSchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.Integer({ minimum: 0 }),
    userAid: aidSchema,
    controllerAid: aidSchema,
    keriaAgentAid: aidSchema,
    personalAgentAid: aidSchema,
    governorAid: aidSchema,
    mandateRegistryId: aidSchema,
  },
  { additionalProperties: false },
);

export type GovernanceProfileFileError =
  | { readonly kind: 'GovernanceProfileInvalid' }
  | { readonly kind: 'GovernanceProfileInsecure' }
  | { readonly kind: 'GovernanceProfileConflict' }
  | { readonly kind: 'GovernanceProfileUnavailable' };

export class GovernanceProfileFileFailure extends Error {
  readonly detail: GovernanceProfileFileError;

  constructor(detail: GovernanceProfileFileError, cause?: unknown) {
    super(detail.kind, cause === undefined ? undefined : { cause });
    this.name = 'GovernanceProfileFileFailure';
    this.detail = detail;
  }
}

export class GovernanceProfileFile {
  readonly #directory: string;
  readonly #path: string;
  readonly #lockPath: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#path = join(directory, 'local-governance.json');
    this.#lockPath = join(directory, 'local-governance.lock');
  }

  async read(): Promise<LocalGovernanceProfile | undefined> {
    let before: Stats;
    try {
      before = await lstat(this.#path);
    } catch (cause) {
      if (isAbsent(cause)) {
        return undefined;
      }
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileUnavailable' }, cause);
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !ownedByCurrentUser(before) ||
      (before.mode & 0o077) !== 0
    ) {
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileInsecure' });
    }

    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileConflict' });
      }
      const source = await handle.readFile('utf8');
      const parsed: unknown = JSON.parse(source);
      if (!Value.Check(governanceProfileSchema, parsed) || !principalsAreDistinct(parsed)) {
        throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileInvalid' });
      }
      return {
        version: 1,
        revision: parsed.revision,
        userAid: userAid(parsed.userAid),
        controllerAid: controllerAid(parsed.controllerAid),
        keriaAgentAid: agentAid(parsed.keriaAgentAid),
        personalAgentAid: personalAgentAid(parsed.personalAgentAid),
        governorAid: governorAid(parsed.governorAid),
        mandateRegistryId: credentialRegistryId(parsed.mandateRegistryId),
      };
    } catch (cause) {
      if (cause instanceof GovernanceProfileFileFailure) {
        throw cause;
      }
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileInvalid' }, cause);
    } finally {
      await handle?.close();
    }
  }

  async commit(
    previousRevision: number | undefined,
    profile: LocalGovernanceProfile,
  ): Promise<void> {
    if (
      !Value.Check(governanceProfileSchema, profile) ||
      !principalsAreDistinct(profile) ||
      profile.revision !== (previousRevision === undefined ? 0 : previousRevision + 1)
    ) {
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileInvalid' });
    }
    await this.#prepareDirectory();
    let lock;
    try {
      lock = await open(
        this.#lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileConflict' }, cause);
    }
    try {
      const current = await this.read();
      if (current?.revision !== previousRevision) {
        throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileConflict' });
      }
      await this.#replaceAtomically(profile);
    } finally {
      await lock.close();
      await unlink(this.#lockPath).catch(() => undefined);
    }
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const state = await lstat(this.#directory);
    if (!state.isDirectory() || state.isSymbolicLink() || !ownedByCurrentUser(state)) {
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileInsecure' });
    }
    await chmod(this.#directory, 0o700);
  }

  async #replaceAtomically(profile: LocalGovernanceProfile): Promise<void> {
    const temporary = join(
      dirname(this.#path),
      `.${basename(this.#path)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(profile)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#path);
      const directory = await open(this.#directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      if (cause instanceof GovernanceProfileFileFailure) {
        throw cause;
      }
      throw new GovernanceProfileFileFailure({ kind: 'GovernanceProfileUnavailable' }, cause);
    } finally {
      await handle?.close();
    }
  }
}

function principalsAreDistinct(profile: Type.Static<typeof governanceProfileSchema>): boolean {
  const principals = [
    profile.userAid,
    profile.controllerAid,
    profile.keriaAgentAid,
    profile.personalAgentAid,
    profile.governorAid,
  ];
  return new Set(principals).size === principals.length;
}

function ownedByCurrentUser(state: Stats): boolean {
  return process.getuid === undefined || state.uid === process.getuid();
}

function isAbsent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}
