import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationPolicy,
  prepareEvaluationSourceInventory,
  prepareEvolutionHypothesis,
  prepareSuccessorHarnessRevision,
} from '@devrandom/protocol';
import { AesGcmProtectedCaseCustody, cesrPublicConditions } from '@devrandom/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvaluationManifestCommandFile } from '../infrastructure/evaluation-manifest-command-file.js';
import {
  lockCesrComparisonManifest,
  reconcileStagedCesrManifest,
  type CesrManifestBasis,
  type CesrManifestConversations,
} from './lock-cesr-comparison-manifest.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const id = (letter: string): string =>
  `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2_000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 200,
  runWallTimeSeconds: 20,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 10,
  changedFiles: 2,
  changedWorktreeBytes: 2_000,
  evidencePlusArtifactsPerRunBytes: 20_000,
};

function basis(): CesrManifestBasis {
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: 'a'.repeat(40),
    sourceGitTree: 'b'.repeat(40),
    h1InstructionSaid: said('h'),
    h1RuntimePromptDigest: `sha256:${'d'.repeat(64)}`,
    effectiveLimitsReceiptSaid: said('L'),
    parentDeathCleanupReceiptSaid: said('P'),
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
  const qualified = {
    kind: 'Qualified' as const,
    taskId: id('1'),
    taskRevisionSaid: said('t'),
    originRunId: id('2'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    expectedActiveRevisionSaid: said('h'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    executionProfileSaid: profile.kind === 'Prepared' ? profile.profile.d : said('e'),
  };
  const inventory = prepareEvaluationSourceInventory({
    taskId: qualified.taskId,
    taskRevisionSaid: qualified.taskRevisionSaid,
    ownerAid: said('o'),
    repositoryResourceSaid: said('R'),
    corpusSaid: said('C'),
    experienceMandateSaid: said('M'),
    sources: [
      {
        episodeSaid: said('E'),
        rawEvidenceSaid: said('F'),
        ownerAid: said('o'),
        repositoryResourceSaid: said('R'),
        corpusSaid: said('C'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (profile.kind !== 'Prepared' || inventory.kind !== 'Prepared')
    throw new Error('profile/source fixture rejected');
  const policy = prepareEvaluationPolicy({
    taskId: qualified.taskId,
    taskRevisionSaid: qualified.taskRevisionSaid,
    originRunId: qualified.originRunId,
    expectedActiveRevisionSaid: qualified.expectedActiveRevisionSaid,
    executionProfileSaid: qualified.executionProfileSaid,
    sourceInventorySaid: inventory.inventory.d,
    comparisonLaw: 'ThreeRepetitionsTwoAttemptsPublicSearch',
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (policy.kind !== 'Prepared') throw new Error('policy fixture rejected');
  const hypothesis = prepareEvolutionHypothesis({
    taskId: qualified.taskId,
    taskRevisionSaid: qualified.taskRevisionSaid,
    originRunId: qualified.originRunId,
    retainedCheckpointSaid: qualified.retainedCheckpointSaid,
    retainedSealSaid: qualified.retainedSealSaid,
    parentRevisionSaid: qualified.expectedActiveRevisionSaid,
    personalAgentAid: qualified.personalAgentAid,
    sourceInventorySaid: policy.policy.sourceInventorySaid,
    retrievalReceiptSaid: said('k'),
    failure: { eventSaid: said('f'), rawEvidenceSaid: said('g') },
    source: { episodeSaid: said('i'), rawEvidenceSaid: said('j') },
    implicatedComponent: 'Workflow',
    predictedCorrection: 'Require fresh public verification.',
    publicReplay: {
      failureWindowSaid: said('w'),
      configurationSaid: said('z'),
      nonTreatmentInputsSaid: said('n'),
      failureQuery: 'compatibility failure',
      predictedAction: 'verify again',
      predictedSourceChoiceSaid: said('p'),
      assertion: 'public verifier runs on current source',
    },
    falsifier: 'the verifier already ran on final bytes',
    regressionRisks: ['extra tool time'],
    rejectedExplanations: ['bad fixture'],
  });
  if (hypothesis.kind !== 'Prepared') throw new Error('H0 fixture rejected');
  const candidates = [
    { arm: 'C1', treatment: { kind: 'Instruction' } },
    {
      arm: 'C2',
      treatment: {
        kind: 'ReviewedWorkflow',
        reviewedImplementationSaid: said('x'),
        publicReplayReceiptSaid: said('y'),
      },
    },
    {
      arm: 'C3',
      treatment: {
        kind: 'ContextSelection',
        reviewedImplementationSaid: said('X'),
        publicReplayReceiptSaid: said('Y'),
      },
    },
  ].map((candidate) =>
    prepareSuccessorHarnessRevision({
      parentRevisionSaid: qualified.expectedActiveRevisionSaid,
      h0Said: hypothesis.hypothesis.d,
      taskRevisionSaid: qualified.taskRevisionSaid,
      sourceInventorySaid: policy.policy.sourceInventorySaid,
      executionProfileSaid: policy.policy.executionProfileSaid,
      configurationArtifactSaid: said('A'),
      ...candidate,
    }),
  );
  if (candidates.some((candidate) => candidate.kind !== 'Prepared'))
    throw new Error('candidate fixture rejected');
  return {
    ownerAid: said('o'),
    qualified,
    policy: policy.policy,
    profile: profile.profile,
    inventory: inventory.inventory,
    hypothesis: hypothesis.hypothesis,
    candidates: candidates.map((candidate) => {
      if (candidate.kind !== 'Prepared') throw new Error('candidate fixture rejected');
      return candidate.revision;
    }),
    admission: {
      kind: 'Admitted',
      evaluationId: id('3'),
      version: 1,
      lease: {
        evaluationId: id('3'),
        leaseId: id('4'),
        version: 1,
        serverTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 40_000).toISOString(),
      },
      evidenceStreamId: id('5'),
      reservationSaid: said('r'),
    },
    sourceDirectory: '/tmp/reviewed-cesr-source',
    sourceGitCommit: 'a'.repeat(40),
    sourceGitTree: 'b'.repeat(40),
    oracleAdapterDigest: `sha256:${'c'.repeat(64)}`,
    reviewedRecipeSaid: said('d'),
    toolchainSaid: said('l'),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ports() {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-m-lock-'));
  roots.push(root);
  const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
  const lock = vi.fn(
    (command: Parameters<CesrManifestConversations['hosted']['lockManifest']>[0]) =>
      Promise.resolve({
        kind: 'Locked' as const,
        receipt: {
          kind: 'Locked' as const,
          evaluationId: command.manifest.evaluationId,
          manifestSaid: command.manifest.d,
          ownerAid: command.manifest.ownerAid,
          policySaid: command.manifest.policySaid,
          leaseId: command.leaseId,
          lockedAtLeaseVersion: 1,
          lockedAtEvaluationVersion: 2,
          currentLeaseVersion: 1,
          currentEvaluationVersion: 2,
        },
      }),
  );
  let locked: Awaited<ReturnType<typeof lock>> | undefined;
  const conversation = {
    lock,
    readiness: { verify: () => Promise.resolve({ kind: 'Reviewed' }) },
    catalogue: {
      review: () =>
        Promise.resolve({
          kind: 'Reviewed',
          publicConditions: cesrPublicConditions('FlatGroups'),
        }),
    },
    cases: {
      open: () => Promise.resolve({ kind: 'Opened', custody, release: () => undefined }),
      drawPayload: () => randomBytes(32),
    },
    commands: new EvaluationManifestCommandFile(join(root, 'commands'), randomUUID),
    hosted: {
      lockManifest: async (command) => {
        locked = await lock(command);
        return locked;
      },
      inspectManifestLock: () => Promise.resolve(locked ?? { kind: 'Unavailable' }),
    },
  } satisfies CesrManifestConversations & { readonly lock: typeof lock };
  return conversation;
}

describe('E3 CESR M lock sequencing', () => {
  it('refuses unreviewed candidates before key creation or hosted mutation', async () => {
    const given = basis();
    const boundary = await ports();
    const open = vi.fn(() => boundary.cases.open());
    expect(
      await lockCesrComparisonManifest(given, {
        ...boundary,
        readiness: { verify: () => Promise.resolve({ kind: 'Blocked' }) },
        cases: { ...boundary.cases, open },
      }),
    ).toEqual({ kind: 'Blocked', gate: 'Candidates' });
    expect(open).not.toHaveBeenCalled();
    expect(boundary.lock).not.toHaveBeenCalled();
  });

  it('seals, stages, locks and reads back one exact M; retry uses retained ciphertext', async () => {
    const given = basis();
    const boundary = await ports();
    const first = await lockCesrComparisonManifest(given, boundary);
    expect(first).toMatchObject({ kind: 'Locked', evaluationId: given.admission.evaluationId });
    expect(boundary.lock).toHaveBeenCalledOnce();
    const command = boundary.lock.mock.calls[0]?.[0];
    expect(command?.protectedArtifacts).toHaveLength(4);
    expect(command?.manifest.hypothesisSaid).toBe(given.hypothesis.d);
    const second = await lockCesrComparisonManifest(given, boundary);
    expect(second).toEqual(first);
    expect(boundary.lock).toHaveBeenCalledTimes(2);
    expect(boundary.lock.mock.calls[1]?.[0]).toEqual(command);
    expect(
      await reconcileStagedCesrManifest(given.admission.evaluationId, given.ownerAid, boundary),
    ).toEqual(first);
    expect(boundary.lock).toHaveBeenCalledTimes(3);
    expect(
      await reconcileStagedCesrManifest(given.admission.evaluationId, said('z'), boundary),
    ).toEqual({ kind: 'Blocked', gate: 'Manifest' });
  });

  it('reopens a key retained before an interrupted first M stage without reusing a nonce', async () => {
    const given = basis();
    const boundary = await ports();
    const open = vi.fn((input: Parameters<CesrManifestConversations['cases']['open']>[0]) =>
      input.mode === 'Create'
        ? Promise.resolve({ kind: 'Conflict' as const })
        : boundary.cases.open(),
    );
    expect(
      await lockCesrComparisonManifest(given, {
        ...boundary,
        cases: { ...boundary.cases, open },
      }),
    ).toMatchObject({ kind: 'Locked', evaluationId: given.admission.evaluationId });
    expect(open.mock.calls.map(([input]) => input.mode)).toEqual(['Create', 'Reopen']);
  });
});

it.each([1, 19])(
  'locks with reconciled admission version %s after research evidence',
  async (admissionVersion) => {
    const given = basis();
    const boundary = await ports();
    const renewed = {
      ...given.admission.lease,
      version: 2,
      serverTime: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45000).toISOString(),
    };
    const input = {
      ...given,
      admission: {
        ...given.admission,
        version: admissionVersion,
        lease: { ...given.admission.lease, expiresAt: new Date(Date.now() - 1000).toISOString() },
      },
      currentPosition: { evaluationId: given.admission.evaluationId, version: 80, lease: renewed },
    };
    expect(await lockCesrComparisonManifest(input, boundary)).toMatchObject({ kind: 'Locked' });
    expect(boundary.lock.mock.calls[0]?.[0].expectedEvaluationVersion).toBe(80);
    expect(
      await lockCesrComparisonManifest(
        {
          ...input,
          currentPosition: { ...input.currentPosition, lease: { ...renewed, leaseId: id('9') } },
        },
        boundary,
      ),
    ).toMatchObject({ kind: 'Blocked' });
  },
);

it.each([0, 1.5, 81])(
  'rejects invalid or future admission version %s before case sealing',
  async (version) => {
    const given = basis();
    const boundary = await ports();
    expect(
      await lockCesrComparisonManifest(
        {
          ...given,
          admission: { ...given.admission, version },
          currentPosition: {
            evaluationId: given.admission.evaluationId,
            version: 80,
            lease: given.admission.lease,
          },
        },
        boundary,
      ),
    ).toMatchObject({ kind: 'Blocked' });
    expect(boundary.lock).not.toHaveBeenCalled();
  },
);
