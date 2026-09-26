import { randomUUID } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvaluationManifest,
  prepareEvaluationSourceInventory,
  prepareEvidenceArtifact,
  prepareEvolutionHypothesis,
  prepareQualifiedFailureWindow,
  prepareSuccessorHarnessRevision,
} from '@devrandom/protocol';
import { reviewEvolutionHypothesisInfluence } from '@devrandom/runtime';
import { expect, it, vi } from 'vitest';

import { QualifiedC2WorkflowTransition } from './qualified-c2-workflow-transition.js';

const said = (character: string): string => `E${character.repeat(43)}`;
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

async function fixture() {
  const taskId = randomUUID();
  const originRunId = randomUUID();
  const sourceEpisodeSaid = said('e');
  const sourceRawSaid = said('r');
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
    throw new Error('H1 fixture resource');
  const h1 = prepareBaselineHarnessRevision({
    task: {
      taskId,
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
      contextWindowTokens: 100000,
      maximumOutputTokens: 2000,
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
  if (h1.kind !== 'Prepared') throw new Error('H1 fixture');
  const inventory = prepareEvaluationSourceInventory({
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    repositoryResourceSaid: said('g'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('M'),
    sources: [
      {
        episodeSaid: sourceEpisodeSaid,
        rawEvidenceSaid: sourceRawSaid,
        ownerAid: said('o'),
        repositoryResourceSaid: said('g'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (inventory.kind !== 'Prepared') throw new Error('Inventory fixture');
  const window = prepareQualifiedFailureWindow({
    version: 1,
    kind: 'QualifiedFailureWindow',
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('s'),
    failureEventSaid: said('f'),
    verifierReceiptSaid: said('b'),
    precedingEventSaids: [said('P')],
  });
  if (window.kind !== 'Prepared') throw new Error('Window fixture');
  const hypothesis = prepareEvolutionHypothesis({
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('s'),
    parentRevisionSaid: h1.revision.d,
    personalAgentAid: said('a'),
    sourceInventorySaid: inventory.inventory.d,
    retrievalReceiptSaid: said('q'),
    failure: { eventSaid: said('f'), rawEvidenceSaid: said('b') },
    source: { episodeSaid: sourceEpisodeSaid, rawEvidenceSaid: sourceRawSaid },
    implicatedComponent: 'Workflow',
    predictedCorrection: 'Recheck original public conditions after stopped source capture.',
    publicReplay: {
      failureWindowSaid: window.artifact.d,
      configurationSaid: said('x'),
      nonTreatmentInputsSaid: said('n'),
      failureQuery: 'CESR legacy mismatch',
      predictedAction: 'replan-correctly',
      predictedSourceChoiceSaid: said('h'),
      assertion: 'The source changes the parent action.',
    },
    falsifier: 'The action stays unchanged without the source.',
    regressionRisks: ['More public verification costs time.'],
    rejectedExplanations: ['The prior model had no receipt issue.'],
  });
  if (hypothesis.kind !== 'Prepared') throw new Error('H0 fixture');
  let queryReceiptSaid = said('q');
  const retrieve = vi.fn().mockImplementation(() =>
    Promise.resolve({
      kind: 'Retrieved',
      sources: [{ episodeSaid: sourceEpisodeSaid, rawEvidenceSaid: sourceRawSaid, score: 0.9 }],
      queryReceiptSaid,
      chargedMicroUsd: 1,
    }),
  );
  const read = vi.fn().mockResolvedValue({
    kind: 'Read',
    bytes: Buffer.from('raw authorized episode'),
    totalBytes: 22,
    sourceSaid: sourceEpisodeSaid,
    readReceiptSaid: said('d'),
  });
  const project = vi.fn().mockResolvedValue({
    kind: 'Projected',
    episodeSaid: sourceEpisodeSaid,
    rawEvidenceSaid: sourceRawSaid,
    readReceiptSaid: said('d'),
    observation: 'legacy marker mismatch',
    recoveryHint: 'verify current marker',
  });
  const recalculate = vi.fn().mockImplementation(({ view }: { view: { sources: unknown[] } }) =>
    Promise.resolve(
      view.sources.length > 0
        ? {
            kind: 'Chosen',
            action: 'replan-correctly',
            sourceChoiceSaid: said('h'),
            citationSaids: [sourceEpisodeSaid],
          }
        : {
            kind: 'Chosen',
            action: 'submit-now',
            sourceChoiceSaid: said('u'),
            citationSaids: [],
          },
    ),
  );
  const ports = {
    retrieval: { retrieve },
    reading: { read },
    projection: { project },
    choice: { recalculate },
  };
  const influence = await reviewEvolutionHypothesisInfluence(
    {
      hypothesis: hypothesis.hypothesis,
      inventory: inventory.inventory,
      retained: {
        taskId,
        taskRevisionSaid: said('t'),
        originRunId,
        retainedCheckpointSaid: said('k'),
        retainedSealSaid: said('s'),
        parentRevisionSaid: h1.revision.d,
        personalAgentAid: said('a'),
        failureEventSaid: said('f'),
        failureRawEvidenceSaid: said('b'),
      },
    },
    ports,
  );
  if (influence.kind !== 'Influenced') throw new Error('Initial influence fixture');
  queryReceiptSaid = said('z');
  const configurationBytes = Buffer.from('{"version":1,"arm":"C2"}');
  const implementationBytes = Buffer.from(
    '{"version":1,"kind":"RecoveryWorkflow","trigger":"QualifiedRetainedFailure","steps":["RetrieveExperience","ReadExactSource","Replan","FreshPublicVerify"]}',
  );
  const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
  const implementation = prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
  const replay = prepareEvidenceArtifact(Buffer.from('{"verified":true}'), 'application/json');
  if (
    configuration.kind !== 'Prepared' ||
    implementation.kind !== 'Prepared' ||
    replay.kind !== 'Prepared'
  )
    throw new Error('Treatment fixture');
  const successor = prepareSuccessorHarnessRevision({
    parentRevisionSaid: h1.revision.d,
    arm: 'C2',
    h0Said: hypothesis.hypothesis.d,
    taskRevisionSaid: said('t'),
    sourceInventorySaid: inventory.inventory.d,
    executionProfileSaid: said('E'),
    configurationArtifactSaid: configuration.artifact.d,
    treatment: {
      kind: 'ReviewedWorkflow',
      reviewedImplementationSaid: implementation.artifact.d,
      publicReplayReceiptSaid: replay.artifact.d,
    },
  });
  if (successor.kind !== 'Prepared') throw new Error('C2 successor fixture');
  const manifest = prepareEvaluationManifest({
    evaluationId: randomUUID(),
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: h1.revision.d, C1: said('C'), C2: successor.revision.d, C3: said('D') },
    executionProfileSaid: said('E'),
    sourceInventorySaid: inventory.inventory.d,
    hypothesisSaid: hypothesis.hypothesis.d,
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('w'),
    finalCaseArtifactSaid: said('X'),
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (manifest.kind !== 'Prepared') throw new Error(`Manifest fixture: ${manifest.reason}`);
  const candidateCommit = '3'.repeat(40);
  const candidateTree = '4'.repeat(40);
  const custody = {
    read: vi.fn().mockResolvedValue({ kind: 'Read', configurationBytes, implementationBytes }),
  };
  const adapter = new QualifiedC2WorkflowTransition({
    constructed: { kind: 'Constructed', hypothesis: hypothesis.hypothesis, window, influence },
    inventory: inventory.inventory,
    reviewed: {
      h1: h1.revision,
      successorRevisionSaid: successor.revision.d,
      binding: {
        parentRevisionSaid: h1.revision.d,
        arm: 'C2',
        h0Said: hypothesis.hypothesis.d,
        taskRevisionSaid: said('t'),
        sourceInventorySaid: inventory.inventory.d,
        executionProfileSaid: said('E'),
      },
      treatment: successor.revision.treatment,
      configuration: configuration.artifact,
      implementation: implementation.artifact,
      replay: replay.artifact,
    },
    successorBytes: Buffer.from(JSON.stringify(successor.revision)),
    repositoryDirectory: '/candidate',
    candidateCommit,
    candidateTree,
    custody,
    ...ports,
  });
  const slot = { arm: 'C2' as const, repetition: 1 as const, attempt: 1 as const };
  const binding = {
    kind: 'Evaluation' as const,
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: successor.revision.d,
    evaluationId: manifest.manifest.evaluationId,
    evaluationLeaseId: randomUUID(),
    evidenceStreamId: randomUUID(),
    phase: { kind: 'Trial' as const, manifestSaid: manifest.manifest.d, ...slot },
  };
  return {
    adapter,
    input: {
      binding,
      manifest: manifest.manifest,
      slot,
      successorRevisionSaid: successor.revision.d,
      candidateCommit,
      candidateTree,
      signal: new AbortController().signal,
    },
    custody,
    retrieve,
    read,
    recalculate,
    implementationBytes,
  };
}

it('executes exact C2 treatment custody and fresh Q/H0-bound retrieval, read and replan before worker context', async () => {
  const given = await fixture();
  const outcome = await given.adapter.prepare(given.input);
  expect(outcome).toMatchObject({
    kind: 'Prepared',
    queryReceiptSaid: said('z'),
    readReceiptSaid: said('d'),
  });
  expect(given.custody.read).toHaveBeenCalledOnce();
  expect(given.retrieve).toHaveBeenCalledTimes(2);
  expect(given.read).toHaveBeenCalledTimes(2);
  expect(given.recalculate).toHaveBeenCalledTimes(4);
  if (outcome.kind === 'Prepared')
    expect(outcome.contextText).toContain('Parent replanned action: replan-correctly.');
});

it('blocks an unreviewed workflow blob before retrieval', async () => {
  const given = await fixture();
  given.custody.read.mockResolvedValueOnce({
    kind: 'Read',
    configurationBytes: Buffer.from('{"version":1,"arm":"C2"}'),
    implementationBytes: Buffer.from(
      '{"version":1,"kind":"RecoveryWorkflow","trigger":"QualifiedRetainedFailure","steps":["PromptOnly"]}',
    ),
  });
  expect(await given.adapter.prepare(given.input)).toEqual({ kind: 'Blocked' });
  expect(given.retrieve).toHaveBeenCalledTimes(1);
});

it('blocks a fresh retrieval whose source can no longer be exactly read', async () => {
  const given = await fixture();
  given.read.mockResolvedValueOnce({ kind: 'Denied' });
  expect(await given.adapter.prepare(given.input)).toEqual({ kind: 'Blocked' });
  expect(given.retrieve).toHaveBeenCalledTimes(2);
  expect(given.recalculate).toHaveBeenCalledTimes(2);
});
