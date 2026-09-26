import {
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  prepareEvidenceArtifact,
  encodeEvaluationVerifierBundle,
  type EvaluationVerifierBundle,
} from '@devrandom/protocol';
import { taskBudgetCeilings, type Run } from '@devrandom/domain';
import { RunResourceBudget, type EvidenceRecording } from '@devrandom/runtime';
import { describe, expect, it } from 'vitest';
import { TerminalSourceVerification } from './terminal-source-verification.js';
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
  return { manifest: preparedManifest.manifest, bundle: preparedBundle.bundle };
}

function verifier(sourceMismatch = false, exhausted = false) {
  const given = fixture();
  const output: unknown[] = [];
  const calls: string[] = [];
  const run = {
    binding: {
      runId: id('3'),
      taskId: id('2'),
      taskRevisionSaid: said('t'),
      ownerAid: said('o'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      initialHarnessRevisionSaid: said('h'),
      purpose: { kind: 'Retained' },
      budget: taskBudgetCeilings,
    },
    lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
    currentExecution: { harnessRevisionSaid: said('k'), segmentSaid: said('S') },
    consumedBudget: Object.fromEntries(
      Object.keys(taskBudgetCeilings).map((key) => [
        key,
        key === 'aggregateChildCommandTimeSeconds' && exhausted
          ? taskBudgetCeilings.aggregateChildCommandTimeSeconds
          : 0,
      ]),
    ),
  } as unknown as Run;
  const budget = new RunResourceBudget({
    run,
    evidence: { recordBudgetDebit: () => ({ kind: 'Recorded' }) as EvidenceRecording },
    now: () => '2026-09-26T15:00:00.000Z',
  });
  let clock = 0;
  const dependencies = {
    run,
    expectedManifestSaid: given.manifest.d,
    profileSaid: said('e'),
    wallTimeSeconds: 30,
    budget,
    monotonicNow: () => clock++,
    artifacts: {
      record: ({
        bytes,
        mediaType,
      }: {
        bytes: Uint8Array;
        mediaType:
          | 'application/json'
          | 'application/octet-stream'
          | 'text/plain; charset=utf-8'
          | 'text/x-diff; charset=utf-8';
      }) => {
        output.push(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
        const prepared = prepareEvidenceArtifact(bytes, mediaType);
        return Promise.resolve(
          prepared.kind === 'Prepared'
            ? { kind: 'Stored' as const, artifact: prepared.artifact }
            : { kind: 'Unavailable' as const },
        );
      },
    },
    custody: {
      acquire: () =>
        Promise.resolve({
          kind: 'Acquired' as const,
          ...given,
          close: () => {
            calls.push('close');
          },
          construction: {
            build: ({ capturedSourceSaid }: { capturedSourceSaid: string }) => {
              calls.push('build');
              return Promise.resolve({
                kind: 'Frozen' as const,
                sourceSaid: sourceMismatch ? said('wrong') : capturedSourceSaid,
                executableSaid: said('E'),
                buildReceiptSaid: said('B'),
                cleanupReceiptSaid: said('C'),
              });
            },
          },
          observation: {
            observe: (input: { caseScope: 'Public' | 'Protected'; executableSaid: string }) => {
              calls.push(input.caseScope);
              return Promise.resolve({
                kind: 'Observed' as const,
                executableSaid: input.executableSaid,
                observation: {
                  kind: 'Parsed' as const,
                  receipts: [{ version: 'Current' as const, payload: said('x') }],
                },
                rawObservationSaid:
                  input.caseScope === 'Protected'
                    ? encrypted('OracleObservation', 1, said('f'), 'f').d
                    : said('R'),
                cleanupReceiptSaid: said('C'),
                ...(input.caseScope === 'Protected'
                  ? { protectedObservation: encrypted('OracleObservation', 1, said('f'), 'f') }
                  : {}),
              });
            },
          },
          cases: {
            open: (input: { artifact: { purpose: string } }) =>
              Promise.resolve({
                kind: 'Opened' as const,
                plaintext: Buffer.from(
                  input.artifact.purpose === 'TerminalCase'
                    ? '-AAL' + said('x')
                    : JSON.stringify({
                        kind: 'Parsed',
                        receipts: [{ version: 'Current', payload: said('x') }],
                      }),
                ),
              }),
            seal: () => Promise.resolve({ kind: 'Unavailable' as const }),
          },
        }),
    },
  };
  return {
    verification: new TerminalSourceVerification(dependencies),
    dependencies,
    calls,
    output,
  };
}
describe('original reserved TerminalCase assessment', () => {
  it('builds exactly the submitted source and records encrypted protected observation separately from public verdict', async () => {
    const f = verifier();
    expect(await f.verification.assess(said('a'), new AbortController().signal)).toMatchObject({
      kind: 'Assessed',
      verdict: 'Pass',
    });
    expect(f.calls).toEqual(['build', 'Public', 'Protected', 'close']);
    const receipt = f.output.at(-1);
    expect(receipt).toMatchObject({
      submittedSourceSaid: said('a'),
      verificationSourceSaid: said('a'),
      terminalCaseArtifactSaid: fixture().manifest.finalCaseArtifactSaid,
    });
    expect(JSON.stringify(receipt)).not.toContain(said('x'));
  });
  it('rejects changed build source and exhausted residual Run budget before the protected case', async () => {
    const changed = verifier(true);
    expect(await changed.verification.assess(said('a'), new AbortController().signal)).toEqual({
      kind: 'Unavailable',
    });
    expect(changed.calls).toEqual(['build', 'close']);
    const exhausted = verifier(false, true);
    expect(await exhausted.verification.assess(said('a'), new AbortController().signal)).toEqual({
      kind: 'Unavailable',
    });
    expect(exhausted.calls).toEqual(['close']);
  });
});
