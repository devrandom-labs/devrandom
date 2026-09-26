import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvaluationExecutionProfile, prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { loadLinuxH1ProfileBundle } from './linux-h1-profile-file.js';

function fixture() {
  const effectiveLimitsReceipt = Buffer.from('{"limits":"measured"}');
  const parentDeathCleanupReceipt = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunParentDeathCleanup',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      runtimeDigest: `sha256:${'b'.repeat(64)}`,
      architecture: 'aarch64',
      limits: {
        cpuCount: 1,
        memoryBytes: 134217728,
        processCount: 16,
        scratchBytes: 1048576,
        outputBytes: 65536,
        wallTimeSeconds: 60,
      },
      mechanism: 'WatchdogParentLoss',
      workerContainer: 'devrandom-evaluation-11111111-1111-4111-8111-111111111111',
      nativeContainer: 'devrandom-evaluation-22222222-2222-4222-8222-222222222222',
      workerRemoved: true,
      nativeRemoved: true,
      observedAt: '2026-09-26T07:00:00.000Z',
    }),
  );
  const said = (bytes: Uint8Array) => {
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture');
    return prepared.artifact.d;
  };
  const prepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: '1'.repeat(40),
    sourceGitTree: '2'.repeat(40),
    h1InstructionSaid: said(Buffer.from('{}')),
    h1RuntimePromptDigest: `sha256:${'d'.repeat(64)}`,
    effectiveLimitsReceiptSaid: said(effectiveLimitsReceipt),
    parentDeathCleanupReceiptSaid: said(parentDeathCleanupReceipt),
    modelProvider: 'concentrate',
    modelId: 'deepinfra/gemma-4-e4b',
    thinkingLevel: 'low',
    maximumOutputTokens: 4096,
    limits: {
      cpuCount: 1,
      memoryBytes: 134217728,
      processCount: 16,
      scratchBytes: 1048576,
      outputBytes: 65536,
      wallTimeSeconds: 60,
    },
    containment: {
      nonRoot: true,
      readOnlyRuntime: true,
      networkDisabled: true,
      privilegesDropped: true,
      restrictedIpc: true,
      parentDeathCleanup: true,
    },
  });
  if (prepared.kind !== 'Prepared') throw new Error('profile fixture');
  return {
    version: 1,
    profile: prepared.profile,
    image: prepared.profile.imageDigest,
    runtimeMounts: [{ hostPath: '/tmp/runtime', containerPath: '/app/packages/runtime' }],
    cargoRealpath: '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo',
    effectiveLimitsReceiptBase64Url: effectiveLimitsReceipt.toString('base64url'),
    parentDeathCleanupReceiptBase64Url: parentDeathCleanupReceipt.toString('base64url'),
  };
}

function withFile(value: unknown, assertion: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'linux-h1-bundle-'));
  try {
    const path = join(directory, 'bundle.json');
    writeFileSync(path, JSON.stringify(value));
    assertion(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Linux H1 profile bundle file', () => {
  it('accepts the exact SAID-valid profile and raw receipt bytes', () => {
    const value = fixture();
    withFile(value, (path) => {
      const loaded = loadLinuxH1ProfileBundle(path);
      expect(loaded.profile).toEqual(value.profile);
      expect(loaded.effectiveLimitsReceipt).toEqual(
        Buffer.from(value.effectiveLimitsReceiptBase64Url, 'base64url'),
      );
    });
  });

  it('rejects a SAID-bound cleanup claim without the measured cleanup structure', () => {
    const value = fixture();
    const forged = Buffer.from('{}');
    const input = Object.fromEntries(
      Object.entries(value.profile).filter(([key]) => !['version', 'd', 'kind'].includes(key)),
    );
    const artifact = prepareEvidenceArtifact(forged, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error('forged fixture artifact');
    const prepared = prepareEvaluationExecutionProfile({
      ...input,
      parentDeathCleanupReceiptSaid: artifact.artifact.d,
    });
    if (prepared.kind !== 'Prepared') throw new Error('forged fixture profile');
    withFile(
      {
        ...value,
        profile: prepared.profile,
        parentDeathCleanupReceiptBase64Url: forged.toString('base64url'),
      },
      (path) => {
        expect(() => loadLinuxH1ProfileBundle(path)).toThrow();
      },
    );
  });

  it.each(['profile', 'image', 'effectiveLimitsReceiptBase64Url', 'cargoRealpath'] as const)(
    'rejects a changed %s instead of silently using Darwin',
    (part) => {
      const value = fixture();
      const changed = {
        ...value,
        ...(part === 'profile' ? { profile: { ...value.profile, modelId: 'forged' } } : {}),
        ...(part === 'image' ? { image: `sha256:${'f'.repeat(64)}` } : {}),
        ...(part === 'effectiveLimitsReceiptBase64Url'
          ? { effectiveLimitsReceiptBase64Url: Buffer.from('{}').toString('base64url') }
          : {}),
        ...(part === 'cargoRealpath' ? { cargoRealpath: '/usr/bin/cargo' } : {}),
      };
      withFile(changed, (path) => {
        expect(() => loadLinuxH1ProfileBundle(path)).toThrow();
      });
    },
  );
});
