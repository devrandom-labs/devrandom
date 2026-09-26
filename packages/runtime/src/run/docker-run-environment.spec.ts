import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { DockerRunEnvironment } from './docker-run-environment.js';

const said = (character: string): string => `E${character.repeat(43)}`;

it('rejects unbound parent-death proof before opening either Linux compartment', async () => {
  const prepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: 'd'.repeat(40),
    sourceGitTree: 'e'.repeat(40),
    h1InstructionSaid: said('i'),
    h1RuntimePromptDigest: `sha256:${'f'.repeat(64)}`,
    effectiveLimitsReceiptSaid: said('l'),
    parentDeathCleanupReceiptSaid: said('p'),
    modelProvider: 'concentrate',
    modelId: 'deepinfra/gemma-4-e4b',
    thinkingLevel: 'off',
    maximumOutputTokens: 128,
    limits: {
      cpuCount: 1,
      memoryBytes: 512 * 1024 * 1024,
      processCount: 32,
      scratchBytes: 128 * 1024 * 1024,
      outputBytes: 128 * 1024,
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
  if (prepared.kind !== 'Prepared') throw new Error('fixture profile invalid');
  expect(
    await DockerRunEnvironment.open({
      profile: prepared.profile,
      image: prepared.profile.imageDigest,
      runtimeMounts: [],
      worktreeDirectory: '/tmp/no-worktree',
      executableRealpaths: ['/nix/store/darwin-only/just'],
      environmentCompatibility: {
        operatingSystem: 'linux',
        architecture: 'arm64',
        nodeVersion: '24.20.0',
        gitVersion: '2.39.5',
        piSdkVersion: '0.87.1',
        xstateVersion: '5.33.2',
      },
      parentDeathCleanupReceipt: Buffer.from('{}'),
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: 'ProfileDrift' });
});

it('never reports confirmed Run cleanup after an earlier OCI removal failed', async () => {
  const construct = DockerRunEnvironment as unknown as new (
    ...arguments_: unknown[]
  ) => DockerRunEnvironment;
  const environment = new construct(
    { close: () => Promise.resolve(false) },
    {},
    'sha256:fixture',
    '/private/worktree',
    {},
    [],
    [],
  );
  expect(await environment.close()).toBe(false);
  expect(await environment.close()).toBe(false);
});
