import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvidenceArtifact,
  prepareEvolutionHypothesis,
  prepareSuccessorHarnessRevision,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { branchReviewedSuccessors } from './branch-reviewed-successors.js';
import type {
  CandidateBranchCommand,
  CandidateBranchDisposition,
} from './candidate-branch-custody.js';
import type { SuccessorPublicReplay, SuccessorTreatmentReview } from '@devrandom/runtime';

const said = (letter: string) => `E${letter.repeat(43)}`;
const utf8 = new TextEncoder();

function fixture() {
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
    throw new Error('fixture resources');
  const h1Prepared = prepareBaselineHarnessRevision({
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
  if (h1Prepared.kind !== 'Prepared') throw new Error('fixture H1');
  const h1 = h1Prepared.revision;
  const h0Prepared = prepareEvolutionHypothesis({
    taskId: h1.task.taskId,
    taskRevisionSaid: h1.task.revisionSaid,
    originRunId: '019db52c-c9df-44e9-8f8f-9d8cf42d88d5',
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('d'),
    parentRevisionSaid: h1.d,
    personalAgentAid: h1.authority.personalAgentAid,
    sourceInventorySaid: said('s'),
    retrievalReceiptSaid: said('r'),
    failure: { eventSaid: said('f'), rawEvidenceSaid: said('e') },
    source: { episodeSaid: said('n'), rawEvidenceSaid: said('v') },
    implicatedComponent: 'Instruction',
    predictedCorrection: 'Use reviewed treatment',
    publicReplay: {
      failureWindowSaid: said('w'),
      configurationSaid: said('q'),
      nonTreatmentInputsSaid: said('i'),
      failureQuery: 'public query',
      predictedAction: 'public action',
      predictedSourceChoiceSaid: said('x'),
      assertion: 'falsifiable public assertion',
    },
    falsifier: 'public replay fails',
    regressionRisks: ['one risk'],
    rejectedExplanations: ['another explanation'],
  });
  if (h0Prepared.kind !== 'Prepared') throw new Error('fixture H0');
  const h0 = h0Prepared.hypothesis;
  const artifact = (
    bytes: Uint8Array,
    mediaType: 'application/json' | 'application/octet-stream',
  ) => {
    const prepared = prepareEvidenceArtifact(bytes, mediaType);
    if (prepared.kind !== 'Prepared') throw new Error('fixture artifact');
    return { artifact: prepared.artifact, bytes };
  };
  const candidates = (['C1', 'C2', 'C3'] as const).map((arm) => {
    const configuration = artifact(
      utf8.encode(JSON.stringify({ version: 1, arm, reviewed: true })),
      'application/json',
    );
    const implementation =
      arm === 'C1'
        ? undefined
        : artifact(utf8.encode(`reviewed ${arm}`), 'application/octet-stream');
    const replay =
      arm === 'C1'
        ? undefined
        : artifact(utf8.encode(JSON.stringify({ arm, confirmed: true })), 'application/json');
    let treatment: object;
    if (arm === 'C1') treatment = { kind: 'Instruction' };
    else {
      if (implementation === undefined || replay === undefined)
        throw new Error('fixture implementation');
      treatment = {
        kind: arm === 'C2' ? 'ReviewedWorkflow' : 'ContextSelection',
        reviewedImplementationSaid: implementation.artifact.d,
        publicReplayReceiptSaid: replay.artifact.d,
      };
    }
    const prepared = prepareSuccessorHarnessRevision({
      parentRevisionSaid: h1.d,
      arm,
      h0Said: h0.d,
      taskRevisionSaid: h1.task.revisionSaid,
      sourceInventorySaid: h0.sourceInventorySaid,
      executionProfileSaid: said('p'),
      configurationArtifactSaid: configuration.artifact.d,
      treatment,
    });
    if (prepared.kind !== 'Prepared') throw new Error('fixture successor');
    return {
      arm,
      successorBytes: utf8.encode(JSON.stringify(prepared.revision)),
      configuration,
      ...(implementation === undefined ? {} : { implementation }),
      ...(replay === undefined ? {} : { replay }),
    };
  });
  const input = {
    h1Bytes: utf8.encode(JSON.stringify(h1)),
    h0Bytes: utf8.encode(JSON.stringify(h0)),
    executionProfileSaid: said('p'),
    repositoryDirectory: '/tmp/not-a-repository',
    stateRoot: '/tmp/not-a-state',
    candidates,
    signal: new AbortController().signal,
  };
  const branchSiblings = vi.fn(
    (command: CandidateBranchCommand): Promise<CandidateBranchDisposition> =>
      Promise.resolve({
        kind: 'Branched',
        readiness: 'AwaitingRuntimeBinding',
        branches: command.candidates.map((candidate, index) => ({
          arm: candidate.arm,
          branch: `fixture-${candidate.arm}`,
          directory: `/tmp/fixture-${candidate.arm}`,
          parentCommit: command.h1Repository.commit,
          commit: String(index + 3).repeat(40),
          tree: String(index + 6).repeat(40),
        })),
      }),
  );
  const treatmentReview = {
    review: vi.fn((request: Parameters<SuccessorTreatmentReview['review']>[0]) =>
      Promise.resolve({ kind: 'Reviewed' as const, ...request }),
    ),
  };
  const publicReplay = {
    verify: vi.fn(
      (
        request: Parameters<SuccessorPublicReplay['verify']>[0],
      ): ReturnType<SuccessorPublicReplay['verify']> =>
        Promise.resolve({ kind: 'Confirmed' as const, ...request }),
    ),
  };
  return { input, ports: { treatmentReview, publicReplay, branches: { branchSiblings } }, h1, h0 };
}

describe('reviewed successor sibling admission', () => {
  it('does not create a Git branch from missing H1/H0 bytes', async () => {
    const ready = fixture();
    expect(
      await branchReviewedSuccessors({ ...ready.input, h0Bytes: new Uint8Array() }, ready.ports),
    ).toEqual({ kind: 'Blocked', reason: 'H0' });
    expect(ready.ports.branches.branchSiblings).not.toHaveBeenCalled();
  });

  it('reviews three materializations before writing siblings and labels runtime binding pending', async () => {
    const ready = fixture();
    const admitted = await branchReviewedSuccessors(ready.input, ready.ports);
    expect(admitted).toMatchObject({ kind: 'Branched', readiness: 'AwaitingRuntimeBinding' });
    expect(ready.ports.treatmentReview.review).toHaveBeenCalledTimes(3);
    expect(ready.ports.publicReplay.verify).toHaveBeenCalledTimes(2);
    expect(ready.ports.branches.branchSiblings).toHaveBeenCalledTimes(1);
    const command = ready.ports.branches.branchSiblings.mock.calls[0]?.[0];
    if (command === undefined) throw new Error('fixture branch custody was not invoked');
    expect(command).toMatchObject({
      h0Said: ready.h0.d,
      h1Repository: {
        objectFormat: ready.h1.repository.objectFormat,
        commit: ready.h1.repository.commit,
        tree: ready.h1.repository.tree,
      },
    });
    expect(command.candidates.map((candidate: { arm: string }) => candidate.arm)).toEqual([
      'C1',
      'C2',
      'C3',
    ]);
  });

  it('blocks every branch if the last replay is rejected or H0 is swapped', async () => {
    const ready = fixture();
    ready.ports.publicReplay.verify.mockImplementation((request) =>
      Promise.resolve(
        request.arm === 'C3'
          ? { kind: 'Rejected' as const }
          : { kind: 'Confirmed' as const, ...request },
      ),
    );
    expect(await branchReviewedSuccessors(ready.input, ready.ports)).toEqual({
      kind: 'Blocked',
      reason: 'Materialization',
    });
    expect(ready.ports.branches.branchSiblings).not.toHaveBeenCalled();
    const changed = Uint8Array.from(ready.input.h0Bytes);
    changed[changed.length - 2] = 'x'.charCodeAt(0);
    expect(
      await branchReviewedSuccessors({ ...ready.input, h0Bytes: changed }, ready.ports),
    ).toEqual({ kind: 'Blocked', reason: 'H0' });
  });
});
