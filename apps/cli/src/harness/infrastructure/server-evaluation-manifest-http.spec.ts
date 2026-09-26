import { describe, expect, it } from 'vitest';

import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvaluationHttp } from './server-evaluation-http.js';

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

function fixture() {
  const evaluationId = id('1');
  const cases = [
    ['TrialHoldout', 0, 'a'],
    ['OracleObservation', 0, 'b'],
    ['TerminalCase', 1, 'c'],
    ['OracleObservation', 1, 'd'],
  ] as const;
  const artifacts = cases.map(([purpose, segment, letter]) => {
    const prepared = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid: segment === 0 ? said('o') : said('p'),
      purpose,
      segment,
      nonce: letter.repeat(16),
      tag: letter.repeat(22),
      ciphertext: letter.repeat(24),
      plaintextByteCount: 18,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    return prepared.artifact;
  });
  const [trialStimulus, trialExpected, terminalStimulus, terminalExpected] = artifacts;
  if (!trialStimulus || !trialExpected || !terminalStimulus || !terminalExpected)
    throw new Error('Case fixture incomplete');
  const bundle = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    ownerAid: said('u'),
    personalAgentAid: said('a'),
    policySaid: said('q'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'f'.repeat(64)}`,
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('l'),
    publicConditions: [
      {
        id: 'legacy',
        stimulusBase64Url: Buffer.from('-A##AA').toString('base64url'),
        expected: { kind: 'Rejected', error: 'InvalidFrame' },
      },
    ],
    protectedCase: { objectSaid: said('o'), stimulus: trialStimulus, expected: trialExpected },
    terminalCase: { objectSaid: said('p'), stimulus: terminalStimulus, expected: terminalExpected },
  });
  if (bundle.kind !== 'Prepared') throw new Error(bundle.reason);
  const manifest = prepareEvaluationManifest({
    evaluationId,
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    originRunId: id('3'),
    ownerAid: said('u'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('q'),
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('v'),
    verifierSaid: bundle.bundle.d,
    protectedCaseArtifactSaid: trialStimulus.d,
    finalCaseArtifactSaid: terminalStimulus.d,
    publicConditionIds: ['legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (manifest.kind !== 'Prepared') throw new Error(manifest.reason);
  const encoded = encodeEvaluationVerifierBundle(bundle.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('Verifier encoding rejected');
  const command = {
    version: 1 as const,
    commandId: id('4'),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    expectedEvaluationVersion: 2,
    leaseId: id('5'),
    manifest: manifest.manifest,
    verifierBundle: bundle.bundle,
    verifierBundleBytesBase64Url: Buffer.from(encoded.bytes).toString('base64url'),
    protectedArtifacts: artifacts,
  };
  const receipt = {
    kind: 'Locked',
    evaluationId,
    manifestSaid: manifest.manifest.d,
    ownerAid: said('u'),
    policySaid: said('q'),
    leaseId: id('5'),
    lockedAtLeaseVersion: 2,
    lockedAtEvaluationVersion: 3,
    currentLeaseVersion: 2,
    currentEvaluationVersion: 3,
  };
  return { command, receipt };
}

function origin() {
  const decoded = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
  if (decoded.kind !== 'Accepted') throw new Error('Origin fixture rejected');
  return decoded.origin;
}

describe('hosted Evaluation manifest lock client', () => {
  it('accepts only the exact locked M acknowledgement and authenticated fresh read', async () => {
    const { command, receipt } = fixture();
    const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
      if (init?.method === 'PUT') {
        expect(url).toBe(`http://127.0.0.1:3211/api/evaluations/${receipt.evaluationId}/manifest`);
        expect(init.body).toBe(JSON.stringify(command));
        return Promise.resolve(
          new Response(JSON.stringify(receipt), {
            status: 201,
            headers: { 'cache-control': 'no-store' },
          }),
        );
      }
      expect(url).toBe(
        `http://127.0.0.1:3211/api/evaluations/${receipt.evaluationId}/manifest/${receipt.manifestSaid}`,
      );
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`);
      return Promise.resolve(
        new Response(JSON.stringify({ ...receipt, currentLeaseVersion: 3 }), {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        }),
      );
    });
    expect(await http.lockManifest(command)).toEqual({ kind: 'Locked', receipt });
    expect(
      await http.inspectManifestLock(receipt.evaluationId, receipt.manifestSaid, receipt.leaseId),
    ).toMatchObject({ kind: 'Locked', receipt: { currentLeaseVersion: 3 } });
  });

  it('rejects exact-byte substitution and forged or stale receipts before a trial', async () => {
    const { command, receipt } = fixture();
    const asked = { count: 0 };
    const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () => {
      asked.count += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ ...receipt, manifestSaid: said('z') }), {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        }),
      );
    });
    expect(await http.lockManifest({ ...command, verifierBundleBytesBase64Url: 'AAAA' })).toEqual({
      kind: 'Rejected',
    });
    expect(asked.count).toBe(0);
    expect(await http.lockManifest(command)).toEqual({ kind: 'ResponseInvalid' });
    const stale = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
      Promise.resolve(
        new Response(JSON.stringify({ ...receipt, currentEvaluationVersion: 2 }), {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        }),
      ),
    );
    expect(await stale.lockManifest(command)).toEqual({ kind: 'ResponseInvalid' });
  });
});
