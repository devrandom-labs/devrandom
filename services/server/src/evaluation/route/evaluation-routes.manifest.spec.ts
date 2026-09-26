import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import { lockEvaluationManifest } from '../application/lock-evaluation-manifest.js';
import { evaluationRoutes, type EvaluationRoutesConfiguration } from './evaluation-routes.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const allowance = {
  providerRequests: 1,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 1,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 20_000,
};

function fixture(ciphertextLength = 2) {
  const evaluationId = randomUUID();
  const taskId = randomUUID();
  const ownerAid = said('o');
  const agentAid = said('a');
  const artifact = (
    purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
    objectSaid: string,
    segment: number,
    nonce: string,
  ) => {
    const result = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose,
      segment,
      nonce,
      tag: 'AAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'A'.repeat(ciphertextLength),
      plaintextByteCount: ciphertextLength === 2 ? 1 : (ciphertextLength * 3) / 4,
    });
    if (result.kind !== 'Prepared') throw new Error('ciphertext fixture invalid');
    return result.artifact;
  };
  const trialObject = said('q');
  const terminalObject = said('r');
  const trialStimulus = artifact('TrialHoldout', trialObject, 0, 'AAAAAAAAAAAAAAAA');
  const trialExpected = artifact('OracleObservation', trialObject, 0, 'BBBBBBBBBBBBBBBB');
  const terminalStimulus = artifact('TerminalCase', terminalObject, 1, 'CCCCCCCCCCCCCCCC');
  const terminalExpected = artifact('OracleObservation', terminalObject, 1, 'DDDDDDDDDDDDDDDD');
  const verifier = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid,
    personalAgentAid: agentAid,
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
    reviewedRecipeSaid: said('w'),
    toolchainSaid: said('u'),
    publicConditions: ['cesr-current', 'cesr-tamper', 'cesr-legacy'].map((id) => ({
      id,
      stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
      expected:
        id === 'cesr-tamper'
          ? { kind: 'Rejected' as const, error: 'AnyRejection' as const }
          : {
              kind: 'Parsed' as const,
              receipts: [{ version: 'Current' as const, payload: said('x') }],
            },
    })),
    protectedCase: {
      objectSaid: trialObject,
      stimulus: trialStimulus,
      expected: trialExpected,
    },
    terminalCase: {
      objectSaid: terminalObject,
      stimulus: terminalStimulus,
      expected: terminalExpected,
    },
  });
  if (verifier.kind !== 'Prepared') throw new Error('verifier fixture invalid');
  const encoded = encodeEvaluationVerifierBundle(verifier.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('verifier bytes invalid');
  const prepared = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    originRunId: randomUUID(),
    ownerAid,
    personalAgentAid: agentAid,
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('1'), C2: said('2'), C3: said('3') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    verifierSaid: verifier.bundle.d,
    protectedCaseArtifactSaid: trialStimulus.d,
    finalCaseArtifactSaid: terminalStimulus.d,
    publicConditionIds: ['cesr-current', 'cesr-tamper', 'cesr-legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (prepared.kind !== 'Prepared') throw new Error('manifest fixture invalid');
  return {
    evaluationId,
    ownerAid,
    command: {
      version: 1 as const,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      expectedEvaluationVersion: 1,
      leaseId: randomUUID(),
      manifest: prepared.manifest,
      verifierBundle: verifier.bundle,
      verifierBundleBytesBase64Url: Buffer.from(encoded.bytes).toString('base64url'),
      protectedArtifacts: [trialStimulus, trialExpected, terminalStimulus, terminalExpected],
    },
  };
}

describe('public immutable Evaluation manifest command', () => {
  it('accepts an exact M command above the ordinary artifact limit within the Evaluation body cap', async () => {
    const { evaluationId, ownerAid, command } = fixture(65_536);
    const body = JSON.stringify(command);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(589_824);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(1_048_576);
    const lock = vi.fn().mockResolvedValue({
      kind: 'Locked',
      evaluationId,
      manifestSaid: command.manifest.d,
      ownerAid,
      policySaid: command.manifest.policySaid,
      leaseId: command.leaseId,
      lockedAtLeaseVersion: 1,
      lockedAtEvaluationVersion: 2,
      currentLeaseVersion: 1,
      currentEvaluationVersion: 2,
    });
    const server = Fastify();
    server.register(
      evaluationRoutes({
        access: { authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid }) },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: { lock, inspect: () => Promise.resolve({ kind: 'Unavailable' }) },
        evidence: {
          accept: () => Promise.resolve({ kind: 'Unavailable' }),
          close: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        now: () => new Date().toISOString(),
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${address}/api/evaluations/${evaluationId}/manifest`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${'b'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body,
      });
      expect(response.status).toBe(201);
      expect(lock).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('rejects substituted raw verifier bytes, missing ciphertext, and owner mismatch before storage', async () => {
    const { command, ownerAid } = fixture();
    const lock = vi.fn();
    const dependencies = {
      authority: {
        inspect: () =>
          Promise.resolve({
            kind: 'Authorized' as const,
            taskRevisionSaid: command.manifest.taskRevisionSaid,
            personalAgentAid: command.manifest.personalAgentAid,
            taskMandateSaid: command.manifest.taskMandateSaid,
          }),
      },
      locks: { lock, inspect: () => Promise.resolve({ kind: 'Unavailable' as const }) },
    };
    expect(
      await lockEvaluationManifest(
        {
          ownerAid,
          command: {
            ...command,
            verifierBundleBytesBase64Url: Buffer.from('{}').toString('base64url'),
          },
        },
        dependencies,
      ),
    ).toEqual({ kind: 'Invalid' });
    expect(
      await lockEvaluationManifest(
        {
          ownerAid,
          command: {
            ...command,
            protectedArtifacts: command.protectedArtifacts.slice(0, 3),
          },
        },
        dependencies,
      ),
    ).toEqual({ kind: 'Invalid' });
    expect(await lockEvaluationManifest({ ownerAid: said('x'), command }, dependencies)).toEqual({
      kind: 'Invalid',
    });
    expect(lock).not.toHaveBeenCalled();
  });

  it('routes exact owner-scoped M and four ciphertext descriptors through listening Fastify', async () => {
    const { evaluationId, ownerAid, command } = fixture();
    const lock = vi.fn(() =>
      Promise.resolve({
        kind: 'Locked' as const,
        evaluationId,
        manifestSaid: command.manifest.d,
        ownerAid,
        policySaid: command.manifest.policySaid,
        leaseId: command.leaseId,
        lockedAtLeaseVersion: 1,
        lockedAtEvaluationVersion: 2,
        currentLeaseVersion: 1,
        currentEvaluationVersion: 2,
      }),
    );
    const server = Fastify();
    const configuration: EvaluationRoutesConfiguration = {
      access: { authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid }) },
      preparation: { prepare: () => Promise.resolve('Unavailable') },
      admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
      leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
      manifest: { lock, inspect: () => Promise.resolve({ kind: 'Unavailable' }) },
      evidence: {
        accept: () => Promise.resolve({ kind: 'Unavailable' }),
        close: () => Promise.resolve({ kind: 'Unavailable' }),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    server.register(evaluationRoutes(configuration));
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const plaintext = await fetch(`${address}/api/evaluations/${evaluationId}/manifest`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${'b'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...command,
          verifierBundle: { ...command.verifierBundle, hiddenAnswer: 'candidate should pass' },
        }),
      });
      expect(plaintext.status).toBe(400);
      expect(lock).not.toHaveBeenCalled();
      const response = await fetch(`${address}/api/evaluations/${evaluationId}/manifest`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${'b'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        kind: 'Locked',
        evaluationId,
        manifestSaid: command.manifest.d,
        ownerAid,
        policySaid: command.manifest.policySaid,
        leaseId: command.leaseId,
        lockedAtLeaseVersion: 1,
        lockedAtEvaluationVersion: 2,
        currentLeaseVersion: 1,
        currentEvaluationVersion: 2,
      });
      expect(lock).toHaveBeenCalledWith({ ownerAid, command });
    } finally {
      await server.close();
    }
  });
});
