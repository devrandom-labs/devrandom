import { randomUUID } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvaluationExecutionProfile,
  prepareEvaluationManifest,
  prepareEvidenceArtifact,
  prepareSuccessorHarnessRevision,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { bindC1TrialBehavior } from './bind-c1-trial-behavior.js';
import { digestRunRuntimePrompt } from '../../run/run-execution-profile-custody.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const utf8 = new TextEncoder();

function fixture() {
  const baseSystemPrompt = 'Original H1 instructions';
  const taskPrompt = 'Public Task';
  const instruction = identifyHarnessInstruction({ path: 'AGENTS.md', content: '# H1\n' });
  const completion = identifyHarnessCompletionCommand(
    {
      id: 'public-test',
      argv: ['just', 'test-public'],
      timeoutSeconds: 120,
      expected: { kind: 'exitCode', code: 0 },
    },
    '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
  );
  if (instruction.kind !== 'Identified' || completion.kind !== 'Identified')
    throw new Error('fixture resources');
  const h1Prepared = prepareBaselineHarnessRevision({
    task: {
      taskId: randomUUID(),
      revisionSaid: said('t'),
      harnessLineageId: randomUUID(),
      requestedCapabilities: ['ReadRepository'],
    },
    authority: {
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      allowedCapabilities: ['ReadRepository'],
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      instructionResources: [instruction.resource],
    },
    completionCommands: [completion.command],
    toolCommands: [],
    modelCompatibility: {
      provider: 'test',
      model: 'pinned-model',
      contextWindowTokens: 100_000,
      maximumOutputTokens: 2_000,
      thinkingLevel: 'off',
      credentialSource: 'TEST_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'linux',
      architecture: 'x64',
      nodeVersion: '24.20.0',
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
  if (h1Prepared.kind !== 'Prepared') throw new Error('fixture H1');
  const h1 = h1Prepared.revision;
  const profilePrepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'1'.repeat(64)}`,
    runtimeDigest: `sha256:${'2'.repeat(64)}`,
    toolchainDigest: `sha256:${'3'.repeat(64)}`,
    sourceGitCommit: h1.repository.commit,
    sourceGitTree: h1.repository.tree,
    h1InstructionSaid: said('i'),
    h1RuntimePromptDigest: digestRunRuntimePrompt(baseSystemPrompt, taskPrompt),
    effectiveLimitsReceiptSaid: said('l'),
    parentDeathCleanupReceiptSaid: said('p'),
    modelProvider: 'test',
    modelId: 'pinned-model',
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
  if (profilePrepared.kind !== 'Prepared') throw new Error('fixture profile');
  const profile = profilePrepared.profile;
  const treatmentBytes = utf8.encode(
    JSON.stringify({ version: 1, arm: 'C1', instructionText: 'Use the reviewed public format.' }),
  );
  const artifact = prepareEvidenceArtifact(treatmentBytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('fixture treatment');
  const successorPrepared = prepareSuccessorHarnessRevision({
    parentRevisionSaid: h1.d,
    arm: 'C1',
    h0Said: said('h'),
    taskRevisionSaid: h1.task.revisionSaid,
    sourceInventorySaid: said('s'),
    executionProfileSaid: profile.d,
    configurationArtifactSaid: artifact.artifact.d,
    treatment: { kind: 'Instruction' },
  });
  if (successorPrepared.kind !== 'Prepared') throw new Error('fixture successor');
  const successor = successorPrepared.revision;
  const allowance = {
    providerRequests: 3,
    providerInputTokens: 3000,
    providerOutputTokens: 300,
    providerSpendMicroUsd: 300,
    runWallTimeSeconds: 60,
    toolProposals: 10,
    aggregateChildCommandTimeSeconds: 60,
    changedFiles: 3,
    changedWorktreeBytes: 10000,
    evidencePlusArtifactsPerRunBytes: 100000,
  };
  const manifestPrepared = prepareEvaluationManifest({
    evaluationId: randomUUID(),
    taskId: h1.task.taskId,
    taskRevisionSaid: h1.task.revisionSaid,
    originRunId: randomUUID(),
    ownerAid: said('o'),
    personalAgentAid: h1.authority.personalAgentAid,
    taskMandateSaid: h1.authority.taskMandateSaid,
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('d'),
    policySaid: said('e'),
    revisions: { H1: h1.d, C1: successor.d, C2: said('j'), C3: said('k') },
    executionProfileSaid: profile.d,
    sourceInventorySaid: said('s'),
    hypothesisSaid: said('h'),
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('f'),
    finalCaseArtifactSaid: said('g'),
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (manifestPrepared.kind !== 'Prepared') throw new Error('fixture manifest');
  const input = {
    reviewed: {
      h1,
      successorRevisionSaid: successor.d,
      binding: {
        parentRevisionSaid: h1.d,
        arm: 'C1' as const,
        h0Said: said('h'),
        taskRevisionSaid: h1.task.revisionSaid,
        sourceInventorySaid: said('s'),
        executionProfileSaid: profile.d,
      },
      treatment: successor.treatment,
      configuration: artifact.artifact,
    },
    treatmentBytes,
    successorBytes: utf8.encode(JSON.stringify(successor)),
    manifest: manifestPrepared.manifest,
    profile,
    baseSystemPrompt,
    taskPrompt,
    candidateCommit: '4'.repeat(40),
    candidateTree: '5'.repeat(40),
  };
  return input;
}

describe('C1 trial behavior binding', () => {
  it('refuses missing reviewed candidate custody before any worker Start', () => {
    expect(
      bindC1TrialBehavior({
        reviewed: undefined,
        treatmentBytes: new Uint8Array(),
        successorBytes: new Uint8Array(),
        manifest: undefined,
        profile: undefined,
        baseSystemPrompt: 'H1',
        taskPrompt: 'Task',
        candidateCommit: '1'.repeat(40),
        candidateTree: '2'.repeat(40),
      }),
    ).toMatchObject({ kind: 'Blocked' });
  });

  it('binds exact reviewed C1 bytes and H1 prompt to a distinct worker Start digest', () => {
    const input = fixture();
    const bound = bindC1TrialBehavior(input);
    expect(bound).toMatchObject({
      kind: 'Bound',
      treatmentArtifactSaid: input.reviewed.configuration.d,
    });
    if (bound.kind !== 'Bound') return;
    expect(bound.systemPrompt).toContain('Use the reviewed public format.');
    expect(bound.promptDigest).toBe(digestRunRuntimePrompt(bound.systemPrompt, input.taskPrompt));
    expect(bound.promptDigest).not.toBe(input.profile.h1RuntimePromptDigest);
    expect(JSON.parse(Buffer.from(bound.receiptBytes).toString('utf8'))).toMatchObject({
      successorRevisionSaid: input.reviewed.successorRevisionSaid,
      treatmentArtifactSaid: input.reviewed.configuration.d,
      workerPromptDigest: bound.promptDigest,
    });
  });

  it('rejects substitution, unsupported keys, and baseline prompt drift', () => {
    const input = fixture();
    expect(
      bindC1TrialBehavior({
        ...input,
        treatmentBytes: utf8.encode(
          JSON.stringify({ version: 1, arm: 'C1', instructionText: 'changed' }),
        ),
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Treatment' });
    expect(
      bindC1TrialBehavior({
        ...input,
        treatmentBytes: utf8.encode(
          JSON.stringify({
            version: 1,
            arm: 'C1',
            instructionText: 'approved',
            authority: 'override',
          }),
        ),
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Treatment' });
    expect(bindC1TrialBehavior({ ...input, baseSystemPrompt: 'forged H1' })).toEqual({
      kind: 'Blocked',
      reason: 'Prompt',
    });
    expect(
      bindC1TrialBehavior({
        ...input,
        manifest: { ...input.manifest, revisions: { ...input.manifest.revisions, C1: said('x') } },
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Revision' });
  });
});
