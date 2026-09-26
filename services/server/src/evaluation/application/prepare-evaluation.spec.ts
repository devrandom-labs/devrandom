import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
} from '@devrandom/protocol';

import { prepareEvaluation } from './prepare-evaluation.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

describe('evaluation preparation authority', () => {
  it('requires current Task/Mandate source scope before storing a signed inventory', async () => {
    const ownerAid = said('o');
    const taskId = randomUUID();
    const taskRevisionSaid = said('t');
    const repositoryResourceSaid = said('r');
    const corpusSaid = said('c');
    const mandateSaid = said('m');
    const inventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid,
      ownerAid,
      repositoryResourceSaid,
      corpusSaid,
      experienceMandateSaid: mandateSaid,
      sources: [
        {
          episodeSaid: said('e'),
          rawEvidenceSaid: said('a'),
          ownerAid,
          repositoryResourceSaid,
          corpusSaid,
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error(inventory.reason);
    const profile = prepareEvaluationExecutionProfile({
      os: 'linux',
      architecture: 'x86_64',
      imageDigest: `sha256:${'1'.repeat(64)}`,
      runtimeDigest: `sha256:${'2'.repeat(64)}`,
      toolchainDigest: `sha256:${'3'.repeat(64)}`,
      sourceGitCommit: 'a'.repeat(40),
      sourceGitTree: 'b'.repeat(40),
      h1InstructionSaid: said('i'),
      h1RuntimePromptDigest: `sha256:${'4'.repeat(64)}`,
      effectiveLimitsReceiptSaid: said('l'),
      parentDeathCleanupReceiptSaid: said('p'),
      modelProvider: 'test',
      modelId: 'test',
      thinkingLevel: 'off',
      maximumOutputTokens: 100,
      limits: {
        cpuCount: 1,
        memoryBytes: 128 * 1024 * 1024,
        processCount: 16,
        scratchBytes: 1024 * 1024,
        outputBytes: 1024,
        wallTimeSeconds: 45,
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
    if (profile.kind !== 'Prepared') throw new Error(profile.reason);
    const command = {
      version: 1 as const,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      taskId,
      taskRevisionSaid,
      sourceInventory: inventory.inventory,
      executionProfile: profile.profile,
    };
    const scope = {
      ownerAid,
      taskId,
      taskRevisionSaid,
      repositoryResourceSaid,
      allowedCorpusSaid: corpusSaid,
      mandate: { kind: 'AuthorizedExperience' as const, mandateSaid },
    };
    const store = vi.fn(() => Promise.resolve('Prepared' as const));
    expect(
      await prepareEvaluation(
        { ownerAid, command },
        {
          scopes: {
            inspect: () =>
              Promise.resolve({
                kind: 'Authorized',
                scope: {
                  ...scope,
                  allowedCorpusSaid: said('x'),
                },
              }),
          },
          storage: { store },
        },
      ),
    ).toBe('Rejected');
    expect(store).not.toHaveBeenCalled();
    expect(
      await prepareEvaluation(
        { ownerAid, command },
        {
          scopes: { inspect: () => Promise.resolve({ kind: 'Authorized', scope }) },
          storage: { store },
        },
      ),
    ).toBe('Prepared');
    expect(store).toHaveBeenCalledOnce();
  });
});
