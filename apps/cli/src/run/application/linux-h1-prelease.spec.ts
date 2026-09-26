import {
  identifyHarnessCompletionCommand,
  prepareEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import { digestRunRuntimePrompt, runInstructionPrompt } from '@devrandom/runtime';
import { describe, expect, it } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { baselineTaskPrompt } from './baseline-execution-inputs.js';
import { inspectLinuxH1PreLease } from './linux-h1-prelease.js';

const cargo = '/usr/local/rustup/toolchains/1.98.1-aarch64-unknown-linux-gnu/bin/cargo';

function artifact(bytes: Uint8Array): string {
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw new Error('artifact fixture invalid');
  return prepared.artifact.d;
}

function fixture() {
  const baseline = taskProjectionFixture();
  const task = {
    ...baseline,
    revision: {
      ...baseline.revision,
      completionConditions: baseline.revision.completionConditions.map((command) => ({
        ...command,
        argv: ['cargo', 'test'],
      })),
    },
  } as typeof baseline;
  const initial = baselineHarnessCommandFixture(task).revision;
  const harness = {
    ...initial,
    environmentCompatibility: {
      ...initial.environmentCompatibility,
      operatingSystem: 'linux' as const,
      architecture: 'arm64' as const,
    },
    modelCompatibility: {
      ...initial.modelCompatibility,
      provider: 'concentrate',
      model: 'deepinfra/gemma-4-e4b',
      thinkingLevel: 'low' as const,
      maximumOutputTokens: 4096,
    },
    completionCommands: task.revision.completionConditions.map((condition) => {
      const identified = identifyHarnessCompletionCommand(condition, cargo);
      if (identified.kind !== 'Identified') throw new Error('cargo command fixture invalid');
      return identified.command;
    }),
  } as BaselineHarnessRevision;
  const instructions = [{ path: 'AGENTS.md', content: '# Task repository rules\n' }];
  const inventory = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunH1InstructionInventory',
      resources: harness.repository.instructionResources,
    }),
  );
  const limits = Buffer.from('{"effective":"bounded"}');
  const cleanup = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'RunParentDeathCleanup',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      runtimeDigest: `sha256:${'b'.repeat(64)}`,
      architecture: 'aarch64',
      limits: {
        cpuCount: 1,
        memoryBytes: 128 * 1024 * 1024,
        processCount: 16,
        scratchBytes: 1024 * 1024,
        outputBytes: 64 * 1024,
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
  const prepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: task.revision.repository.commit,
    sourceGitTree: task.revision.repository.tree,
    h1InstructionSaid: artifact(inventory),
    h1RuntimePromptDigest: digestRunRuntimePrompt(
      runInstructionPrompt(instructions),
      baselineTaskPrompt(task),
    ),
    effectiveLimitsReceiptSaid: artifact(limits),
    parentDeathCleanupReceiptSaid: artifact(cleanup),
    modelProvider: harness.modelCompatibility.provider,
    modelId: harness.modelCompatibility.model,
    thinkingLevel: harness.modelCompatibility.thinkingLevel,
    maximumOutputTokens: harness.modelCompatibility.maximumOutputTokens,
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
  if (prepared.kind !== 'Prepared') throw new Error('profile fixture invalid');
  return {
    task,
    harness,
    instructions,
    profile: prepared.profile,
    limits,
    cleanup,
    cargoRealpath: cargo,
  };
}

describe('Linux H1 profile before Run lease', () => {
  it('accepts the exact Task source, H1 instructions, prompt, model and receipts', () => {
    expect(inspectLinuxH1PreLease(fixture())).toEqual({ kind: 'Compatible' });
  });

  it.each([
    'Source',
    'Instruction',
    'Prompt',
    'Model',
    'Limits',
    'Cleanup',
    'Environment',
    'Cargo',
    'Completion',
  ] as const)('rejects a changed %s before a Run lease', (part) => {
    const base = fixture();
    const changed = {
      ...base,
      ...(part === 'Source'
        ? {
            task: {
              ...base.task,
              revision: {
                ...base.task.revision,
                repository: { ...base.task.revision.repository, tree: 'f'.repeat(40) },
              },
            },
          }
        : {}),
      ...(part === 'Instruction'
        ? { instructions: [{ path: 'AGENTS.md', content: '# Changed rules\n' }] }
        : {}),
      ...(part === 'Prompt'
        ? {
            task: {
              ...base.task,
              revision: { ...base.task.revision, objective: 'Changed objective' },
            },
          }
        : {}),
      ...(part === 'Model'
        ? {
            harness: {
              ...base.harness,
              modelCompatibility: { ...base.harness.modelCompatibility, model: 'other' },
            },
          }
        : {}),
      ...(part === 'Limits' ? { limits: Buffer.from('{}') } : {}),
      ...(part === 'Cleanup' ? { cleanup: Buffer.from('{}') } : {}),
      ...(part === 'Environment'
        ? {
            harness: {
              ...base.harness,
              environmentCompatibility: {
                ...base.harness.environmentCompatibility,
                operatingSystem: 'darwin' as const,
              },
            },
          }
        : {}),
      ...(part === 'Cargo' ? { cargoRealpath: '/usr/bin/cargo' } : {}),
      ...(part === 'Completion'
        ? {
            harness: {
              ...base.harness,
              completionCommands: base.harness.completionCommands.map((command) => ({
                ...command,
                timeoutSeconds: command.timeoutSeconds + 1,
              })),
            },
          }
        : {}),
    };
    expect(inspectLinuxH1PreLease(changed)).toEqual({ kind: 'Rejected' });
  });
});
