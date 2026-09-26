import { describe, expect, it } from 'vitest';

import { harnessCommandFingerprint } from './harness-http.js';
import { prepareBaselineHarnessRevision } from './harness-revision.js';
import { taskBudgetCeilings } from '../task/task-command.js';

const commandId = 'c77a608e-a44d-4546-a530-23a2f2f337ec';

function command() {
  const prepared = prepareBaselineHarnessRevision({
    toolCommands: [],
    task: {
      taskId: 'f88659c7-4060-4823-830c-a76cddec5346',
      revisionSaid: 'E'.concat('a'.repeat(43)),
      harnessLineageId: '976592b2-e749-47aa-899b-8e716a9d86f8',
      requestedCapabilities: ['ReadRepository'],
    },
    authority: {
      personalAgentAid: 'E'.concat('b'.repeat(43)),
      taskMandateSaid: 'E'.concat('c'.repeat(43)),
      allowedCapabilities: ['ReadRepository'],
    },
    repository: {
      objectFormat: 'sha1',
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      instructionResources: [],
    },
    completionCommands: [
      {
        identity: 'verify',
        contentSaid: 'E'.concat('f'.repeat(43)),
        executableRealpath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
        argv: ['just', 'check'],
        timeoutSeconds: 300,
        expectedExitCode: 0,
      },
    ],
    modelCompatibility: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindowTokens: 64_000,
      maximumOutputTokens: 8_000,
      thinkingLevel: 'off',
      credentialSource: 'DEEPSEEK_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.8.0',
      gitVersion: '2.51.0',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    capabilities: { available: ['ReadRepository'], unavailable: [] },
    budgetCeilings: {
      task: taskBudgetCeilings,
      server: taskBudgetCeilings,
      mandate: taskBudgetCeilings,
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`expected H1 preparation, received ${prepared.kind}`);
  }
  return { version: 1 as const, commandId, revision: prepared.revision };
}

describe('Harness admission command fingerprint', () => {
  it('uses the normative SHA-256/JCS shape and excludes the idempotency command identity', () => {
    const admitted = command();

    expect(harnessCommandFingerprint(admitted)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      harnessCommandFingerprint({
        ...admitted,
        commandId: '78c0855c-878e-443f-8091-139e59b0f5bf',
      }),
    ).toBe(harnessCommandFingerprint(admitted));
  });
});
