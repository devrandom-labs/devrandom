import { describe, expect, it, vi } from 'vitest';

import {
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import type { ProtectedCaseCustody, ReceiptObservation } from './evaluation-conversations.js';
import { assessProtectedCesrCase } from './assess-protected-cesr-case.js';

const evaluationId = '11111111-1111-4111-8111-111111111111';
const objectSaid = `E${'o'.repeat(43)}`;
const executableSaid = `E${'e'.repeat(43)}`;
const payload = `E${'p'.repeat(43)}`;
const stimulus = Buffer.from(`-AAL${payload}`);
const expected = Buffer.from(
  JSON.stringify({ kind: 'Parsed', receipts: [{ version: 'Current', payload }] }),
);

function artifact(purpose: ProtectedEvaluationArtifact['purpose']): ProtectedEvaluationArtifact {
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId,
    objectSaid,
    purpose,
    segment: 0,
    nonce: purpose === 'TrialHoldout' ? 'AAAAAAAAAAAAAAAA' : 'BBBBBBBBBBBBBBBB',
    tag: 'AAAAAAAAAAAAAAAAAAAAAA',
    ciphertext: 'AQ',
    plaintextByteCount: 1,
  });
  if (prepared.kind !== 'Prepared') throw new Error('Invalid fixture artifact.');
  return prepared.artifact;
}

function fixture(
  observation: Extract<
    Awaited<ReturnType<ReceiptObservation['observe']>>,
    { kind: 'Observed' }
  >['observation'] = { kind: 'Parsed', receipts: [{ version: 'Current', payload }] },
) {
  const stimulusArtifact = artifact('TrialHoldout');
  const expectedArtifact = artifact('OracleObservation');
  const protectedObservation = artifact('OracleObservation');
  const open = vi.fn((input: { readonly artifact: ProtectedEvaluationArtifact }) =>
    Promise.resolve({
      kind: 'Opened' as const,
      plaintext: Buffer.from(input.artifact.d === stimulusArtifact.d ? stimulus : expected),
    }),
  );
  const observe = vi.fn(
    (
      observationInput: Parameters<ReceiptObservation['observe']>[0],
    ): ReturnType<ReceiptObservation['observe']> => {
      if (observationInput.caseScope !== 'Protected') throw new Error('Expected protected scope.');
      return Promise.resolve({
        kind: 'Observed' as const,
        executableSaid,
        observation,
        rawObservationSaid: protectedObservation.d,
        protectedObservation,
        cleanupReceiptSaid: `E${'c'.repeat(43)}`,
      });
    },
  );
  return {
    stimulusArtifact,
    expectedArtifact,
    protectedObservation,
    custody: { open } as unknown as ProtectedCaseCustody,
    observer: { observe } as unknown as ReceiptObservation,
    open,
    observe,
  };
}

function input(f: ReturnType<typeof fixture>) {
  return {
    evaluationId,
    objectSaid,
    segment: 0,
    executableSaid,
    stimulusArtifact: f.stimulusArtifact,
    expectedArtifact: f.expectedArtifact,
    signal: new AbortController().signal,
  };
}

describe('parent CESR protected case oracle', () => {
  it('compares actual frozen executable observation to a parent-only expected artifact', async () => {
    const f = fixture();
    await expect(assessProtectedCesrCase(input(f), f.custody, f.observer)).resolves.toEqual({
      kind: 'Assessed',
      verdict: 'Pass',
      observationArtifact: f.protectedObservation,
      cleanupReceiptSaid: `E${'c'.repeat(43)}`,
    });
    expect(f.open).toHaveBeenCalledTimes(2);
    const prepared = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('Invalid stimulus fixture.');
    expect(f.observe).toHaveBeenCalledOnce();
    const observedInput = f.observe.mock.calls[0]?.[0];
    expect(observedInput).toMatchObject({
      executableSaid,
      stimulusSaid: prepared.artifact.d,
      caseScope: 'Protected',
      evaluationId,
      objectSaid,
      segment: 0,
    });
    expect(observedInput?.signal).toBeInstanceOf(AbortSignal);
  });

  it('records a real mismatch as Fail without trusting a child verdict', async () => {
    const f = fixture({ kind: 'Rejected', error: 'InvalidPayload' });
    await expect(assessProtectedCesrCase(input(f), f.custody, f.observer)).resolves.toMatchObject({
      kind: 'Assessed',
      verdict: 'Fail',
    });
  });

  it('rejects a swapped protected artifact before opening or running the executable', async () => {
    const f = fixture();
    await expect(
      assessProtectedCesrCase(
        {
          ...input(f),
          expectedArtifact: { ...f.expectedArtifact, objectSaid: `E${'x'.repeat(43)}` },
        },
        f.custody,
        f.observer,
      ),
    ).resolves.toEqual({ kind: 'Invalid', reason: 'CustodyRejected' });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('cannot grade if the native observer fails to return sealed protected output', async () => {
    const f = fixture();
    f.observe.mockResolvedValueOnce({
      kind: 'Observed',
      executableSaid,
      observation: { kind: 'Parsed', receipts: [{ version: 'Current', payload }] },
      rawObservationSaid: `E${'r'.repeat(43)}`,
      cleanupReceiptSaid: `E${'c'.repeat(43)}`,
    });
    await expect(assessProtectedCesrCase(input(f), f.custody, f.observer)).resolves.toEqual({
      kind: 'Invalid',
      reason: 'EvidenceUnavailable',
    });
  });

  it('fails closed when the native observer throws after opening a private stimulus', async () => {
    const f = fixture();
    f.observe.mockRejectedValueOnce(new Error('native observer unavailable'));
    await expect(assessProtectedCesrCase(input(f), f.custody, f.observer)).resolves.toEqual({
      kind: 'Invalid',
      reason: 'EvidenceUnavailable',
    });
  });
});
