import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
  prepareEvolutionHypothesis,
  prepareEvidenceArtifact,
  type BaselineHarnessRevision,
  type EvaluationExecutionProfile,
  type EvaluationSourceInventory,
  type EvolutionHypothesis,
} from '@devrandom/protocol';
import { digestRunRuntimePrompt } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { ParentSuccessorBehaviorReplay } from './parent-successor-behavior-replay.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const baseSystemPrompt = 'Trusted public H1 system';
const taskPrompt = 'Repair the public CESR parser';

function fixture(implicatedComponent: EvolutionHypothesis['implicatedComponent'] = 'Workflow') {
  const instruction = identifyHarnessInstruction({ path: 'AGENTS.md', content: '# public\n' });
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
    throw new Error('resources');
  const h1 = prepareBaselineHarnessRevision({
    task: {
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      revisionSaid: said('t'),
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
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
  if (h1.kind !== 'Prepared') throw new Error('H1');
  const inventory = prepareEvaluationSourceInventory({
    taskId: h1.revision.task.taskId,
    taskRevisionSaid: h1.revision.task.revisionSaid,
    ownerAid: said('a'),
    repositoryResourceSaid: said('o'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('m'),
    sources: [
      {
        episodeSaid: said('e'),
        rawEvidenceSaid: said('v'),
        ownerAid: said('a'),
        repositoryResourceSaid: said('o'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (inventory.kind !== 'Prepared') throw new Error('inventory');
  const hypothesis = prepareEvolutionHypothesis({
    taskId: h1.revision.task.taskId,
    taskRevisionSaid: h1.revision.task.revisionSaid,
    originRunId: '019db52c-c9df-44e9-8f8f-9d8cf42d88d5',
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('l'),
    parentRevisionSaid: h1.revision.d,
    personalAgentAid: h1.revision.authority.personalAgentAid,
    sourceInventorySaid: inventory.inventory.d,
    retrievalReceiptSaid: said('r'),
    failure: { eventSaid: said('f'), rawEvidenceSaid: said('g') },
    source: { episodeSaid: said('e'), rawEvidenceSaid: said('v') },
    implicatedComponent,
    predictedCorrection: 'Use public source and verifier',
    publicReplay: {
      failureWindowSaid: said('w'),
      configurationSaid: said('q'),
      nonTreatmentInputsSaid: said('n'),
      failureQuery: 'public parser failure',
      predictedAction: 'Inspect exact source then run public verifier.',
      predictedSourceChoiceSaid: said('y'),
      assertion: 'public source changes action',
    },
    falsifier: 'public verifier still fails',
    regressionRisks: ['one risk'],
    rejectedExplanations: ['another explanation'],
  });
  if (hypothesis.kind !== 'Prepared') throw new Error('H0');
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: h1.revision.repository.commit,
    sourceGitTree: h1.revision.repository.tree,
    h1InstructionSaid: instruction.resource.contentSaid,
    h1RuntimePromptDigest: digestRunRuntimePrompt(baseSystemPrompt, taskPrompt),
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
  if (profile.kind !== 'Prepared') throw new Error('profile');
  const acceptedH1: BaselineHarnessRevision = h1.revision;
  const acceptedInventory: EvaluationSourceInventory = inventory.inventory;
  const acceptedHypothesis: EvolutionHypothesis = hypothesis.hypothesis;
  const acceptedProfile: EvaluationExecutionProfile = profile.profile;
  const raw = Buffer.from('public analogue');
  const publicSource = prepareEvidenceArtifact(
    Buffer.from('Current version framing public contract'),
    'text/plain; charset=utf-8',
  );
  if (publicSource.kind !== 'Prepared') throw new Error('source');
  const c2 = {
    retrieval: {
      retrieve: vi.fn().mockResolvedValue({
        kind: 'Retrieved',
        queryReceiptSaid: said('r'),
        chargedMicroUsd: 0,
        sources: [{ episodeSaid: said('e'), rawEvidenceSaid: said('v'), score: 0.9 }],
      }),
    },
    reading: {
      read: vi.fn().mockResolvedValue({
        kind: 'Read',
        bytes: raw,
        totalBytes: raw.byteLength,
        sourceSaid: said('e'),
        readReceiptSaid: said('d'),
      }),
    },
    projection: {
      project: vi.fn().mockResolvedValue({
        kind: 'Projected',
        episodeSaid: said('e'),
        rawEvidenceSaid: said('v'),
        readReceiptSaid: said('d'),
        observation: 'Public version mismatch',
        recoveryHint: 'Inspect exact parser',
      }),
    },
    choice: {
      recalculate: vi
        .fn()
        .mockImplementation(({ view }: { view: { sources: readonly unknown[] } }) =>
          Promise.resolve(
            view.sources.length === 0
              ? { kind: 'Unsupported', sourceSpecificTo: said('e') }
              : {
                  kind: 'Chosen',
                  action: hypothesis.hypothesis.publicReplay.predictedAction,
                  sourceChoiceSaid: said('y'),
                  citationSaids: [said('e')],
                },
          ),
        ),
    },
  };
  const c3 = {
    history: {
      read: vi.fn().mockResolvedValue({
        kind: 'Read',
        edit: { path: 'src/lib.rs', content: 'Current version edit' },
        sources: [
          {
            sourceId: publicSource.artifact.d,
            artifact: publicSource.artifact,
            bytes: Buffer.from('Current version framing public contract'),
            kind: 'Contract',
            version: 'Current',
            custody: 'Public',
          },
        ],
      }),
    },
    projection: {
      project: vi.fn().mockImplementation(({ sourceId }: { sourceId: string }) =>
        Promise.resolve({
          kind: 'Projected',
          sourceId,
          text: 'Current version framing public contract',
        }),
      ),
    },
  };
  const behavior = new ParentSuccessorBehaviorReplay({
    h1: acceptedH1,
    hypothesis: acceptedHypothesis,
    inventory: acceptedInventory,
    profile: acceptedProfile,
    baseSystemPrompt,
    taskPrompt,
    c2,
    c3,
  });
  function input(arm: 'C1' | 'C2' | 'C3') {
    const configurationBytes = Buffer.from(
      JSON.stringify(
        arm === 'C1'
          ? {
              version: 1,
              arm,
              instructionText: 'Run the public compatibility verifier before completion.',
            }
          : arm === 'C2'
            ? { version: 1, arm }
            : {
                version: 1,
                arm,
                formatMarker: 'Current',
                triggerPaths: ['src/lib.rs'],
                priority: ['Failure', 'Contract', 'Edit'],
                maximumItems: 3,
                maximumContextBytes: 2048,
              },
      ),
    );
    const implementationBytes =
      arm === 'C1'
        ? undefined
        : Buffer.from(
            JSON.stringify(
              arm === 'C2'
                ? {
                    version: 1,
                    kind: 'RecoveryWorkflow',
                    trigger: 'QualifiedRetainedFailure',
                    steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
                  }
                : {
                    version: 1,
                    kind: 'VersionedFormatContextSelection',
                    algorithm: 'ExactPublicHistoryV1',
                  },
            ),
          );
    const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
    const implementation =
      implementationBytes === undefined
        ? undefined
        : prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
    if (
      configuration.kind !== 'Prepared' ||
      (implementation !== undefined && implementation.kind !== 'Prepared')
    )
      throw new Error('treatment');
    return {
      h0Said: acceptedHypothesis.d,
      sourceInventorySaid: acceptedInventory.d,
      arm,
      h1Commit: acceptedH1.repository.commit,
      h1Tree: acceptedH1.repository.tree,
      sourceDirectory: '/tmp/public-source',
      configurationArtifactSaid: configuration.artifact.d,
      configuration: { artifact: configuration.artifact, bytes: configurationBytes },
      ...(implementation === undefined || implementationBytes === undefined
        ? {}
        : {
            reviewedImplementationSaid: implementation.artifact.d,
            implementation: { artifact: implementation.artifact, bytes: implementationBytes },
          }),
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: acceptedProfile.d,
      publicConditions: [],
      signal: new AbortController().signal,
    };
  }
  return { behavior, input, c2, c3, hypothesis: acceptedHypothesis };
}

describe('parent successor candidate behavior replay', () => {
  it.each(['Instruction', 'Workflow', 'ContextSelection'] as const)(
    'replays all three remedies against the exact %s hypothesis without preselecting an arm',
    async (component) => {
      const ready = fixture(component);
      const c1 = await ready.behavior.replay(ready.input('C1'));
      expect(c1).toMatchObject({
        kind: 'Replayed',
        proof: { kind: 'C1Instruction', hypothesisSaid: ready.hypothesis.d },
      });
      const c2 = await ready.behavior.replay(ready.input('C2'));
      expect(c2).toMatchObject({
        kind: 'Replayed',
        proof: { kind: 'C2Workflow', sourceEpisodeSaid: said('e') },
      });
      expect(ready.c2.choice.recalculate).toHaveBeenCalledTimes(2);
      const c3 = await ready.behavior.replay(ready.input('C3'));
      expect(c3).toMatchObject({
        kind: 'Replayed',
        proof: { kind: 'C3ContextSelection', includedSourceIds: [expect.any(String)] },
      });
      expect(ready.c3.history.read).toHaveBeenCalledOnce();
    },
  );

  it.each(['Hypothesis', 'Source', 'Action', 'Ablation'] as const)(
    'rejects %s substitution for a context-diagnosed C2 public replay',
    async (mismatch) => {
      const ready = fixture('ContextSelection');
      const input = ready.input('C2');
      if (mismatch === 'Source')
        ready.c2.reading.read.mockResolvedValueOnce({ kind: 'Unavailable' });
      if (mismatch === 'Action')
        ready.c2.choice.recalculate.mockResolvedValue({
          kind: 'Chosen',
          action: 'Unrelated action',
          sourceChoiceSaid: said('y'),
          citationSaids: [said('e')],
        });
      if (mismatch === 'Ablation')
        ready.c2.choice.recalculate.mockResolvedValue({
          kind: 'Chosen',
          action: ready.hypothesis.publicReplay.predictedAction,
          sourceChoiceSaid: said('y'),
          citationSaids: [said('e')],
        });
      expect(
        await ready.behavior.replay(
          mismatch === 'Hypothesis' ? { ...input, h0Said: said('z') } : input,
        ),
      ).toEqual({ kind: 'Blocked' });
      expect(ready.c3.history.read).not.toHaveBeenCalled();
    },
  );

  it('blocks a C2 treatment that skips public verification and C3 with no authorized public history', async () => {
    const ready = fixture();
    const c2 = ready.input('C2');
    const changed = Buffer.from(
      '{"version":1,"kind":"RecoveryWorkflow","trigger":"QualifiedRetainedFailure","steps":["RetrieveExperience","ReadExactSource","Replan","SkipVerifier"]}',
    );
    const changedArtifact = prepareEvidenceArtifact(changed, 'application/octet-stream');
    if (changedArtifact.kind !== 'Prepared') throw new Error('changed');
    expect(
      await ready.behavior.replay({
        ...c2,
        reviewedImplementationSaid: changedArtifact.artifact.d,
        implementation: { artifact: changedArtifact.artifact, bytes: changed },
      }),
    ).toEqual({ kind: 'Blocked' });
    ready.c3.history.read.mockResolvedValueOnce({ kind: 'Unavailable' });
    expect(await ready.behavior.replay(ready.input('C3'))).toEqual({ kind: 'Blocked' });
  });
});
