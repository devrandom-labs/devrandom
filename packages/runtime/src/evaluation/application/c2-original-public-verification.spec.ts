import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { C2OriginalPublicVerification } from './c2-original-public-verification.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const budget = {
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

function protectedArtifact(
  purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
  key: string,
  nonce: string,
  segment: number,
) {
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId: id('1'),
    objectSaid: said(key),
    purpose,
    segment,
    nonce: nonce.repeat(16),
    tag: 'a'.repeat(22),
    ciphertext: 'aa',
    plaintextByteCount: 1,
  });
  if (prepared.kind !== 'Prepared') throw new Error('Protected fixture failed.');
  return prepared.artifact;
}

function fixture() {
  const protectedCase = {
    objectSaid: said('q'),
    stimulus: protectedArtifact('TrialHoldout', 'q', 'a', 0),
    expected: protectedArtifact('OracleObservation', 'q', 'b', 0),
  };
  const finalCase = {
    objectSaid: said('f'),
    stimulus: protectedArtifact('TerminalCase', 'f', 'c', 1),
    expected: protectedArtifact('OracleObservation', 'f', 'd', 1),
  };
  const bundle = prepareEvaluationVerifierBundle({
    evaluationId: id('1'),
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'1'.repeat(64)}`,
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('g'),
    publicConditions: [
      {
        id: 'cesr-current',
        stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
        expected: { kind: 'Parsed', receipts: [{ version: 'Current', payload: said('x') }] },
      },
    ],
    protectedCase,
    terminalCase: finalCase,
  });
  if (bundle.kind !== 'Prepared') throw new Error(`Verifier fixture failed: ${bundle.reason}.`);
  const encoded = encodeEvaluationVerifierBundle(bundle.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('Verifier encoding failed.');
  const manifest = prepareEvaluationManifest({
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
    verifierSaid: bundle.bundle.d,
    protectedCaseArtifactSaid: protectedCase.stimulus.d,
    finalCaseArtifactSaid: finalCase.stimulus.d,
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
  });
  if (manifest.kind !== 'Prepared') throw new Error('Manifest fixture failed.');
  const slot = { arm: 'C2' as const, repetition: 1 as const, attempt: 1 as const };
  const input = {
    binding: {
      kind: 'Evaluation' as const,
      taskId: manifest.manifest.taskId,
      taskRevisionSaid: manifest.manifest.taskRevisionSaid,
      originRunId: manifest.manifest.originRunId,
      personalAgentAid: manifest.manifest.personalAgentAid,
      taskMandateSaid: manifest.manifest.taskMandateSaid,
      harnessRevisionSaid: manifest.manifest.revisions.C2,
      evaluationId: manifest.manifest.evaluationId,
      evaluationLeaseId: id('4'),
      evidenceStreamId: id('5'),
      phase: { kind: 'Trial' as const, manifestSaid: manifest.manifest.d, ...slot },
    },
    manifest: manifest.manifest,
    slot,
    successorRevisionSaid: manifest.manifest.revisions.C2,
    proposedArtifactSaids: [said('z')],
    proposalEventSaid: said('P'),
    capturedSourceSaid: said('S'),
    signal: new AbortController().signal,
  };
  const build = vi.fn().mockResolvedValue({
    kind: 'Frozen',
    executableSaid: said('b'),
    sourceSaid: input.capturedSourceSaid,
    buildReceiptSaid: said('B'),
    cleanupReceiptSaid: said('C'),
  });
  const observe = vi.fn().mockResolvedValue({
    kind: 'Observed',
    executableSaid: said('b'),
    observation: { kind: 'Parsed', receipts: [{ version: 'Current', payload: said('x') }] },
    rawObservationSaid: said('R'),
    cleanupReceiptSaid: said('D'),
  });
  const inspectOracle = vi
    .fn()
    .mockResolvedValue({ kind: 'Reviewed', digest: bundle.bundle.oracleAdapterDigest });
  const verifier = new C2OriginalPublicVerification({
    cases: { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: encoded.bytes }) },
    oracle: { inspect: inspectOracle },
    construction: { build },
    observation: { observe },
  });
  return { input, verifier, build, observe, inspectOracle };
}

describe('fresh original public verification of a stopped C2 proposal', () => {
  it('binds a passing observation to the frozen source and proposal', async () => {
    const given = fixture();
    const result = await given.verifier.verify(given.input);
    expect(result).toMatchObject({
      kind: 'Verified',
      capturedSourceSaid: given.input.capturedSourceSaid,
      proposalEventSaid: given.input.proposalEventSaid,
    });
    expect(given.build).toHaveBeenCalledWith(
      expect.objectContaining({ capturedSourceSaid: given.input.capturedSourceSaid }),
    );
    expect(given.observe).toHaveBeenCalledWith(expect.objectContaining({ caseScope: 'Public' }));
  });

  it('keeps a complete public mismatch or build failure as a bound negative observation', async () => {
    const mismatch = fixture();
    mismatch.observe.mockResolvedValueOnce({
      kind: 'Observed',
      executableSaid: said('b'),
      observation: { kind: 'Rejected', error: 'InvalidFrame' },
      rawObservationSaid: said('R'),
      cleanupReceiptSaid: said('D'),
    });
    expect(await mismatch.verifier.verify(mismatch.input)).toMatchObject({
      kind: 'Failed',
      capturedSourceSaid: mismatch.input.capturedSourceSaid,
    });
    const buildFailure = fixture();
    buildFailure.build.mockResolvedValueOnce({
      kind: 'BuildFailed',
      buildReceiptSaid: said('B'),
      cleanupReceiptSaid: said('C'),
    });
    expect(await buildFailure.verifier.verify(buildFailure.input)).toMatchObject({
      kind: 'Failed',
      capturedSourceSaid: buildFailure.input.capturedSourceSaid,
    });
    expect(buildFailure.observe).not.toHaveBeenCalled();
  });

  it('blocks forged scope, missing oracle and unavailable public observation', async () => {
    const scope = fixture();
    expect(
      await scope.verifier.verify({ ...scope.input, successorRevisionSaid: said('w') }),
    ).toEqual({ kind: 'Unavailable' });
    expect(scope.build).not.toHaveBeenCalled();
    const oracle = fixture();
    oracle.inspectOracle.mockResolvedValueOnce({ kind: 'Unavailable' });
    expect(await oracle.verifier.verify(oracle.input)).toEqual({ kind: 'Unavailable' });
    expect(oracle.build).not.toHaveBeenCalled();
    const observation = fixture();
    observation.observe.mockResolvedValueOnce({ kind: 'Invalid', reason: 'CleanupUnconfirmed' });
    expect(await observation.verifier.verify(observation.input)).toEqual({ kind: 'Unavailable' });
  });
});
