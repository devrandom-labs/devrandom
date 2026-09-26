import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { EvaluationManifestCommandFile } from './evaluation-manifest-command-file.js';

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

function draft() {
  const evaluationId = id('1');
  const artifacts = [
    ['TrialHoldout', 0, 'a'],
    ['OracleObservation', 0, 'b'],
    ['TerminalCase', 1, 'c'],
    ['OracleObservation', 1, 'd'],
  ].map(([purpose, segment, letter]) => {
    const prepared = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid: segment === 0 ? said('o') : said('p'),
      purpose,
      segment,
      nonce: String(letter).repeat(16),
      tag: String(letter).repeat(22),
      ciphertext: String(letter).repeat(24),
      plaintextByteCount: 18,
    });
    if (prepared.kind !== 'Prepared') throw new Error('Case fixture rejected');
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
  if (bundle.kind !== 'Prepared') throw new Error('Verifier fixture rejected');
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
    hypothesisSaid: said('H'),
    verifierSaid: bundle.bundle.d,
    protectedCaseArtifactSaid: trialStimulus.d,
    finalCaseArtifactSaid: terminalStimulus.d,
    publicConditionIds: ['legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (manifest.kind !== 'Prepared') throw new Error('Manifest fixture rejected');
  const encoded = encodeEvaluationVerifierBundle(bundle.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('Verifier encoding rejected');
  return {
    version: 1 as const,
    expectedEvaluationVersion: 2,
    leaseId: id('5'),
    manifest: manifest.manifest,
    verifierBundle: bundle.bundle,
    verifierBundleBytesBase64Url: Buffer.from(encoded.bytes).toString('base64url'),
    protectedArtifacts: artifacts,
  };
}

it('durably replays one exact protected M command after process loss and rejects replacement cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-manifest-command-'));
  try {
    const directory = join(root, 'custody');
    const initial = new EvaluationManifestCommandFile(directory, () => id('6'));
    const prepared = draft();
    const first = await initial.stage(prepared);
    expect(first.kind).toBe('Staged');
    if (first.kind !== 'Staged') return;
    expect(first.command.commandId).toBe(id('6'));
    expect(first.command.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const path = join(directory, `${prepared.manifest.evaluationId}.manifest.json`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(first.command);

    const restarted = new EvaluationManifestCommandFile(directory, () => id('7'));
    expect(await restarted.stage(prepared)).toEqual(first);
    expect(
      await restarted.stage({
        ...prepared,
        protectedArtifacts: [...prepared.protectedArtifacts].reverse(),
      }),
    ).toEqual({ kind: 'Conflict' });
    await writeFile(path, 'corrupted', { mode: 0o600 });
    expect(await restarted.stage(prepared)).toEqual({ kind: 'Unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('concurrent exact staging keeps one immutable command identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-manifest-race-'));
  try {
    const directory = join(root, 'custody');
    const prepared = draft();
    const first = new EvaluationManifestCommandFile(directory, () => id('6'));
    const second = new EvaluationManifestCommandFile(directory, () => id('7'));
    const outcomes = await Promise.all([first.stage(prepared), second.stage(prepared)]);
    expect(outcomes[0].kind).toBe('Staged');
    expect(outcomes[1]).toEqual(outcomes[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
