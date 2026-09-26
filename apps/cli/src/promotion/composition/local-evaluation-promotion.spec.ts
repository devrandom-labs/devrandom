import { mkdtemp, rm, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issuerAid } from '@devrandom/identity';
import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  type TaskProjection,
} from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';

import { fixture as closureFixture } from '../../../test/promotion-evidence-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { EvaluationManifestCommandFile } from '../../harness/infrastructure/evaluation-manifest-command-file.js';
import { PromotionEvidenceFile } from '../infrastructure/promotion-evidence-file.js';
import {
  promoteLocalEvaluation,
  type LocalEvaluationPromotionInput,
} from './local-evaluation-promotion.js';

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

function draft(task: TaskProjection) {
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
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    ownerAid: task.ownerAid,
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
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    originRunId: id('3'),
    ownerAid: task.ownerAid,
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

// Independent mechanism fixtures: no campaign, model execution, or claimed H2.
it('checks exact M/closure consent and local immutable custody before opening signing authority', async () => {
  const stateRoot = await mkdtemp(
    join(await realpath(tmpdir()), 'devrandom-promotion-composition-'),
  );
  try {
    const task = taskProjectionFixture();
    const prepared = draft(task);
    const directory = join(stateRoot, 'evaluation-manifests');
    const staged = await new EvaluationManifestCommandFile(directory, () => id('6')).stage(
      prepared,
    );
    if (staged.kind !== 'Staged') throw new Error('manifest custody unavailable');
    const closure = closureFixture(prepared.manifest.d).command;
    expect(
      await new PromotionEvidenceFile(join(stateRoot, 'promotion-evidence')).stageClosure(closure),
    ).toBe('Staged');
    const establish = vi.fn(() => Promise.resolve({ kind: 'CustodyUnavailable' as const }));
    const activation = vi.fn();
    const activationPointer = vi.fn();
    // External conversations are deliberately unavailable; the actual disk adapters above run.
    const input: LocalEvaluationPromotionInput = {
      stateRoot,
      issuerAid: issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh'),
      hosted: {
        user: { principal: { aid: task.ownerAid } },
        activation,
        activationPointer,
      } as unknown as LocalEvaluationPromotionInput['hosted'],
      local: { establish } as unknown as LocalEvaluationPromotionInput['local'],
      task,
      evaluationId: prepared.manifest.evaluationId,
      closureSaid: closure.closure.d,
      commandId: id('7'),
      signal: new AbortController().signal,
    };
    expect(await promoteLocalEvaluation(input)).toEqual({
      kind: 'Blocked',
      gate: 'UserConfirmation',
    });
    for (const confirmation of [
      { manifestSaid: said('z'), closureSaid: input.closureSaid },
      { manifestSaid: prepared.manifest.d, closureSaid: said('z') },
    ]) {
      expect(await promoteLocalEvaluation({ ...input, confirmation })).toEqual({
        kind: 'Blocked',
        gate: 'UserConfirmation',
      });
    }
    expect(establish).not.toHaveBeenCalled();
    const confirmed = {
      ...input,
      confirmation: { manifestSaid: prepared.manifest.d, closureSaid: input.closureSaid },
    };
    expect(
      await promoteLocalEvaluation({
        ...confirmed,
        hosted: {
          ...input.hosted,
          user: {
            ...input.hosted.user,
            principal: { ...input.hosted.user.principal, aid: said('z') },
          },
        },
      }),
    ).toEqual({ kind: 'Blocked', gate: 'Authority' });
    expect(establish).not.toHaveBeenCalled();
    expect(await promoteLocalEvaluation(confirmed)).toEqual({ kind: 'Blocked', gate: 'Authority' });
    expect(establish).toHaveBeenCalledOnce();
    establish.mockClear();

    const path = join(directory, `${prepared.manifest.evaluationId}.manifest.json`);
    const original = await readFile(path);
    const tampered = {
      ...staged.command,
      verifierBundle: {
        ...staged.command.verifierBundle,
        oracleAdapterDigest: `sha256:${'a'.repeat(64)}`,
      },
    };
    await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
    expect(await promoteLocalEvaluation(confirmed)).toEqual({ kind: 'Blocked', gate: 'Custody' });
    expect(establish).not.toHaveBeenCalled();
    await writeFile(path, original, { mode: 0o600 });
    const closurePath = join(stateRoot, 'promotion-evidence', `${input.closureSaid}.closure.json`);
    const closureBytes = await readFile(closurePath);
    await unlink(closurePath);
    expect(await promoteLocalEvaluation(confirmed)).toEqual({ kind: 'Blocked', gate: 'Custody' });
    expect(establish).not.toHaveBeenCalled();
    await writeFile(closurePath, closureBytes, { mode: 0o600 });
    expect(await promoteLocalEvaluation(confirmed)).toEqual({ kind: 'Blocked', gate: 'Authority' });
    expect(establish).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalled();
    expect(activationPointer).not.toHaveBeenCalled();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
