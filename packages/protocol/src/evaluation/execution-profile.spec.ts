import { describe, expect, it } from 'vitest';

import {
  decodeEvaluationExecutionProfile,
  prepareEvaluationExecutionProfile,
} from './execution-profile.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const input = {
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
};

describe('pinned Linux comparison profile', () => {
  it('binds H1 runtime prompt and effective containment inputs', () => {
    const prepared = prepareEvaluationExecutionProfile(input);
    if (prepared.kind !== 'Prepared') throw new Error('profile rejected');
    expect(decodeEvaluationExecutionProfile(prepared.profile)).toEqual({
      kind: 'Accepted',
      profile: prepared.profile,
    });
  });

  it('rejects Darwin relabeling, missing isolation and absent runtime prompt binding', () => {
    for (const changed of [
      { ...input, os: 'darwin' },
      { ...input, containment: { ...input.containment, networkDisabled: false } },
      { ...input, h1RuntimePromptDigest: undefined },
    ]) {
      expect(prepareEvaluationExecutionProfile(changed).kind).toBe('Rejected');
    }
  });
});
