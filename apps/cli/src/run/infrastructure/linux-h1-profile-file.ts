import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  decodeEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
} from '@devrandom/protocol';
import { inspectRunParentDeathCleanupReceipt, type RunRuntimeMount } from '@devrandom/runtime';

const workerProgram = '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js';

export interface LinuxH1ProfileBundle {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly runtimeMounts: readonly RunRuntimeMount[];
  readonly cargoRealpath: string;
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
}

interface BoundaryObject {
  [name: string]: unknown;
}

function record(value: unknown, keys: readonly string[]): value is BoundaryObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function receipt(value: unknown, said: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Linux H1 profile bundle invalid');
  const bytes = Buffer.from(value, 'base64url');
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (
    bytes.length === 0 ||
    bytes.toString('base64url') !== value ||
    prepared.kind !== 'Prepared' ||
    prepared.artifact.d !== said
  )
    throw new Error('Linux H1 profile bundle invalid');
  return bytes;
}

/** Loads one explicit Linux profile for H1 inventory and Run supervision. */
export function loadLinuxH1ProfileBundle(path: string): LinuxH1ProfileBundle {
  if (!isAbsolute(path)) throw new Error('Linux H1 profile bundle invalid');
  const bytes = readFileSync(path);
  if (bytes.length > 131_072) throw new Error('Linux H1 profile bundle invalid');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !record(value, [
      'version',
      'profile',
      'image',
      'runtimeMounts',
      'cargoRealpath',
      'effectiveLimitsReceiptBase64Url',
      'parentDeathCleanupReceiptBase64Url',
    ]) ||
    value.version !== 1
  )
    throw new Error('Linux H1 profile bundle invalid');
  const decoded = decodeEvaluationExecutionProfile(value.profile);
  if (decoded.kind !== 'Accepted') throw new Error('Linux H1 profile bundle invalid');
  const profile = decoded.profile;
  if (
    typeof value.image !== 'string' ||
    (value.image !== profile.imageDigest && !value.image.endsWith(`@${profile.imageDigest}`)) ||
    typeof value.cargoRealpath !== 'string' ||
    value.cargoRealpath !==
      `/usr/local/rustup/toolchains/1.98.1-${profile.architecture}-unknown-linux-gnu/bin/cargo` ||
    !Array.isArray(value.runtimeMounts) ||
    value.runtimeMounts.length === 0 ||
    value.runtimeMounts.length > 8 ||
    value.runtimeMounts.some(
      (mount: unknown) =>
        !record(mount, ['hostPath', 'containerPath']) ||
        typeof mount.hostPath !== 'string' ||
        typeof mount.containerPath !== 'string' ||
        !isAbsolute(mount.hostPath) ||
        !isAbsolute(mount.containerPath) ||
        mount.hostPath.includes('\u0000') ||
        mount.containerPath.includes('\u0000'),
    ) ||
    !value.runtimeMounts.some((mount: RunRuntimeMount) =>
      workerProgram.startsWith(`${mount.containerPath}/`),
    ) ||
    new Set(value.runtimeMounts.map((mount: RunRuntimeMount) => mount.containerPath)).size !==
      value.runtimeMounts.length
  )
    throw new Error('Linux H1 profile bundle invalid');
  const parentDeathCleanupReceipt = receipt(
    value.parentDeathCleanupReceiptBase64Url,
    profile.parentDeathCleanupReceiptSaid,
  );
  if (!inspectRunParentDeathCleanupReceipt(profile, parentDeathCleanupReceipt))
    throw new Error('Linux H1 profile bundle invalid');
  return {
    profile,
    image: value.image,
    runtimeMounts: value.runtimeMounts as RunRuntimeMount[],
    cargoRealpath: value.cargoRealpath,
    effectiveLimitsReceipt: receipt(
      value.effectiveLimitsReceiptBase64Url,
      profile.effectiveLimitsReceiptSaid,
    ),
    parentDeathCleanupReceipt,
  };
}
