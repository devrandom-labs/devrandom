import { Buffer } from 'node:buffer';

import { expect, it } from 'vitest';

import { prepareEvaluationManifest } from './manifest.js';
import { prepareProtectedEvaluationArtifact } from './protected-artifact.js';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationVerifierBundle,
  decodeEvaluationVerifierBundleBytes,
  encodeEvaluationVerifierBundle,
  prepareEvaluationVerifierBundle,
} from './verifier-bundle.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const payload = said('x');

function protectedArtifact(
  purpose: 'TrialHoldout' | 'OracleObservation' | 'TerminalCase',
  objectSaid: string,
  segment: number,
  nonceByte: number,
) {
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId,
    objectSaid,
    purpose,
    segment,
    nonce: Buffer.alloc(12, nonceByte).toString('base64url'),
    tag: Buffer.alloc(16, nonceByte).toString('base64url'),
    ciphertext: Buffer.from([nonceByte]).toString('base64url'),
    plaintextByteCount: 1,
  });
  if (prepared.kind !== 'Prepared') throw new Error('protected artifact fixture invalid');
  return prepared.artifact;
}

function bundleInput() {
  const caseObjectSaid = said('q');
  const terminalObjectSaid = said('r');
  const stimulus = Buffer.from(`-AAL${payload}`, 'utf8').toString('base64url');
  return {
    evaluationId,
    taskId,
    taskRevisionSaid: said('a'),
    ownerAid: said('b'),
    personalAgentAid: said('c'),
    policySaid: said('g'),
    executionProfileSaid: said('l'),
    oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
    reviewedRecipeSaid: said('s'),
    toolchainSaid: said('t'),
    publicConditions: ['cesr-current', 'cesr-tamper', 'cesr-legacy'].map((id) => ({
      id,
      stimulusBase64Url: stimulus,
      expected: { kind: 'Parsed' as const, receipts: [{ version: 'Current' as const, payload }] },
    })),
    protectedCase: {
      objectSaid: caseObjectSaid,
      stimulus: protectedArtifact('TrialHoldout', caseObjectSaid, 0, 1),
      expected: protectedArtifact('OracleObservation', caseObjectSaid, 0, 2),
    },
    terminalCase: {
      objectSaid: terminalObjectSaid,
      stimulus: protectedArtifact('TerminalCase', terminalObjectSaid, 1, 3),
      expected: protectedArtifact('OracleObservation', terminalObjectSaid, 1, 4),
    },
  };
}

function manifest(verifierSaid: string, protectedSaid: string, finalSaid: string) {
  const allowance = {
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerSpendMicroUsd: 0,
    runWallTimeSeconds: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
    evidencePlusArtifactsPerRunBytes: 0,
  };
  const prepared = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: said('a'),
    originRunId,
    ownerAid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    retainedCheckpointSaid: said('e'),
    retainedSealSaid: said('f'),
    policySaid: said('g'),
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('l'),
    sourceInventorySaid: said('m'),
    hypothesisSaid: said('H'),
    verifierSaid,
    protectedCaseArtifactSaid: protectedSaid,
    finalCaseArtifactSaid: finalSaid,
    publicConditionIds: ['cesr-current', 'cesr-tamper', 'cesr-legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (prepared.kind !== 'Prepared') throw new Error('manifest fixture invalid');
  return prepared.manifest;
}

it('binds exact parent-only verifier, public condition set, and both encrypted case pairs to M', () => {
  const prepared = prepareEvaluationVerifierBundle(bundleInput());
  if (prepared.kind !== 'Prepared') throw new Error('verifier bundle rejected');
  expect(decodeEvaluationVerifierBundle(prepared.bundle)).toEqual({
    kind: 'Accepted',
    bundle: prepared.bundle,
  });
  const locked = manifest(
    prepared.bundle.d,
    prepared.bundle.protectedCase.stimulus.d,
    prepared.bundle.terminalCase.stimulus.d,
  );
  expect(bindEvaluationVerifierBundle(prepared.bundle, locked)).toEqual({ kind: 'Bound' });
  expect(
    bindEvaluationVerifierBundle(
      prepared.bundle,
      manifest(said('z'), locked.protectedCaseArtifactSaid, locked.finalCaseArtifactSaid),
    ),
  ).toEqual({ kind: 'Rejected', reason: 'ManifestMismatch' });
  expect(
    bindEvaluationVerifierBundle(
      prepared.bundle,
      manifest(prepared.bundle.d, said('y'), locked.finalCaseArtifactSaid),
    ),
  ).toEqual({ kind: 'Rejected', reason: 'ManifestMismatch' });
});

it('rejects duplicate public IDs, scope changes, and hidden plaintext fields', () => {
  const input = bundleInput();
  expect(
    prepareEvaluationVerifierBundle({
      ...input,
      publicConditions: [input.publicConditions[0], input.publicConditions[0]],
    }).kind,
  ).toBe('Rejected');
  expect(
    prepareEvaluationVerifierBundle({
      ...input,
      protectedCase: { ...input.protectedCase, objectSaid: said('v') },
    }).kind,
  ).toBe('Rejected');
  expect(prepareEvaluationVerifierBundle({ ...input, hiddenAnswer: 'legacy passes' }).kind).toBe(
    'Rejected',
  );
});

it('matches the disclosed tamper contract without prescribing a particular rejection error', () => {
  const input = bundleInput();
  expect(
    prepareEvaluationVerifierBundle({
      ...input,
      publicConditions: input.publicConditions.map((condition) =>
        condition.id === 'cesr-tamper'
          ? { ...condition, expected: { kind: 'Rejected', error: 'AnyRejection' } }
          : condition,
      ),
    }).kind,
  ).toBe('Prepared');
});

it('retains only exact canonical parent bundle bytes for M custody', () => {
  const prepared = prepareEvaluationVerifierBundle(bundleInput());
  if (prepared.kind !== 'Prepared') throw new Error('verifier bundle rejected');
  const encoded = encodeEvaluationVerifierBundle(prepared.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('bundle encoding rejected');
  expect(decodeEvaluationVerifierBundleBytes(encoded.bytes)).toEqual({
    kind: 'Accepted',
    bundle: prepared.bundle,
    bytes: encoded.bytes,
  });
  expect(
    decodeEvaluationVerifierBundleBytes(
      new TextEncoder().encode(`${JSON.stringify(prepared.bundle)}\n`),
    ),
  ).toEqual({ kind: 'Rejected' });
});
