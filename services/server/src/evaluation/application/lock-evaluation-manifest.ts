import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';

import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  decodeProtectedEvaluationArtifact,
  evaluationManifestLockCommandSchema,
  type EvaluationManifest,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type EvaluationManifestLockCommand = Type.Static<typeof evaluationManifestLockCommandSchema>;
export type EvaluationManifestLockOutcome =
  | {
      readonly kind: 'Locked' | 'AlreadyLocked';
      readonly evaluationId: string;
      readonly manifestSaid: string;
      readonly ownerAid: string;
      readonly policySaid: string;
      readonly leaseId: string;
      readonly lockedAtLeaseVersion: number;
      readonly lockedAtEvaluationVersion: number;
      readonly currentLeaseVersion: number;
      readonly currentEvaluationVersion: number;
    }
  | { readonly kind: 'Invalid' | 'Conflict' | 'QuotaExceeded' | 'Unavailable' };
export type EvaluationManifestInspection =
  | Extract<EvaluationManifestLockOutcome, { readonly kind: 'Locked' | 'AlreadyLocked' }>
  | { readonly kind: 'Conflict' | 'Lost' | 'Unavailable' };
type EvaluationManifestLockRecord = Extract<
  EvaluationManifestInspection,
  { readonly kind: 'Locked' | 'AlreadyLocked' }
> & {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly sourceInventorySaid: string;
};

/** Current Task, ACDC and TEL rights are checked before a new immutable M takes effect. */
export interface EvaluationManifestAuthority {
  inspect(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
  }): Promise<
    | {
        readonly kind: 'Authorized';
        readonly taskRevisionSaid: string;
        readonly personalAgentAid: string;
        readonly taskMandateSaid: string;
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

/** The adapter must atomically retain the raw bundle and every ciphertext before recording M. */
export interface EvaluationManifestLocks {
  lock(input: {
    readonly ownerAid: string;
    readonly command: EvaluationManifestLockCommand;
    readonly verifierBytes: Uint8Array;
    readonly manifest: EvaluationManifest;
    readonly protectedArtifacts: readonly ProtectedEvaluationArtifact[];
  }): Promise<EvaluationManifestLockOutcome>;
  inspect(input: {
    readonly ownerAid: string;
    readonly evaluationId: string;
    readonly manifestSaid: string;
  }): Promise<
    | EvaluationManifestLockRecord
    | Extract<EvaluationManifestInspection, { readonly kind: 'Conflict' | 'Lost' | 'Unavailable' }>
  >;
}

export async function inspectEvaluationManifest(
  input: {
    readonly ownerAid: string;
    readonly evaluationId: string;
    readonly manifestSaid: string;
  },
  dependencies: {
    readonly authority: EvaluationManifestAuthority;
    readonly locks: EvaluationManifestLocks;
  },
): Promise<EvaluationManifestInspection> {
  const stored = await dependencies.locks.inspect(input);
  if (stored.kind !== 'Locked' && stored.kind !== 'AlreadyLocked') return stored;
  const current = await dependencies.authority.inspect({
    ownerAid: input.ownerAid,
    taskId: stored.taskId,
    sourceInventorySaid: stored.sourceInventorySaid,
  });
  if (current.kind === 'Unavailable') return { kind: 'Unavailable' };
  if (
    current.kind !== 'Authorized' ||
    current.taskRevisionSaid !== stored.taskRevisionSaid ||
    current.personalAgentAid !== stored.personalAgentAid ||
    current.taskMandateSaid !== stored.taskMandateSaid
  )
    return { kind: 'Lost' };
  return {
    kind: stored.kind,
    evaluationId: stored.evaluationId,
    manifestSaid: stored.manifestSaid,
    ownerAid: stored.ownerAid,
    policySaid: stored.policySaid,
    leaseId: stored.leaseId,
    lockedAtLeaseVersion: stored.lockedAtLeaseVersion,
    lockedAtEvaluationVersion: stored.lockedAtEvaluationVersion,
    currentLeaseVersion: stored.currentLeaseVersion,
    currentEvaluationVersion: stored.currentEvaluationVersion,
  };
}

export async function lockEvaluationManifest(
  input: { readonly ownerAid: string; readonly command: EvaluationManifestLockCommand },
  dependencies: {
    readonly authority: EvaluationManifestAuthority;
    readonly locks: EvaluationManifestLocks;
  },
): Promise<EvaluationManifestLockOutcome> {
  const { command, ownerAid } = input;
  if (
    !Value.Check(evaluationManifestLockCommandSchema, command) ||
    decodeEvaluationManifest(command.manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(command.verifierBundle, command.manifest).kind !== 'Bound' ||
    command.manifest.ownerAid !== ownerAid
  )
    return { kind: 'Invalid' };

  const verifierBytes = Buffer.from(command.verifierBundleBytesBase64Url, 'base64url');
  const decodedBytes = decodeEvaluationVerifierBundleBytes(verifierBytes);
  if (
    verifierBytes.toString('base64url') !== command.verifierBundleBytesBase64Url ||
    decodedBytes.kind !== 'Accepted' ||
    !isDeepStrictEqual(decodedBytes.bundle, command.verifierBundle)
  )
    return { kind: 'Invalid' };

  const expected = [
    command.verifierBundle.protectedCase.stimulus,
    command.verifierBundle.protectedCase.expected,
    command.verifierBundle.terminalCase.stimulus,
    command.verifierBundle.terminalCase.expected,
  ];
  if (
    command.protectedArtifacts.some(
      (artifact) => decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted',
    ) ||
    !isDeepStrictEqual(command.protectedArtifacts, expected)
  )
    return { kind: 'Invalid' };

  const current = await dependencies.authority.inspect({
    ownerAid,
    taskId: command.manifest.taskId,
    sourceInventorySaid: command.manifest.sourceInventorySaid,
  });
  if (current.kind === 'Unavailable') return { kind: 'Unavailable' };
  if (
    current.kind !== 'Authorized' ||
    current.taskRevisionSaid !== command.manifest.taskRevisionSaid ||
    current.personalAgentAid !== command.manifest.personalAgentAid ||
    current.taskMandateSaid !== command.manifest.taskMandateSaid
  )
    return { kind: 'Conflict' };
  return dependencies.locks.lock({
    ownerAid,
    command,
    verifierBytes,
    manifest: command.manifest,
    protectedArtifacts: command.protectedArtifacts,
  });
}
