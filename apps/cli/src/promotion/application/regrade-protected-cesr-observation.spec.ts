import { randomBytes } from 'node:crypto';

import {
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  prepareTrialObservationEvidence,
} from '@devrandom/protocol';
import { AesGcmProtectedCaseCustody } from '@devrandom/runtime';
import { expect, it } from 'vitest';

import { regradeProtectedCesrObservation } from './regrade-protected-cesr-observation.js';

const said = (character: string) => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const payload = said('x');
const objectSaid = said('q');
const expectedObservation = {
  kind: 'Parsed' as const,
  receipts: [{ version: 'Current' as const, payload }],
};

async function fixture() {
  const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
  async function seal(
    purpose: 'TrialHoldout' | 'OracleObservation' | 'TerminalCase',
    object: string,
    segment: number,
    plaintext: Uint8Array,
  ) {
    const result = await custody.seal({
      evaluationId,
      objectSaid: object,
      purpose,
      segment,
      plaintext,
    });
    if (result.kind !== 'Sealed') throw new Error('sealed fixture rejected');
    return result.artifact;
  }
  const stimulus = Buffer.from(`-AAL${payload}`);
  const stimulusSaid = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
  if (stimulusSaid.kind !== 'Prepared') throw new Error('stimulus rejected');
  const protectedCase = {
    objectSaid,
    stimulus: await seal('TrialHoldout', objectSaid, 0, stimulus),
    expected: await seal(
      'OracleObservation',
      objectSaid,
      0,
      Buffer.from(JSON.stringify(expectedObservation)),
    ),
  };
  const terminalObject = said('r');
  const terminalCase = {
    objectSaid: terminalObject,
    stimulus: await seal('TerminalCase', terminalObject, 1, stimulus),
    expected: await seal(
      'OracleObservation',
      terminalObject,
      1,
      Buffer.from(JSON.stringify(expectedObservation)),
    ),
  };
  const publicConditions = ['cesr-current', 'cesr-tamper', 'cesr-legacy'].map((id) => ({
    id,
    stimulusBase64Url: stimulus.toString('base64url'),
    expected: expectedObservation,
  }));
  const preparedBundle = prepareEvaluationVerifierBundle({
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
    publicConditions,
    protectedCase,
    terminalCase,
  });
  if (preparedBundle.kind !== 'Prepared') throw new Error('bundle rejected');
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
  const preparedManifest = prepareEvaluationManifest({
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
    verifierSaid: preparedBundle.bundle.d,
    protectedCaseArtifactSaid: protectedCase.stimulus.d,
    finalCaseArtifactSaid: terminalCase.stimulus.d,
    publicConditionIds: publicConditions.map((item) => item.id),
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (preparedManifest.kind !== 'Prepared') throw new Error('manifest rejected');
  const rawRecord = {
    executableSaid: said('h'),
    stimulusSaid: stimulusSaid.artifact.d,
    caseScope: 'Protected',
    observation: expectedObservation,
    stdout: `DV1|P|Current:${payload}\n`,
    effectiveLimitsDigest: `sha256:${'a'.repeat(64)}`,
  };
  const actual = await seal(
    'OracleObservation',
    objectSaid,
    0,
    Buffer.from(JSON.stringify(rawRecord)),
  );
  const preparedTrial = prepareTrialObservationEvidence({
    version: 1,
    kind: 'TrialObservationEvidence',
    evaluationId,
    manifestSaid: preparedManifest.manifest.d,
    harnessRevisionSaid: said('h'),
    observation: {
      slot: { arm: 'H1', repetition: 1, attempt: 1 },
      disposition: {
        kind: 'Measured',
        artifactSaid: said('h'),
        publicConditionIds: [],
        heldOutConditionIds: [objectSaid],
        usage: {
          providerRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          spendMicroUsd: 0,
          elapsedMilliseconds: 0,
          repeatedFailures: 0,
          unsafeProposals: 0,
          unsafePrevented: 0,
          unsafeEffects: 0,
        },
      },
    },
    capturedSourceSaid: said('n'),
    trialEvidenceHeadSaid: said('o'),
    trialCleanupReceiptSaid: said('p'),
    publicObservations: publicConditions.map((condition) => ({
      conditionId: condition.id,
      rawObservationSaid: said(condition.id.slice(-1)),
      verdict: 'Fail',
    })),
    protectedObservationSaid: actual.d,
    protectedVerdict: 'Pass',
    protectedCleanupReceiptSaid: said('u'),
    providerUsageEventSaids: [],
  });
  if (preparedTrial.kind !== 'Prepared') throw new Error('trial rejected');
  return {
    custody,
    manifest: preparedManifest.manifest,
    bundle: preparedBundle.bundle,
    trial: preparedTrial.evidence,
    actual,
    stimulusSaid: stimulusSaid.artifact.d,
  };
}

it('regrades the exact ACKed ciphertext after reopening the locked oracle and rejects asserted or substituted verdicts', async () => {
  const found = await fixture();
  const input = { manifest: found.manifest, verifier: found.bundle, trial: found.trial };
  const ports = {
    custody: found.custody,
    ciphertext: {
      protectedArtifact: () => ({ kind: 'Found' as const, artifact: found.actual }),
    },
  };
  expect(await regradeProtectedCesrObservation(input, ports)).toEqual({
    kind: 'Verified',
    verdict: 'Pass',
  });
  const falselyFailed = {
    ...found.trial,
    protectedVerdict: 'Fail' as const,
    observation: {
      ...found.trial.observation,
      disposition: { ...found.trial.observation.disposition, heldOutConditionIds: [] },
    },
  };
  expect(prepareTrialObservationEvidence(falselyFailed).kind).toBe('Prepared');
  expect(await regradeProtectedCesrObservation({ ...input, trial: falselyFailed }, ports)).toEqual({
    kind: 'Incomplete',
  });
  const substitute = await found.custody.seal({
    evaluationId,
    objectSaid,
    purpose: 'OracleObservation',
    segment: 0,
    plaintext: Buffer.from(JSON.stringify({ kind: 'Rejected', error: 'InvalidFrame' })),
  });
  if (substitute.kind !== 'Sealed') throw new Error('substitute fixture rejected');
  expect(
    await regradeProtectedCesrObservation(input, {
      custody: found.custody,
      ciphertext: { protectedArtifact: () => ({ kind: 'Found', artifact: substitute.artifact }) },
    }),
  ).toEqual({ kind: 'Incomplete' });
  const falseRawRecord = {
    executableSaid: said('h'),
    stimulusSaid: found.stimulusSaid,
    caseScope: 'Protected',
    observation: { kind: 'Rejected', error: 'InvalidFrame' },
    stdout: 'DV1|R|InvalidFrame\n',
    effectiveLimitsDigest: `sha256:${'a'.repeat(64)}`,
  };
  const falseActual = await found.custody.seal({
    evaluationId,
    objectSaid,
    purpose: 'OracleObservation',
    segment: 0,
    plaintext: Buffer.from(JSON.stringify(falseRawRecord)),
  });
  if (falseActual.kind !== 'Sealed') throw new Error('false observation rejected');
  const falseClaim = { ...found.trial, protectedObservationSaid: falseActual.artifact.d };
  expect(prepareTrialObservationEvidence(falseClaim).kind).toBe('Prepared');
  expect(
    await regradeProtectedCesrObservation(
      { ...input, trial: falseClaim },
      {
        custody: found.custody,
        ciphertext: {
          protectedArtifact: () => ({ kind: 'Found', artifact: falseActual.artifact }),
        },
      },
    ),
  ).toEqual({ kind: 'Incomplete' });
});

it('rejects re-addressed ciphertext tampering, a foreign custody key, and an independently valid replacement evaluator', async () => {
  const found = await fixture();
  const input = { manifest: found.manifest, verifier: found.bundle, trial: found.trial };
  const ports = {
    custody: found.custody,
    ciphertext: { protectedArtifact: () => ({ kind: 'Found' as const, artifact: found.actual }) },
  };
  expect(await regradeProtectedCesrObservation(input, ports)).toEqual({
    kind: 'Verified',
    verdict: 'Pass',
  });
  // A fresh valid SAID cannot repair an invalid AES-GCM authentication tag.
  const ciphertext = Buffer.from(found.actual.ciphertext, 'base64url');
  ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
  const forged = prepareProtectedEvaluationArtifact({
    ...Object.fromEntries(
      Object.entries(found.actual).filter(([key]) => !['version', 'd', 'kind'].includes(key)),
    ),
    ciphertext: ciphertext.toString('base64url'),
  });
  if (forged.kind !== 'Prepared') throw new Error('tampering fixture rejected');
  expect(forged.artifact.d).not.toBe(found.actual.d);
  expect(
    await regradeProtectedCesrObservation(
      { ...input, trial: { ...found.trial, protectedObservationSaid: forged.artifact.d } },
      {
        ...ports,
        ciphertext: { protectedArtifact: () => ({ kind: 'Found', artifact: forged.artifact }) },
      },
    ),
  ).toEqual({ kind: 'Incomplete' });
  expect(
    await regradeProtectedCesrObservation(input, {
      ...ports,
      custody: new AesGcmProtectedCaseCustody(randomBytes(32)),
    }),
  ).toEqual({ kind: 'Incomplete' });

  const substituted = prepareEvaluationVerifierBundle({
    ...Object.fromEntries(
      Object.entries(found.bundle).filter(([key]) => !['version', 'd', 'kind'].includes(key)),
    ),
    oracleAdapterDigest: `sha256:${'e'.repeat(64)}`,
  });
  if (substituted.kind !== 'Prepared') throw new Error('replacement evaluator fixture rejected');
  expect(substituted.bundle.d).not.toBe(found.bundle.d);
  expect(
    await regradeProtectedCesrObservation({ ...input, verifier: substituted.bundle }, ports),
  ).toEqual({ kind: 'Incomplete' });
  // Every rejection leaves the original protected evidence independently usable.
  expect(await regradeProtectedCesrObservation(input, ports)).toEqual({
    kind: 'Verified',
    verdict: 'Pass',
  });
});
