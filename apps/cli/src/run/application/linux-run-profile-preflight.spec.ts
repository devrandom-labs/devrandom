import type { Run } from '@devrandom/domain';
import {
  identifyHarnessInstruction,
  prepareEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import { digestRunRuntimePrompt, runInstructionPrompt } from '@devrandom/runtime';
import { expect, it } from 'vitest';

import type { BaselineExecutionInputs } from './baseline-execution-inputs.js';
import { inspectLinuxRunProfile } from './linux-run-profile-preflight.js';
import type { PreparedRunWorktree } from './run-worktree.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function fixture() {
  const runId = '11111111-1111-4111-8111-111111111111';
  const instruction = { path: 'AGENTS.md', content: 'Public H1 instruction.' };
  const identified = identifyHarnessInstruction(instruction);
  if (identified.kind !== 'Identified') throw new Error('instruction fixture invalid');
  const inventory = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunH1InstructionInventory',
      resources: [identified.resource],
    }),
  );
  const limits = Buffer.from('{"effective":"bounded"}');
  const cleanup = Buffer.from('{"cleanup":"observed"}');
  const artifact = (bytes: Uint8Array) => {
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture invalid');
    return prepared.artifact.d;
  };
  const modelCompatibility = {
    provider: 'concentrate',
    model: 'deepinfra/deepseek-v4-flash-0731',
    thinkingLevel: 'low',
    maximumOutputTokens: 8192,
  };
  const harness = {
    d: said('h'),
    modelCompatibility,
    environmentCompatibility: {
      operatingSystem: 'linux',
      architecture: 'arm64',
      nodeVersion: '24.20.0',
      gitVersion: '2.39.5',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    repository: { instructionResources: [identified.resource] },
    completionCommands: [{ executableRealpath: '/usr/bin/true' }],
    toolCommands: [],
  } as unknown as BaselineHarnessRevision;
  const run = {
    binding: {
      runId,
      initialHarnessRevisionSaid: harness.d,
      repository: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    },
  } as Run;
  const worktree = {
    directory: '/private/run/worktree',
    branch: `devrandom/run/${runId}`,
    repository: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  } as PreparedRunWorktree;
  const inputs = {
    harness,
    instructions: [instruction],
    prompt: 'Public Task prompt',
  } as unknown as BaselineExecutionInputs;
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    runtimeDigest: `sha256:${'d'.repeat(64)}`,
    toolchainDigest: `sha256:${'e'.repeat(64)}`,
    sourceGitCommit: 'a'.repeat(40),
    sourceGitTree: 'b'.repeat(40),
    h1InstructionSaid: artifact(inventory),
    h1RuntimePromptDigest: digestRunRuntimePrompt(
      runInstructionPrompt([instruction]),
      inputs.prompt,
    ),
    effectiveLimitsReceiptSaid: artifact(limits),
    parentDeathCleanupReceiptSaid: artifact(cleanup),
    modelProvider: modelCompatibility.provider,
    modelId: modelCompatibility.model,
    thinkingLevel: modelCompatibility.thinkingLevel,
    maximumOutputTokens: modelCompatibility.maximumOutputTokens,
    limits: {
      cpuCount: 1,
      memoryBytes: 128 * 1024 * 1024,
      processCount: 16,
      scratchBytes: 1024 * 1024,
      outputBytes: 64 * 1024,
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
  if (profile.kind !== 'Prepared') throw new Error('profile fixture invalid');
  return { run, worktree, harness, inputs, profile: profile.profile, limits, cleanup };
}

it('accepts only exact H1 instruction, prompt, source, model and command bindings', () => {
  const source = fixture();
  expect(
    inspectLinuxRunProfile({
      ...source,
      effectiveLimitsReceipt: source.limits,
      parentDeathCleanupReceipt: source.cleanup,
    }),
  ).toEqual({ kind: 'Ready', executableRealpaths: ['/usr/bin/true'] });
  expect(
    inspectLinuxRunProfile({
      ...source,
      harness: {
        ...source.harness,
        environmentCompatibility: {
          ...source.harness.environmentCompatibility,
          operatingSystem: 'darwin',
        },
      },
      effectiveLimitsReceipt: source.limits,
      parentDeathCleanupReceipt: source.cleanup,
    }),
  ).toEqual({ kind: 'ProfileDrift', reason: 'EnvironmentBindingMismatch' });
  expect(
    inspectLinuxRunProfile({
      ...source,
      inputs: { ...source.inputs, prompt: 'Forged Task prompt' },
      effectiveLimitsReceipt: source.limits,
      parentDeathCleanupReceipt: source.cleanup,
    }),
  ).toEqual({ kind: 'ProfileDrift', reason: 'PromptMismatch' });
});
