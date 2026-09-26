import { randomUUID } from 'node:crypto';

import {
  identifyHarnessInstruction,
  prepareEvaluationExecutionProfile,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import {
  bindRunExecutionProfile,
  digestRunRuntimePrompt,
} from './run-execution-profile-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function fixture() {
  const instruction = { path: 'AGENTS.md', content: 'Use the nine mediated tools.\n' };
  const identified = identifyHarnessInstruction(instruction);
  if (identified.kind !== 'Identified') throw new Error('fixture instruction invalid');
  const resource = identified.resource;
  const inventory = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunH1InstructionInventory',
      resources: [resource],
    }),
  );
  const inventoryArtifact = prepareEvidenceArtifact(inventory, 'application/json');
  const limits = Buffer.from(JSON.stringify({ kind: 'RunEffectiveLimits', worker: 1, native: 1 }));
  const limitsArtifact = prepareEvidenceArtifact(limits, 'application/json');
  const cleanup = Buffer.from(JSON.stringify({ kind: 'RunParentDeathCleanup', observed: true }));
  const cleanupArtifact = prepareEvidenceArtifact(cleanup, 'application/json');
  if (
    inventoryArtifact.kind !== 'Prepared' ||
    limitsArtifact.kind !== 'Prepared' ||
    cleanupArtifact.kind !== 'Prepared'
  )
    throw new Error('fixture artifacts invalid');
  const systemPrompt =
    '<instruction path="AGENTS.md">\nUse the nine mediated tools.\n\n</instruction>';
  const taskPrompt = 'Task prompt';
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: 'd'.repeat(40),
    sourceGitTree: 'e'.repeat(40),
    h1InstructionSaid: inventoryArtifact.artifact.d,
    h1RuntimePromptDigest: digestRunRuntimePrompt(systemPrompt, taskPrompt),
    effectiveLimitsReceiptSaid: limitsArtifact.artifact.d,
    parentDeathCleanupReceiptSaid: cleanupArtifact.artifact.d,
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
  if (profile.kind !== 'Prepared') throw new Error('fixture profile invalid');
  const runId = randomUUID();
  const calls: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const evidence = {
    run: {
      binding: {
        runId,
        repository: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
      },
    },
    storeArtifact: ({ bytes, mediaType }: { bytes: Uint8Array; mediaType: string }) => {
      const artifact = prepareEvidenceArtifact(bytes, mediaType);
      if (artifact.kind !== 'Prepared') return { kind: 'ArtifactRejected' as const };
      calls.push(`artifact:${artifact.artifact.d}`);
      stored.set(artifact.artifact.d, bytes);
      return { kind: 'Stored' as const, artifact: artifact.artifact };
    },
    record: ({ event }: { event: { kind: string; profileArtifactSaid?: string } }) => {
      calls.push(`event:${event.kind}`);
      expect(event.profileArtifactSaid).toBeDefined();
      expect(stored.has(event.profileArtifactSaid ?? '')).toBe(true);
      return { kind: 'Recorded' as const, event: { d: said('z') } };
    },
  };
  return {
    instruction,
    resource,
    inventory,
    limits,
    cleanup,
    systemPrompt,
    taskPrompt,
    profile: profile.profile,
    runId,
    evidence,
    calls,
  };
}

it('stores the exact H1 inventory, limits, cleanup proof and profile before binding the Run event', () => {
  const source = fixture();
  const bound = bindRunExecutionProfile({
    profile: source.profile,
    instructions: [source.instruction],
    instructionResources: [source.resource],
    systemPrompt: source.systemPrompt,
    taskPrompt: source.taskPrompt,
    effectiveLimitsReceipt: source.limits,
    parentDeathCleanupReceipt: source.cleanup,
    worktreeBranch: `devrandom/run/${source.runId}`,
    evidence: source.evidence,
    now: () => '2026-09-26T05:00:00.000Z',
  });
  expect(bound.kind).toBe('Bound');
  if (bound.kind !== 'Bound') return;
  expect(bound.profileArtifactSaid).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
  expect(bound.eventSaid).toBe(said('z'));
  expect(source.calls).toHaveLength(5);
  expect(source.calls.at(-1)).toBe('event:RunExecutionProfileBound');
  expect(source.calls.slice(0, 4).every((call) => call.startsWith('artifact:'))).toBe(true);
});

it('rejects a forged effective-limits receipt before any event or artifact is stored', () => {
  const source = fixture();
  const forged = Buffer.from(JSON.stringify({ kind: 'RunEffectiveLimits', worker: 0, native: 1 }));
  expect(
    bindRunExecutionProfile({
      profile: source.profile,
      instructions: [source.instruction],
      instructionResources: [source.resource],
      systemPrompt: source.systemPrompt,
      taskPrompt: source.taskPrompt,
      effectiveLimitsReceipt: forged,
      parentDeathCleanupReceipt: source.cleanup,
      worktreeBranch: `devrandom/run/${source.runId}`,
      evidence: source.evidence,
      now: () => '2026-09-26T05:00:00.000Z',
    }),
  ).toMatchObject({ kind: 'Rejected' });
  expect(source.calls).toEqual([]);
});
