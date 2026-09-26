import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  type EvaluationVerifierBundle,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  observeProtectedTrialArtifact,
  observePublicTrialArtifact,
  gradePublicTrialArtifact,
  type ProtectedTrialArtifactDependencies,
} from './observe-protected-trial-artifact.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 30,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 30,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 10000,
};

function encrypted(
  purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
  segment: number,
  objectSaid: string,
  nonce: string,
) {
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId: id('1'),
    objectSaid,
    purpose,
    segment,
    nonce: nonce.repeat(16),
    tag: 'a'.repeat(22),
    ciphertext: 'aa',
    plaintextByteCount: 1,
  });
  if (prepared.kind !== 'Prepared') throw new Error('fixture artifact rejected');
  return prepared.artifact;
}

function fixture(
  publicExpected: EvaluationVerifierBundle['publicConditions'][number]['expected'] = {
    kind: 'Parsed',
    receipts: [{ version: 'Current', payload: said('x') }],
  },
) {
  const protectedCase = {
    objectSaid: said('q'),
    stimulus: encrypted('TrialHoldout', 0, said('q'), 'a'),
    expected: encrypted('OracleObservation', 0, said('q'), 'b'),
  };
  const terminalCase = {
    objectSaid: said('f'),
    stimulus: encrypted('TerminalCase', 1, said('f'), 'c'),
    expected: encrypted('OracleObservation', 1, said('f'), 'd'),
  };
  const preparedBundle = prepareEvaluationVerifierBundle({
    evaluationId: id('1'),
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: digest('1'),
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('g'),
    publicConditions: [
      {
        id: 'cesr-current',
        stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
        expected: publicExpected,
      },
    ],
    protectedCase,
    terminalCase,
  });
  if (preparedBundle.kind !== 'Prepared') throw new Error('fixture bundle rejected');
  const encoded = encodeEvaluationVerifierBundle(preparedBundle.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('fixture bundle encoding rejected');
  const preparedManifest = prepareEvaluationManifest({
    evaluationId: id('1'),
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    originRunId: id('3'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('l') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('H'),
    verifierSaid: preparedBundle.bundle.d,
    protectedCaseArtifactSaid: protectedCase.stimulus.d,
    finalCaseArtifactSaid: terminalCase.stimulus.d,
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (preparedManifest.kind !== 'Prepared') throw new Error('fixture manifest rejected');
  const manifest = preparedManifest.manifest;
  return {
    bytes: encoded.bytes,
    bundle: preparedBundle.bundle,
    manifest,
    input: {
      manifest,
      binding: {
        kind: 'Evaluation' as const,
        taskId: id('2'),
        taskRevisionSaid: said('t'),
        originRunId: id('3'),
        personalAgentAid: said('a'),
        taskMandateSaid: said('m'),
        harnessRevisionSaid: said('k'),
        evaluationId: id('1'),
        evaluationLeaseId: id('4'),
        evidenceStreamId: id('5'),
        phase: {
          kind: 'Trial' as const,
          manifestSaid: manifest.d,
          arm: 'C2' as const,
          repetition: 1 as const,
          attempt: 1 as const,
        },
      },
      lease: {
        evaluationId: id('1'),
        leaseId: id('4'),
        version: 1,
        serverTime: '2026-09-26T03:00:00.000Z',
        expiresAt: '2026-09-26T03:00:45.000Z',
      },
      leaseRequestStartedAt: 1000,
      now: 2000,
      cleanSourceSaid: said('r'),
      reviewedBehaviorSaid: said('b'),
      modelProfileSaid: said('d'),
      containerProfileSaid: said('e'),
      signal: new AbortController().signal,
    },
  };
}

function dependencies(given: ReturnType<typeof fixture>) {
  const protectedObservation = encrypted('OracleObservation', 0, said('q'), 'e');
  const protectedExpected = {
    kind: 'Parsed' as const,
    receipts: [{ version: 'Legacy' as const, payload: said('y') }],
  };
  const lock = vi.fn().mockResolvedValue({
    kind: 'Acknowledged' as const,
    evaluationId: given.manifest.evaluationId,
    manifestSaid: given.manifest.d,
    ownerAid: given.manifest.ownerAid,
    policySaid: given.manifest.policySaid,
    leaseId: given.input.lease.leaseId,
    leaseVersion: given.input.lease.version,
    acknowledgementSaid: said('z'),
  });
  const openCases = vi.fn().mockResolvedValue({ kind: 'Opened' as const, bytes: given.bytes });
  const inspectOracle = vi
    .fn()
    .mockResolvedValue({ kind: 'Reviewed' as const, digest: digest('1') });
  const run = vi.fn().mockResolvedValue({
    kind: 'Stopped' as const,
    capturedSourceSaid: said('u'),
    evidenceHeadSaid: said('v'),
    providerUsageEventSaids: [said('w')],
    cleanupReceiptSaid: said('x'),
  });
  const build = vi.fn().mockResolvedValue({
    kind: 'Frozen' as const,
    executableSaid: said('n'),
    sourceSaid: said('u'),
    buildReceiptSaid: said('b'),
    cleanupReceiptSaid: said('c'),
  });
  const observe = vi.fn().mockImplementation((input: { caseScope: 'Public' | 'Protected' }) =>
    Promise.resolve(
      input.caseScope === 'Public'
        ? {
            kind: 'Observed' as const,
            executableSaid: said('n'),
            observation: { kind: 'Rejected' as const, error: 'InvalidFrame' as const },
            rawObservationSaid: said('j'),
            cleanupReceiptSaid: said('k'),
          }
        : {
            kind: 'Observed' as const,
            executableSaid: said('n'),
            observation: protectedExpected,
            rawObservationSaid: protectedObservation.d,
            protectedObservation,
            cleanupReceiptSaid: said('l'),
          },
    ),
  );
  const openProtected = vi.fn().mockImplementation((input: { purpose: string }) =>
    Promise.resolve({
      kind: 'Opened' as const,
      plaintext: Buffer.from(
        input.purpose === 'TrialHoldout' ? `-AAL${said('y')}` : JSON.stringify(protectedExpected),
      ),
    }),
  );
  const captured = prepareEvaluationEvidenceEvent({
    evaluationId: given.input.binding.evaluationId,
    streamId: given.input.binding.evidenceStreamId,
    originRunId: given.input.binding.originRunId,
    taskId: given.input.binding.taskId,
    taskRevisionSaid: given.input.binding.taskRevisionSaid,
    personalAgentAid: given.input.binding.personalAgentAid,
    taskMandateSaid: given.input.binding.taskMandateSaid,
    harnessRevisionSaid: given.input.binding.harnessRevisionSaid,
    phase: given.input.binding.phase,
    sequence: 20,
    previous: { kind: 'Previous', eventSaid: said('v') },
    occurredAt: '2026-09-26T03:00:02.000Z',
    detail: {
      kind: 'ArtifactCaptured',
      artifactSaid: protectedObservation.d,
      custody: 'ProtectedCiphertext',
    },
  });
  if (captured.kind !== 'Prepared') throw new Error('fixture capture event rejected');
  const retain = vi.fn().mockResolvedValue({
    kind: 'Acknowledged' as const,
    artifactSaids: [
      given.bundle.protectedCase.stimulus.d,
      given.bundle.protectedCase.expected.d,
      protectedObservation.d,
    ],
    event: captured.event,
    throughSequence: captured.event.sequence,
    headSaid: captured.event.d,
  });
  const ports: ProtectedTrialArtifactDependencies = {
    lock: { inspect: lock },
    cases: { open: openCases },
    oracle: { inspect: inspectOracle },
    execution: { run },
    construction: { build },
    observation: { observe },
    custody: { seal: vi.fn().mockRejectedValue(new Error('not used')), open: openProtected },
    protectedArtifacts: { retain },
  };
  return {
    ports,
    lock,
    openCases,
    inspectOracle,
    run,
    build,
    observe,
    openProtected,
    retain,
    capturedEvent: captured.event,
  };
}

describe('protected trial artifact conversation', () => {
  it('freezes public observations before opening any protected case and grades only after the caller selects', async () => {
    const given = fixture();
    const wired = dependencies(given);
    const publicObservation = await observePublicTrialArtifact(given.input, wired.ports);
    expect(publicObservation.kind).toBe('PublicObserved');
    expect(wired.openProtected).not.toHaveBeenCalled();
    expect(wired.retain).not.toHaveBeenCalled();
    if (publicObservation.kind !== 'PublicObserved') throw new Error('public observation missing');
    expect(
      await gradePublicTrialArtifact(
        {
          ...given.input,
          publicObservation,
          expectedHeadSaid: publicObservation.trialEvidenceHeadSaid,
        },
        wired.ports,
      ),
    ).toMatchObject({ kind: 'Retained' });
    expect(wired.openProtected).toHaveBeenCalled();
    expect(wired.run).toHaveBeenCalledTimes(1);
    expect(wired.build).toHaveBeenCalledTimes(1);
  });

  it('refuses to construct a worker when the measured parent oracle differs from the M-bound bundle', async () => {
    const given = fixture();
    const wired = dependencies(given);
    wired.inspectOracle.mockResolvedValue({ kind: 'Reviewed', digest: digest('2') });
    const result = await observeProtectedTrialArtifact(given.input, wired.ports);
    expect(result).toMatchObject({ kind: 'Incomplete', frontier: 'OracleIdentity' });
    expect(wired.run).not.toHaveBeenCalled();
  });

  it('requires the current hosted M lock and canonical verifier bytes before spending a trial', async () => {
    const given = fixture();
    const wired = dependencies(given);
    wired.lock.mockResolvedValueOnce({ kind: 'Unlocked' });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ManifestLock',
    });
    expect(wired.openCases).not.toHaveBeenCalled();
    wired.openCases.mockResolvedValueOnce({
      kind: 'Opened',
      bytes: Buffer.concat([Buffer.from(' '), Buffer.from(given.bytes)]),
    });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'CaseInventory',
    });
    expect(wired.run).not.toHaveBeenCalled();
  });

  it('retains only the exact protected tuple after real-shaped public and protected observations', async () => {
    const given = fixture({ kind: 'Rejected', error: 'AnyRejection' });
    const wired = dependencies(given);
    const phase = given.input.binding.phase;
    const decodedInput = {
      ...given.input,
      binding: {
        ...given.input.binding,
        phase: {
          attempt: phase.attempt,
          repetition: phase.repetition,
          arm: phase.arm,
          manifestSaid: phase.manifestSaid,
          kind: phase.kind,
        },
      },
    };
    const result = await observeProtectedTrialArtifact(decodedInput, wired.ports);
    expect(result).toMatchObject({
      kind: 'Retained',
      frozenArtifact: { executableSaid: said('n'), sourceSaid: said('u') },
      publicCases: [{ id: 'cesr-current', verdict: 'Pass' }],
      protectedVerdict: 'Pass',
    });
    expect(wired.build).toHaveBeenCalledWith(
      expect.objectContaining({
        capturedSourceSaid: said('u'),
        reviewedRecipeSaid: given.bundle.reviewedRecipeSaid,
        toolchainSaid: given.bundle.toolchainSaid,
      }),
    );
    expect(wired.observe).toHaveBeenCalledTimes(2);
    expect(wired.retain).toHaveBeenCalledWith({
      binding: given.input.binding,
      manifest: given.manifest,
      lease: given.input.lease,
      expectedHeadSaid: said('v'),
      artifacts: [
        given.bundle.protectedCase.stimulus,
        given.bundle.protectedCase.expected,
        expect.objectContaining({ purpose: 'OracleObservation' }),
      ],
    });
    expect(wired.openProtected).toHaveBeenCalledTimes(2);
    expect(wired.openProtected).not.toHaveBeenCalledWith(expect.objectContaining({ segment: 1 }));
  });

  it('exposes frozen build proof but no durable result when protected ACK is incomplete', async () => {
    const given = fixture({ kind: 'Rejected', error: 'AnyRejection' });
    const wired = dependencies(given);
    wired.retain.mockResolvedValue({
      kind: 'Acknowledged',
      artifactSaids: [given.bundle.protectedCase.stimulus.d, given.bundle.protectedCase.expected.d],
    });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ProtectedCustody',
      frozenArtifact: { executableSaid: said('n'), buildReceiptSaid: said('b') },
    });
    wired.retain.mockResolvedValue({
      kind: 'Acknowledged',
      artifactSaids: [
        given.bundle.protectedCase.expected.d,
        given.bundle.protectedCase.stimulus.d,
        encrypted('OracleObservation', 0, said('q'), 'e').d,
      ],
    });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ProtectedCustody',
    });
    wired.retain.mockResolvedValue({
      kind: 'Acknowledged',
      artifactSaids: [
        given.bundle.protectedCase.stimulus.d,
        given.bundle.protectedCase.expected.d,
        encrypted('OracleObservation', 0, said('q'), 'e').d,
      ],
      event: wired.capturedEvent,
      throughSequence: wired.capturedEvent.sequence,
      headSaid: said('z'),
    });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ProtectedCustody',
    });
  });

  it('does not retain a protected verdict from a tuple claim without the exact appended event head', async () => {
    const given = fixture({ kind: 'Rejected', error: 'AnyRejection' });
    const wired = dependencies(given);
    wired.retain.mockResolvedValue({
      kind: 'Acknowledged',
      artifactSaids: [
        given.bundle.protectedCase.stimulus.d,
        given.bundle.protectedCase.expected.d,
        encrypted('OracleObservation', 0, said('q'), 'e').d,
      ],
      throughSequence: 20,
      headSaid: said('z'),
    });
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ProtectedCustody',
    });
  });

  it('reports a public mismatch as failure without converting a valid protected observation into success', async () => {
    const given = fixture();
    const wired = dependencies(given);
    const result = await observeProtectedTrialArtifact(given.input, wired.ports);
    expect(result).toMatchObject({
      kind: 'Retained',
      publicCases: [{ id: 'cesr-current', verdict: 'Fail' }],
      protectedVerdict: 'Pass',
    });
  });
});

it('grades under a fresh exact manifest lock after same lease heartbeat renewal', async () => {
  const given = fixture();
  const wired = dependencies(given);
  wired.lock.mockResolvedValue({
    kind: 'Acknowledged',
    evaluationId: given.manifest.evaluationId,
    manifestSaid: given.manifest.d,
    ownerAid: given.manifest.ownerAid,
    policySaid: given.manifest.policySaid,
    leaseId: given.input.lease.leaseId,
    leaseVersion: given.input.lease.version + 2,
    acknowledgementSaid: said('z'),
  });
  expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
    kind: 'Retained',
  });
});
it.each(['ownerAid', 'manifestSaid', 'policySaid', 'leaseId', 'olderVersion'] as const)(
  'does not spend a trial under changed lock %s',
  async (field) => {
    const given = fixture();
    const wired = dependencies(given);
    const lock = {
      kind: 'Acknowledged',
      evaluationId: given.manifest.evaluationId,
      manifestSaid: given.manifest.d,
      ownerAid: given.manifest.ownerAid,
      policySaid: given.manifest.policySaid,
      leaseId: given.input.lease.leaseId,
      leaseVersion: given.input.lease.version + 2,
      acknowledgementSaid: said('z'),
    };
    wired.lock.mockResolvedValue(
      field === 'olderVersion'
        ? { ...lock, leaseVersion: given.input.lease.version - 1 }
        : { ...lock, [field]: field === 'leaseId' ? id('9') : said('x') },
    );
    expect(await observeProtectedTrialArtifact(given.input, wired.ports)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ManifestLock',
    });
    expect(wired.run).not.toHaveBeenCalled();
  },
);
