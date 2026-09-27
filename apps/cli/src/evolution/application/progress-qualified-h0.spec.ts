import {
  prepareEvidenceArtifact,
  prepareEvaluationExecutionProfile,
  prepareEvaluationPolicy,
  prepareEvaluationSourceInventory,
  prepareEvolutionHypothesis,
  prepareQualifiedFailureWindow,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

const preparedInventory = vi.hoisted(() => vi.fn());
const proposedDiagnosis = vi.hoisted(() => vi.fn());
vi.mock('../../harness/application/prepare-qualified-source-inventory.js', () => ({
  prepareQualifiedSourceInventory: preparedInventory,
}));
vi.mock('./propose-qualified-diagnosis.js', () => ({
  proposeQualifiedDiagnosis: proposedDiagnosis,
}));

import { progressQualifiedH0 } from './progress-qualified-h0.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const id = (letter: string): string =>
  `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`;
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

function admittedFixture() {
  return {
    kind: 'Admitted' as const,
    evaluationId: id('5'),
    version: 1,
    lease: {
      evaluationId: id('5'),
      leaseId: id('6'),
      version: 1,
      serverTime: '2026-09-26T09:00:00.000Z',
      expiresAt: '2026-09-26T09:01:00.000Z',
    },
    evidenceStreamId: id('7'),
    reservationSaid: said('q'),
  };
}

function fixture() {
  const taskId = id('1');
  const originRunId = id('2');
  const taskRevisionSaid = said('t');
  const activeRevisionSaid = said('h');
  const ownerAid = said('o');
  const mandateSaid = said('m');
  const rawEvidenceSaid = said('r');
  const episodeSaid = said('e');
  const sourceInventory = prepareEvaluationSourceInventory({
    taskId,
    taskRevisionSaid,
    ownerAid,
    repositoryResourceSaid: said('s'),
    corpusSaid: said('c'),
    experienceMandateSaid: mandateSaid,
    sources: [
      {
        episodeSaid,
        rawEvidenceSaid,
        ownerAid,
        repositoryResourceSaid: said('s'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: '1'.repeat(40),
    sourceGitTree: '2'.repeat(40),
    h1InstructionSaid: said('i'),
    h1RuntimePromptDigest: `sha256:${'d'.repeat(64)}`,
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
  if (sourceInventory.kind !== 'Prepared' || profile.kind !== 'Prepared')
    throw new Error('fixture rejected');
  const policy = prepareEvaluationPolicy({
    taskId,
    taskRevisionSaid,
    originRunId,
    expectedActiveRevisionSaid: activeRevisionSaid,
    executionProfileSaid: profile.profile.d,
    sourceInventorySaid: sourceInventory.inventory.d,
    comparisonLaw: 'ThreeRepetitionsTwoAttemptsPublicSearch',
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (policy.kind !== 'Prepared') throw new Error('policy fixture rejected');
  const qualified = {
    kind: 'Qualified' as const,
    taskId,
    taskRevisionSaid,
    originRunId,
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('z'),
    expectedActiveRevisionSaid: activeRevisionSaid,
    personalAgentAid: said('a'),
    taskMandateSaid: mandateSaid,
    executionProfileSaid: profile.profile.d,
  };
  const review = {
    version: 1 as const,
    kind: 'ReviewedPublicAnalogy' as const,
    runId: id('3'),
    episodeSaid,
    rawEvidenceSaid,
    observation: 'public verifier compatibility failure',
    recoveryAction: 'verify-current-framing',
    predictedCorrection: 'Check the current CESR receipt framing.',
    implicatedComponent: 'Workflow' as const,
    regressionRisks: ['Another public format may still fail.'],
  };
  const reviewArtifact = prepareEvidenceArtifact(
    new TextEncoder().encode(JSON.stringify(review)),
    'application/json',
  );
  if (reviewArtifact.kind !== 'Prepared') throw new Error('review fixture');
  const reviewArtifactSaid = reviewArtifact.artifact.d;
  preparedInventory.mockResolvedValue({
    kind: 'Prepared',
    qualified,
    inventory: sourceInventory.inventory,
    sources: [
      {
        runId: id('3'),
        observationEventSaid: episodeSaid,
        rawEvidenceSaid,
        failureEventSaid: said('f'),
        verifierReceiptSaid: said('v'),
      },
    ],
  });
  const sequence: string[] = [];
  const captured: {
    record?: { artifact: EvidenceArtifact; bytes: Uint8Array; evaluationId: string };
  } = {};
  const ports = {
    qualification: { inspect: vi.fn() },
    history: { read: vi.fn() },
    mandate: { inspect: vi.fn() },
    policy: {
      review: vi.fn().mockResolvedValue({
        kind: 'Reviewed',
        policy: policy.policy,
        profile: profile.profile,
      }),
    },
    reviews: {
      read: vi.fn().mockResolvedValue({
        kind: 'Read',
        artifact: reviewArtifact.artifact,
        review,
      }),
    },
    commands: {
      acquire: vi.fn().mockImplementation(() => {
        sequence.push('command');
        return Promise.resolve({
          kind: 'Recorded',
          commandId: id('4'),
          fingerprint: `sha256:${'a'.repeat(64)}`,
        });
      }),
      recordAdmission: vi.fn().mockResolvedValue({ kind: 'Recorded' }),
    },
    hosted: {
      prepare: vi.fn().mockImplementation(() => {
        sequence.push('prepare');
        return Promise.resolve({ kind: 'Prepared' });
      }),
      admit: vi.fn().mockImplementation(() => {
        sequence.push('admit');
        return Promise.resolve(admittedFixture());
      }),
    },
    context: { open: vi.fn().mockReturnValue({ retrieval: {}, reading: {} }) },
    records: {
      inspectEvaluation: vi.fn().mockResolvedValue({ kind: 'NotFound' }),
      commit: vi
        .fn()
        .mockImplementation(
          (input: { artifact: EvidenceArtifact; bytes: Uint8Array; evaluationId: string }) => {
            captured.record = input;
            return Promise.resolve({ kind: 'Committed', artifactSaid: input.artifact.d });
          },
        ),
    },
  };
  const qualification = {
    task: {
      taskId,
      revisionSaid: taskRevisionSaid,
      ownerAid,
      revision: { version: 2, repository: { commit: '1'.repeat(40), tree: '2'.repeat(40) } },
    },
    originRunId,
    expectedActiveRevisionSaid: activeRevisionSaid,
    executionProfileSaid: profile.profile.d,
    signal: new AbortController().signal,
  };
  const input = {
    qualification: qualification as never,
    reviewArtifactSaids: [reviewArtifactSaid],
    configurationSaid: said('g'),
    nonTreatmentInputsSaid: said('n'),
  };
  return {
    input,
    ports,
    sequence,
    captured,
    qualified,
    inventory: sourceInventory.inventory,
    policy: policy.policy,
    reviewArtifactSaid,
    episodeSaid,
    rawEvidenceSaid,
  };
}

describe('qualified H0 hosted progression', () => {
  it('does not prepare hosted Evaluation if Q is blocked', async () => {
    const test = fixture();
    preparedInventory.mockResolvedValueOnce({ kind: 'Blocked', gate: 'Qualification' });
    expect(await progressQualifiedH0(test.input, test.ports as never)).toEqual({
      kind: 'Blocked',
      gate: 'Qualification',
    });
    expect(test.ports.hosted.prepare).not.toHaveBeenCalled();
  });

  it('requires parent-reviewed exact source custody before reservation', async () => {
    const test = fixture();
    test.ports.reviews.read.mockResolvedValueOnce({ kind: 'NotFound' });
    expect(await progressQualifiedH0(test.input, test.ports as never)).toEqual({
      kind: 'Blocked',
      gate: 'ReviewCustody',
    });
    expect(test.ports.hosted.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { version: 1, leaseVersion: 1 },
    { version: 19, leaseVersion: 3 },
  ])(
    'progresses and reopens H0 with Evaluation $version and lease $leaseVersion',
    async ({ version, leaseVersion }) => {
      const test = fixture();
      const admitted = admittedFixture();
      test.sequence.length = 0;
      test.ports.hosted.admit.mockImplementation(() => {
        test.sequence.push('admit');
        return Promise.resolve({
          ...admitted,
          version,
          lease: { ...admitted.lease, version: leaseVersion },
        });
      });
      const window = prepareQualifiedFailureWindow({
        version: 1,
        kind: 'QualifiedFailureWindow',
        taskId: test.qualified.taskId,
        taskRevisionSaid: test.qualified.taskRevisionSaid,
        originRunId: test.qualified.originRunId,
        retainedCheckpointSaid: test.qualified.retainedCheckpointSaid,
        retainedSealSaid: test.qualified.retainedSealSaid,
        failureEventSaid: said('F'),
        verifierReceiptSaid: said('V'),
        precedingEventSaids: [said('P')],
      });
      if (window.kind !== 'Prepared') throw new Error('window fixture');
      const hypothesis = prepareEvolutionHypothesis({
        taskId: test.qualified.taskId,
        taskRevisionSaid: test.qualified.taskRevisionSaid,
        originRunId: test.qualified.originRunId,
        retainedCheckpointSaid: test.qualified.retainedCheckpointSaid,
        retainedSealSaid: test.qualified.retainedSealSaid,
        parentRevisionSaid: test.qualified.expectedActiveRevisionSaid,
        personalAgentAid: test.qualified.personalAgentAid,
        sourceInventorySaid: test.inventory.d,
        retrievalReceiptSaid: said('Q'),
        failure: { eventSaid: said('F'), rawEvidenceSaid: said('V') },
        source: { episodeSaid: test.episodeSaid, rawEvidenceSaid: test.rawEvidenceSaid },
        implicatedComponent: 'Workflow',
        predictedCorrection: 'Check current framing under public verifier.',
        publicReplay: {
          failureWindowSaid: window.artifact.d,
          configurationSaid: test.input.configurationSaid,
          nonTreatmentInputsSaid: test.input.nonTreatmentInputsSaid,
          failureQuery: 'public legacy receipt failure',
          predictedAction: 'verify-current-framing',
          predictedSourceChoiceSaid: test.episodeSaid,
          assertion: 'Removing exact source changes the action.',
        },
        falsifier: 'The same action remains after source removal.',
        regressionRisks: ['Other format failures may remain.'],
        rejectedExplanations: ['Transient failure does not explain five calibrations.'],
      });
      if (hypothesis.kind !== 'Prepared') throw new Error('hypothesis fixture');
      proposedDiagnosis.mockImplementationOnce(() => {
        test.sequence.push('diagnosis');
        return Promise.resolve({
          kind: 'Proposed',
          selectedReviewArtifactSaid: test.reviewArtifactSaid,
          construction: {
            hypothesis: hypothesis.hypothesis,
            window,
            influence: {
              review: { queryReceiptSaid: said('Q'), source: { readReceiptSaid: said('R') } },
            },
          },
        });
      });
      const result = await progressQualifiedH0(test.input, test.ports);
      expect(result.kind).toBe('Progressed');
      expect(test.sequence).toEqual(['command', 'prepare', 'admit', 'diagnosis']);
      const preparation: unknown = test.ports.hosted.prepare.mock.calls[0]?.[0];
      expect(preparation).toMatchObject({
        sourceInventory: test.inventory,
        executionProfile: { d: test.policy.executionProfileSaid },
      });
      expect(test.ports.commands.recordAdmission).toHaveBeenCalledWith(
        {
          taskId: test.qualified.taskId,
          originRunId: test.qualified.originRunId,
          policySaid: test.policy.d,
        },
        id('4'),
        id('5'),
      );
      const committed = test.captured.record;
      if (committed === undefined) throw new Error('missing H0 record');
      test.ports.records.inspectEvaluation.mockResolvedValueOnce({
        kind: 'Read',
        artifact: committed.artifact,
        bytes: committed.bytes,
      });
      test.ports.commands.acquire.mockResolvedValueOnce({
        kind: 'Recorded',
        commandId: id('4'),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        admittedEvaluationId: id('5'),
      });
      proposedDiagnosis.mockClear();
      const replay = await progressQualifiedH0(test.input, test.ports);
      expect(replay).toEqual(result);
      expect(proposedDiagnosis).not.toHaveBeenCalled();
    },
  );

  it.each(['FutureLease', 'ForeignEvaluation', 'MalformedVersion'] as const)(
    'rejects %s admission before source diagnosis or H0 custody',
    async (invalid) => {
      const test = fixture();
      const admitted = admittedFixture();
      test.ports.hosted.admit.mockResolvedValueOnce({
        ...admitted,
        version: invalid === 'MalformedVersion' ? 1.5 : 2,
        lease: {
          ...admitted.lease,
          version: invalid === 'FutureLease' ? 3 : 1,
          evaluationId: invalid === 'ForeignEvaluation' ? id('9') : admitted.evaluationId,
        },
      });
      expect(await progressQualifiedH0(test.input, test.ports)).toEqual({
        kind: 'Blocked',
        gate: 'Admission',
      });
      expect(proposedDiagnosis).not.toHaveBeenCalled();
      expect(test.ports.commands.recordAdmission).not.toHaveBeenCalled();
      expect(test.ports.records.commit).not.toHaveBeenCalled();
    },
  );

  it('does not query Atlas when hosted admission blocks residual budget', async () => {
    const test = fixture();
    test.ports.hosted.admit.mockResolvedValueOnce({ kind: 'Blocked', gate: 'Budget' });
    expect(await progressQualifiedH0(test.input, test.ports as never)).toEqual({
      kind: 'Blocked',
      gate: 'Budget',
    });
    expect(proposedDiagnosis).not.toHaveBeenCalled();
  });

  it('keeps the admitted Evaluation durable when Atlas or raw influence throws', async () => {
    const test = fixture();
    proposedDiagnosis.mockRejectedValueOnce(new Error('source unavailable'));
    expect(await progressQualifiedH0(test.input, test.ports as never)).toEqual({
      kind: 'Blocked',
      gate: 'Hypothesis',
      evaluationId: id('5'),
    });
    expect(test.ports.commands.recordAdmission).toHaveBeenCalledOnce();
    expect(test.ports.records.commit).not.toHaveBeenCalled();
  });
});
