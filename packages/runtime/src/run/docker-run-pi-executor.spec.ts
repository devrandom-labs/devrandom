import type { ProtectedCredentials, Run } from '@devrandom/domain';
import {
  prepareEvaluationExecutionProfile,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { DockerRunPiExecutor, runWorkerSubmissionReply } from './docker-run-pi-executor.js';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
import type { RunResourceBudget } from './run-resource-budget.js';

const said = (character: string): string => `E${character.repeat(43)}`;

it('rejects a mismatched Run identity before any contained worker or provider request', async () => {
  const profile = prepareEvaluationExecutionProfile({
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
    modelId: 'deepinfra/deepseek-v4-flash-0731',
    thinkingLevel: 'low',
    maximumOutputTokens: 8192,
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
  const calls: string[] = [];
  const executor = new DockerRunPiExecutor({
    profile: profile.profile,
    environment: {
      startWorker: () => {
        calls.push('worker');
        throw new Error('worker must not start');
      },
      close: () => {
        calls.push('close');
        return Promise.resolve(true);
      },
    },
    workerProgram: '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js',
    worktreeBranch: 'devrandom/run/11111111-1111-4111-8111-111111111111',
    instructions: [],
    instructionResources: [],
    prompt: 'Task prompt',
    effectiveLimitsReceipt: Buffer.from('{}'),
    parentDeathCleanupReceipt: Buffer.from('{}'),
    harness: {
      modelCompatibility: {
        provider: 'concentrate',
        model: 'deepinfra/deepseek-v4-flash-0731',
        thinkingLevel: 'low',
        maximumOutputTokens: 8192,
      },
      activeTools: [],
    } as unknown as BaselineHarnessRevision,
    modelAccess: {
      open: () => {
        calls.push('model');
        return Promise.resolve({ kind: 'Unavailable' });
      },
    },
    budget: { reserve: () => ({ kind: 'ReservationInvalid' }) } as unknown as RunResourceBudget,
    gateway: { propose: () => Promise.resolve({ kind: 'DependencyUnavailable' }) },
    evidence: {
      run: { binding: { runId: '11111111-1111-4111-8111-111111111111' } },
      storeArtifact: () => ({ kind: 'Unavailable' }),
      record: () => ({ kind: 'Unavailable' }),
    } as unknown as EvidenceRecorder,
    protectedCredentials: {
      inspect: () => ({ kind: 'Recordable' }),
    } as unknown as ProtectedCredentials,
    now: () => '2026-09-26T05:00:00.000Z',
    sessionId: () => '22222222-2222-4222-8222-222222222222',
  });
  const run = {
    binding: { runId: '33333333-3333-4333-8333-333333333333' },
  } as unknown as Run;
  expect(await executor.invoke(run, new AbortController().signal)).toEqual({
    kind: 'DependencyUnavailable',
  });
  expect(calls).toEqual(['close']);
});

it('stops a C2 submit without returning verifier feedback and accepts only a verified provisional stop', () => {
  expect(
    runWorkerSubmissionReply(true, 'submit_result', {
      kind: 'SubmissionVerified',
      disposition: 'Accepted',
    }),
  ).toEqual({ kind: 'ProvisionalStop', verified: true });
  expect(
    runWorkerSubmissionReply(true, 'submit_result', { kind: 'DependencyUnavailable' }),
  ).toEqual({ kind: 'ProvisionalStop', verified: false });
  expect(
    runWorkerSubmissionReply(false, 'submit_result', {
      kind: 'SubmissionVerified',
      disposition: 'Accepted',
    }),
  ).toEqual({ kind: 'ToolOutcome', verified: false });
});
