import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import Type from 'typebox';
import Value from 'typebox/value';

import {
  clientInstanceId,
  clientInstanceIdPattern,
  type PendingRegistrationCreation,
  type RegistrationSecrets,
  type SignifyCustody,
  type UserProfile,
} from '../domain/user-profile.js';

const nonEmptyString = Type.String({ minLength: 1 });
const aid = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const registrationId = Type.String({ pattern: '^[a-f0-9]{32}$' });
const profileCommitContentionAttempts = 500;
const profileCommitContentionIntervalMs = 10;

const custodySchema = Type.Object(
  {
    version: Type.Literal(1),
    bran: Type.String({ pattern: '^[A-Za-z0-9_-]{21}$' }),
  },
  { additionalProperties: false },
);

const issuerSchema = Type.Object(
  {
    aid,
    oobi: Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^#]+$' }),
    registryId: said,
    schemaSaid: said,
  },
  { additionalProperties: false },
);

const witnessPolicySchema = Type.Object(
  {
    witnessAids: Type.Array(aid, { minItems: 1, uniqueItems: true }),
    threshold: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const receiptEvidenceSchema = Type.Object(
  {
    kelSequence: Type.Integer({ minimum: 0 }),
    currentEventSaid: said,
    receiptIndexes: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

const credentialReferenceSchema = Type.Object(
  {
    credentialSaid: said,
    attributeSaid: said,
    issuerAnchorEventSaid: said,
    issuedAt: nonEmptyString,
  },
  { additionalProperties: false },
);

const registrationReferenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('registration-pending'),
      registrationId,
      expiresAt: nonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('registration-issued'),
      registrationId,
      expiresAt: nonEmptyString,
      grantSaid: said,
      credentialSaid: said,
      admitPreparedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);

const pendingRotationSchema = Type.Object(
  {
    kind: Type.Literal('rotation-pending'),
    priorKelSequence: Type.Integer({ minimum: 0 }),
    priorEventSaid: said,
  },
  { additionalProperties: false },
);

const profileFields = {
  revision: Type.Integer({ minimum: 0 }),
  alias: nonEmptyString,
  controllerAid: aid,
  keriaAgentAid: aid,
  userAid: aid,
  userAgentOobi: Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^#]+$' }),
  witnessPolicy: witnessPolicySchema,
  receiptEvidence: receiptEvidenceSchema,
  issuer: issuerSchema,
  credential: Type.Optional(credentialReferenceSchema),
  registration: Type.Optional(registrationReferenceSchema),
  rotation: Type.Optional(pendingRotationSchema),
  provenance: Type.Object({ kind: Type.Literal('live') }, { additionalProperties: false }),
  custodyReference: Type.Literal('signify-bran-v1'),
} as const;

const legacyProfileSchema = Type.Object(
  {
    version: Type.Literal(1),
    ...profileFields,
  },
  { additionalProperties: false },
);

const clientBoundProfileSchema = Type.Object(
  {
    version: Type.Literal(2),
    ...profileFields,
    clientInstanceId: Type.String({
      pattern: clientInstanceIdPattern,
    }),
  },
  { additionalProperties: false },
);

const profileSchema = Type.Union([legacyProfileSchema, clientBoundProfileSchema]);

const registrationSecretsSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('registration-create-pending'),
      creationKey: Type.String({ pattern: '^registration_[A-Za-z0-9_-]{43}$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal('registration-active'),
      registrationId,
      cliCapability: Type.String({ pattern: '^cli_[A-Za-z0-9_-]{32,}$' }),
      browserUrl: Type.String({
        minLength: 1,
        maxLength: 4096,
        pattern:
          '^https?://[^#]+#/registration/[a-f0-9]{32}\\?capability=browser_[A-Za-z0-9_-]{32,}$',
      }),
      challengeWords: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        minItems: 3,
        maxItems: 32,
      }),
      issuerAid: aid,
      issuerOobi: Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^#]+$' }),
      expiresAt: nonEmptyString,
      pollIntervalMs: Type.Integer({ minimum: 250, maximum: 10_000 }),
      proof: Type.Optional(
        Type.Object(
          {
            kind: Type.Literal('challenge-response-prepared'),
            responseSaid: said,
            preparedAt: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
]);

export type IdentityFileError =
  | { readonly kind: 'identity-file-absent'; readonly file: IdentityFileName }
  | { readonly kind: 'identity-file-insecure'; readonly file: IdentityFileName }
  | { readonly kind: 'identity-file-invalid'; readonly file: IdentityFileName }
  | { readonly kind: 'identity-file-conflict'; readonly file: IdentityFileName }
  | { readonly kind: 'identity-file-unavailable'; readonly file: IdentityFileName };

export type IdentityFileName = 'custody' | 'profile' | 'registration-secrets';

export class IdentityFileFailure extends Error {
  readonly detail: IdentityFileError;

  constructor(detail: IdentityFileError, cause?: unknown) {
    super(`${detail.file}: ${detail.kind}`, cause === undefined ? undefined : { cause });
    this.name = 'IdentityFileFailure';
    this.detail = detail;
  }
}

export class IdentityFiles {
  readonly #directory: string;
  readonly #custodyPath: string;
  readonly #profilePath: string;
  readonly #registrationSecretsPath: string;
  readonly #profileLockPath: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#custodyPath = join(directory, 'signify-custody.json');
    this.#profilePath = join(directory, 'user-profile.json');
    this.#registrationSecretsPath = join(directory, 'registration-secrets.json');
    this.#profileLockPath = join(directory, 'user-profile.lock');
  }

  async readCustody(): Promise<SignifyCustody | undefined> {
    const value = await this.#readJson(this.#custodyPath, 'custody');
    if (value === undefined) {
      return undefined;
    }
    if (!Value.Check(custodySchema, value)) {
      throw new IdentityFileFailure({ kind: 'identity-file-invalid', file: 'custody' });
    }
    return Value.Parse(custodySchema, value);
  }

  async createCustody(custody: SignifyCustody): Promise<void> {
    if (!Value.Check(custodySchema, custody)) {
      throw new IdentityFileFailure({ kind: 'identity-file-invalid', file: 'custody' });
    }
    await this.#prepareDirectory();
    await this.#createOnce(this.#custodyPath, 'custody', custody);
  }

  async readProfile(): Promise<UserProfile | undefined> {
    const value = await this.#readJson(this.#profilePath, 'profile');
    if (value === undefined) {
      return undefined;
    }
    if (!Value.Check(profileSchema, value)) {
      throw new IdentityFileFailure({ kind: 'identity-file-invalid', file: 'profile' });
    }
    const parsed = Value.Parse(profileSchema, value);
    return parsed.version === 1
      ? parsed
      : { ...parsed, clientInstanceId: clientInstanceId(parsed.clientInstanceId) };
  }

  async commitProfile(previousRevision: number | undefined, profile: UserProfile): Promise<void> {
    if (
      !Value.Check(profileSchema, profile) ||
      profile.revision !== (previousRevision === undefined ? 0 : previousRevision + 1)
    ) {
      throw new IdentityFileFailure({ kind: 'identity-file-invalid', file: 'profile' });
    }
    await this.#prepareDirectory();
    const lock = await this.#acquireProfileCommit();
    try {
      const current = await this.readProfile();
      if (current?.revision !== previousRevision) {
        throw new IdentityFileFailure({ kind: 'identity-file-conflict', file: 'profile' });
      }
      await this.#replaceAtomically(this.#profilePath, 'profile', profile);
    } finally {
      await lock.close();
      await unlink(this.#profileLockPath).catch(() => undefined);
    }
  }

  async #acquireProfileCommit() {
    let contention: unknown;
    for (let attempt = 0; attempt < profileCommitContentionAttempts; attempt += 1) {
      try {
        return await open(
          this.#profileLockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (cause) {
        if (!isAlreadyPresent(cause)) {
          throw new IdentityFileFailure({ kind: 'identity-file-conflict', file: 'profile' }, cause);
        }
        contention = cause;
      }
      await wait(profileCommitContentionIntervalMs);
    }
    throw new IdentityFileFailure({ kind: 'identity-file-conflict', file: 'profile' }, contention);
  }

  async readRegistrationSecrets(): Promise<RegistrationSecrets | undefined> {
    const value = await this.#readJson(this.#registrationSecretsPath, 'registration-secrets');
    if (value === undefined) {
      return undefined;
    }
    if (!Value.Check(registrationSecretsSchema, value)) {
      throw new IdentityFileFailure({
        kind: 'identity-file-invalid',
        file: 'registration-secrets',
      });
    }
    return Value.Parse(registrationSecretsSchema, value);
  }

  async writeRegistrationSecrets(secrets: RegistrationSecrets): Promise<void> {
    if (!Value.Check(registrationSecretsSchema, secrets)) {
      throw new IdentityFileFailure({
        kind: 'identity-file-invalid',
        file: 'registration-secrets',
      });
    }
    await this.#prepareDirectory();
    await this.#replaceAtomically(this.#registrationSecretsPath, 'registration-secrets', secrets);
  }

  async claimRegistrationCreation(
    attempt: PendingRegistrationCreation,
  ): Promise<RegistrationSecrets> {
    if (!Value.Check(registrationSecretsSchema, attempt)) {
      throw new IdentityFileFailure({
        kind: 'identity-file-invalid',
        file: 'registration-secrets',
      });
    }
    await this.#prepareDirectory();
    try {
      await this.#createOnce(this.#registrationSecretsPath, 'registration-secrets', attempt);
      return attempt;
    } catch (cause) {
      if (
        !(cause instanceof IdentityFileFailure) ||
        cause.detail.kind !== 'identity-file-conflict'
      ) {
        throw cause;
      }
      const existing = await this.readRegistrationSecrets();
      if (existing === undefined) {
        throw cause;
      }
      return existing;
    }
  }

  async removeRegistrationSecrets(): Promise<void> {
    try {
      await unlink(this.#registrationSecretsPath);
      await this.#syncDirectory(this.#registrationSecretsPath);
    } catch (cause) {
      if (!isAbsent(cause)) {
        throw new IdentityFileFailure(
          { kind: 'identity-file-unavailable', file: 'registration-secrets' },
          cause,
        );
      }
    }
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const state = await lstat(this.#directory);
    if (!state.isDirectory() || state.isSymbolicLink() || !ownedByCurrentUser(state)) {
      throw new IdentityFileFailure({ kind: 'identity-file-insecure', file: 'profile' });
    }
    await chmod(this.#directory, 0o700);
  }

  async #readJson(path: string, file: IdentityFileName): Promise<unknown> {
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (cause) {
      if (isAbsent(cause)) {
        return undefined;
      }
      throw new IdentityFileFailure({ kind: 'identity-file-unavailable', file }, cause);
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !ownedByCurrentUser(before) ||
      (before.mode & 0o077) !== 0
    ) {
      throw new IdentityFileFailure({ kind: 'identity-file-insecure', file });
    }

    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new IdentityFileFailure({ kind: 'identity-file-conflict', file });
      }
      const source = await handle.readFile('utf8');
      const parsed: unknown = JSON.parse(source);
      return parsed;
    } catch (cause) {
      if (cause instanceof IdentityFileFailure) {
        throw cause;
      }
      throw new IdentityFileFailure({ kind: 'identity-file-invalid', file }, cause);
    } finally {
      await handle?.close();
    }
  }

  async #createOnce(path: string, file: IdentityFileName, value: object): Promise<void> {
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, path);
      await this.#syncDirectory(path);
      const persisted = await this.#readJson(path, file);
      if (JSON.stringify(persisted) !== JSON.stringify(value)) {
        throw new IdentityFileFailure({ kind: 'identity-file-conflict', file });
      }
      await unlink(temporary);
      await this.#syncDirectory(path);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      if (cause instanceof IdentityFileFailure) {
        throw cause;
      }
      const kind =
        cause instanceof Error && 'code' in cause && cause.code === 'EEXIST'
          ? 'identity-file-conflict'
          : 'identity-file-unavailable';
      throw new IdentityFileFailure({ kind, file }, cause);
    } finally {
      await handle?.close();
    }
  }

  async #replaceAtomically(path: string, file: IdentityFileName, value: object): Promise<void> {
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      await this.#syncDirectory(path);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      if (cause instanceof IdentityFileFailure) {
        throw cause;
      }
      throw new IdentityFileFailure({ kind: 'identity-file-unavailable', file }, cause);
    } finally {
      await handle?.close();
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function ownedByCurrentUser(state: Stats): boolean {
  return process.getuid === undefined || state.uid === process.getuid();
}

function isAbsent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function isAlreadyPresent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}
