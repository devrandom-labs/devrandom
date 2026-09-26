import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  decodeProtectedEvaluationArtifact,
  evaluationManifestLockCommandSchema,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

type Command = Type.Static<typeof evaluationManifestLockCommandSchema>;
type Draft = Omit<Command, 'commandId' | 'fingerprint'>;
const maximumCommandBytes = 1_048_576;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalDraft(draft: Draft): Draft {
  return {
    version: draft.version,
    expectedEvaluationVersion: draft.expectedEvaluationVersion,
    leaseId: draft.leaseId,
    manifest: draft.manifest,
    verifierBundle: draft.verifierBundle,
    verifierBundleBytesBase64Url: draft.verifierBundleBytesBase64Url,
    protectedArtifacts: draft.protectedArtifacts,
  };
}

function fingerprint(draft: Draft): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalDraft(draft)))
    .digest('hex')}`;
}

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function exists(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}

function validCommand(command: Command): boolean {
  if (
    decodeEvaluationManifest(command.manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(command.verifierBundle, command.manifest).kind !== 'Bound'
  )
    return false;
  const bytes = Buffer.from(command.verifierBundleBytesBase64Url, 'base64url');
  const decoded = decodeEvaluationVerifierBundleBytes(bytes);
  const expected = [
    command.verifierBundle.protectedCase.stimulus,
    command.verifierBundle.protectedCase.expected,
    command.verifierBundle.terminalCase.stimulus,
    command.verifierBundle.terminalCase.expected,
  ];
  return (
    bytes.toString('base64url') === command.verifierBundleBytesBase64Url &&
    decoded.kind === 'Accepted' &&
    JSON.stringify(decoded.bundle) === JSON.stringify(command.verifierBundle) &&
    command.protectedArtifacts.length === 4 &&
    command.protectedArtifacts.every(
      (artifact, index) =>
        decodeProtectedEvaluationArtifact(artifact).kind === 'Accepted' &&
        JSON.stringify(artifact) === JSON.stringify(expected[index]),
    ) &&
    Buffer.byteLength(JSON.stringify(command), 'utf8') <= maximumCommandBytes
  );
}

function sameDraft(command: Command, draft: Draft): boolean {
  return (
    command.fingerprint === fingerprint(draft) &&
    JSON.stringify(canonicalDraft(command)) === JSON.stringify(canonicalDraft(draft))
  );
}

async function readCommand(path: string): Promise<Command> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (
      !status.isFile() ||
      status.size < 2 ||
      status.size > maximumCommandBytes ||
      (status.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && status.uid !== process.getuid())
    )
      throw new Error('Manifest command custody invalid');
    const document: unknown = JSON.parse(await file.readFile({ encoding: 'utf8' }));
    if (!Value.Check(evaluationManifestLockCommandSchema, document) || !validCommand(document))
      throw new Error('Manifest command invalid');
    if (document.fingerprint !== fingerprint(document))
      throw new Error('Manifest command fingerprint invalid');
    return document;
  } finally {
    await file.close();
  }
}

export type ManifestCommandStaging =
  | { readonly kind: 'Staged'; readonly command: Command }
  | { readonly kind: 'Conflict' | 'Unavailable' };
export type ManifestCommandInspection =
  | { readonly kind: 'Staged'; readonly command: Command }
  | { readonly kind: 'Missing' | 'Unavailable' };

/** Local exact-command custody before a hosted protected M lock request. */
export class EvaluationManifestCommandFile {
  readonly #directory: string;
  readonly #newCommandId: () => string;

  constructor(directory: string, newCommandId: () => string) {
    this.#directory = directory;
    this.#newCommandId = newCommandId;
  }

  async inspect(evaluationId: string): Promise<ManifestCommandInspection> {
    if (!uuid.test(evaluationId)) return { kind: 'Unavailable' };
    try {
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const status = await directory.stat();
        if (
          !status.isDirectory() ||
          (status.mode & 0o777) !== 0o700 ||
          (process.getuid !== undefined && status.uid !== process.getuid())
        )
          return { kind: 'Unavailable' };
      } finally {
        await directory.close();
      }
      const command = await readCommand(join(this.#directory, `${evaluationId}.manifest.json`));
      return command.manifest.evaluationId === evaluationId
        ? { kind: 'Staged', command }
        : { kind: 'Unavailable' };
    } catch (cause) {
      return { kind: absent(cause) ? 'Missing' : 'Unavailable' };
    }
  }

  async stage(draft: Draft): Promise<ManifestCommandStaging> {
    if (!uuid.test(draft.manifest.evaluationId)) return { kind: 'Unavailable' };
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const status = await directory.stat();
        if (
          !status.isDirectory() ||
          (status.mode & 0o777) !== 0o700 ||
          (process.getuid !== undefined && status.uid !== process.getuid())
        )
          return { kind: 'Unavailable' };
      } finally {
        await directory.close();
      }
      const path = join(this.#directory, `${draft.manifest.evaluationId}.manifest.json`);
      const expectedFingerprint = fingerprint(draft);
      let stored: Command | undefined;
      try {
        stored = await readCommand(path);
      } catch (cause) {
        if (!absent(cause)) return { kind: 'Unavailable' };
      }
      if (stored !== undefined)
        return sameDraft(stored, draft)
          ? { kind: 'Staged', command: stored }
          : { kind: 'Conflict' };

      const command = {
        ...draft,
        commandId: this.#newCommandId(),
        fingerprint: expectedFingerprint,
      };
      if (!Value.Check(evaluationManifestLockCommandSchema, command) || !validCommand(command))
        return { kind: 'Unavailable' };
      const bytes = JSON.stringify(command);
      const temporary = join(
        this.#directory,
        `${draft.manifest.evaluationId}.${command.commandId}.tmp`,
      );
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
        await link(temporary, path);
      } catch (cause) {
        if (!exists(cause)) throw cause;
      } finally {
        await unlink(temporary);
      }
      const synchronized = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await synchronized.sync();
      } finally {
        await synchronized.close();
      }
      const replay = await readCommand(path);
      return sameDraft(replay, draft) ? { kind: 'Staged', command: replay } : { kind: 'Conflict' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
