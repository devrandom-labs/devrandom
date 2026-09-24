import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  decodeDevrandomIssuerProfile,
  sameDevrandomIssuerProfile,
  serializeDevrandomIssuerProfile,
  type DevrandomIssuerProfile,
} from '../domain/devrandom-issuer-profile.js';
import type { IssuerProfilePath } from '../domain/issuer-configuration.js';
import { IssuerFailure } from '../domain/issuer-error.js';

export type IssuerProfileWriteOutcome =
  | { readonly kind: 'issuer-profile-recorded' }
  | { readonly kind: 'existing-issuer-profile' }
  | {
      readonly kind: 'conflicting-issuer-profile';
      readonly existing: DevrandomIssuerProfile;
    };

type ProfilePublicationAttempt =
  | {
      readonly kind: 'profile-publication-completed';
      readonly outcome: IssuerProfileWriteOutcome;
    }
  | {
      readonly kind: 'profile-publication-failed';
      readonly cause: unknown;
    };

function isFileError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code;
}

function persistenceFailure(cause: unknown): IssuerFailure {
  return new IssuerFailure(
    {
      kind: 'issuer-profile-persistence-failed',
      reason: cause instanceof Error ? cause.message : 'unknown filesystem failure',
    },
    cause,
  );
}

export async function readDevrandomIssuerProfile(
  path: IssuerProfilePath,
): Promise<DevrandomIssuerProfile | undefined> {
  let encoded: string;
  try {
    encoded = await readFile(path, 'utf8');
  } catch (cause) {
    if (isFileError(cause, 'ENOENT')) {
      return undefined;
    }
    throw persistenceFailure(cause);
  }

  let document: unknown;
  try {
    document = JSON.parse(encoded);
  } catch (cause) {
    throw new IssuerFailure(
      { kind: 'issuer-profile-invalid', reason: 'document is not valid JSON' },
      cause,
    );
  }
  return decodeDevrandomIssuerProfile(document);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function recordDevrandomIssuerProfile(
  path: IssuerProfilePath,
  profile: DevrandomIssuerProfile,
): Promise<IssuerProfileWriteOutcome> {
  const existing = await readDevrandomIssuerProfile(path);
  if (existing !== undefined) {
    return sameDevrandomIssuerProfile(existing, profile)
      ? { kind: 'existing-issuer-profile' }
      : { kind: 'conflicting-issuer-profile', existing };
  }

  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  let attempt: ProfilePublicationAttempt;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      await temporary.writeFile(serializeDevrandomIssuerProfile(profile), 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    let publication: IssuerProfileWriteOutcome | undefined;
    try {
      await link(temporaryPath, path);
    } catch (cause) {
      if (!isFileError(cause, 'EEXIST')) {
        throw cause;
      }
      const competing = await readDevrandomIssuerProfile(path);
      if (competing === undefined) {
        throw new Error('issuer profile appeared and disappeared during atomic publication', {
          cause,
        });
      }
      publication = sameDevrandomIssuerProfile(competing, profile)
        ? { kind: 'existing-issuer-profile' }
        : { kind: 'conflicting-issuer-profile', existing: competing };
    }

    if (publication === undefined) {
      await syncDirectory(directory);
      const recorded = await readDevrandomIssuerProfile(path);
      if (recorded === undefined || !sameDevrandomIssuerProfile(recorded, profile)) {
        throw new Error('recorded issuer profile failed verification');
      }
      publication = { kind: 'issuer-profile-recorded' };
    }

    attempt = { kind: 'profile-publication-completed', outcome: publication };
  } catch (cause) {
    attempt = { kind: 'profile-publication-failed', cause };
  }

  if (temporaryExists) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupCause) {
      if (!isFileError(cleanupCause, 'ENOENT')) {
        const causes =
          attempt.kind === 'profile-publication-failed'
            ? [attempt.cause, cleanupCause]
            : [cleanupCause];
        throw persistenceFailure(
          new AggregateError(causes, 'issuer profile publication and cleanup failed', {
            cause: cleanupCause,
          }),
        );
      }
    }
  }

  switch (attempt.kind) {
    case 'profile-publication-completed':
      return attempt.outcome;
    case 'profile-publication-failed':
      if (attempt.cause instanceof IssuerFailure) {
        throw attempt.cause;
      }
      throw persistenceFailure(attempt.cause);
  }
}
