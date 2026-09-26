import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationPolicy,
  prepareEvaluationSourceInventory,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { EvaluationPolicyFile } from './evaluation-policy-file.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const taskRevisionSaid = said('a');
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const ownerAid = said('o');

function fixtures() {
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: digest('a'),
    runtimeDigest: digest('b'),
    toolchainDigest: digest('c'),
    sourceGitCommit: 'a'.repeat(40),
    sourceGitTree: 'b'.repeat(40),
    h1InstructionSaid: said('h'),
    h1RuntimePromptDigest: digest('d'),
    effectiveLimitsReceiptSaid: said('l'),
    parentDeathCleanupReceiptSaid: said('p'),
    modelProvider: 'concentrate',
    modelId: 'deepinfra/deepseek-v4-flash-0731',
    thinkingLevel: 'low',
    maximumOutputTokens: 8192,
    limits: {
      cpuCount: 2,
      memoryBytes: 1073741824,
      processCount: 64,
      scratchBytes: 67108864,
      outputBytes: 524288,
      wallTimeSeconds: 3600,
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
  const inventory = prepareEvaluationSourceInventory({
    taskId,
    taskRevisionSaid,
    ownerAid,
    repositoryResourceSaid: said('r'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('m'),
    sources: [
      {
        episodeSaid: said('e'),
        rawEvidenceSaid: said('f'),
        ownerAid,
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (profile.kind !== 'Prepared' || inventory.kind !== 'Prepared')
    throw new Error('fixture rejected');
  const allowance = {
    providerRequests: 2,
    providerInputTokens: 2000,
    providerOutputTokens: 200,
    providerSpendMicroUsd: 200,
    runWallTimeSeconds: 20,
    toolProposals: 20,
    aggregateChildCommandTimeSeconds: 10,
    changedFiles: 2,
    changedWorktreeBytes: 2000,
    evidencePlusArtifactsPerRunBytes: 20000,
  };
  const policy = prepareEvaluationPolicy({
    taskId,
    taskRevisionSaid,
    originRunId,
    expectedActiveRevisionSaid: said('h'),
    executionProfileSaid: profile.profile.d,
    sourceInventorySaid: inventory.inventory.d,
    comparisonLaw: 'ThreeRepetitionsTwoAttemptsPublicSearch',
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (policy.kind !== 'Prepared') throw new Error('policy rejected');
  return { profile: profile.profile, inventory: inventory.inventory, policy: policy.policy };
}

it('reads only a SAID-bound policy and its exact sibling profile/source documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-evaluation-policy-'));
  try {
    const { profile, inventory, policy } = fixtures();
    const path = join(directory, 'policy.json');
    await writeFile(path, JSON.stringify(policy));
    await writeFile(join(directory, `${profile.d}.json`), JSON.stringify(profile));
    await writeFile(join(directory, `${inventory.d}.json`), JSON.stringify(inventory));
    expect(await new EvaluationPolicyFile().read(path)).toEqual({
      kind: 'Read',
      policy,
      profile,
      inventory,
    });
    await writeFile(
      join(directory, `${profile.d}.json`),
      JSON.stringify({ ...profile, modelId: 'other' }),
    );
    expect(await new EvaluationPolicyFile().read(path)).toEqual({ kind: 'Rejected' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects symlink policy files and missing exact references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-evaluation-policy-'));
  try {
    const { policy } = fixtures();
    const target = join(directory, 'target.json');
    const link = join(directory, 'policy.json');
    await writeFile(target, JSON.stringify(policy));
    await symlink(target, link);
    expect(await new EvaluationPolicyFile().read(link)).toEqual({ kind: 'Rejected' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
