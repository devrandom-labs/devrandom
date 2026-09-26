import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareProtectedEvaluationArtifact } from '@devrandom/protocol';

import { AesGcmProtectedCaseCustody } from './aes-gcm-protected-case-custody.js';

const evaluationId = '11111111-1111-4111-8111-111111111111';
const objectSaid = `E${'o'.repeat(43)}`;
const caseInput = {
  evaluationId,
  objectSaid,
  purpose: 'TrialHoldout' as const,
  segment: 3,
  plaintext: Buffer.from('private expected receipt: current accepted; legacy rejected'),
};

describe('parent-only protected case custody', () => {
  it('seals exact bytes and opens them only under the original case scope', async () => {
    const key = randomBytes(32);
    const custody = new AesGcmProtectedCaseCustody(key);
    const sealed = await custody.seal(caseInput);
    expect(sealed.kind).toBe('Sealed');
    if (sealed.kind !== 'Sealed') return;
    expect(JSON.stringify(sealed.artifact)).not.toContain('private expected receipt');
    expect(sealed.artifact.plaintextByteCount).toBe(caseInput.plaintext.byteLength);
    key.fill(0); // The adapter must own a defensive key copy.
    await expect(custody.open({ artifact: sealed.artifact, ...caseInput })).resolves.toEqual({
      kind: 'Opened',
      plaintext: new Uint8Array(caseInput.plaintext),
    });
    await expect(
      custody.open({ artifact: sealed.artifact, ...caseInput, segment: 4 }),
    ).resolves.toEqual({ kind: 'Rejected' });
    await expect(
      custody.open({ artifact: sealed.artifact, ...caseInput, purpose: 'TerminalCase' }),
    ).resolves.toEqual({ kind: 'Rejected' });
    await expect(
      custody.open({ artifact: sealed.artifact, ...caseInput, objectSaid: `E${'p'.repeat(43)}` }),
    ).resolves.toEqual({ kind: 'Rejected' });
  });

  it('rejects SAID substitution and detects valid-SAID ciphertext forgery or wrong key', async () => {
    const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
    const sealed = await custody.seal(caseInput);
    if (sealed.kind !== 'Sealed') throw new Error('seal failed');
    const substituted = { ...sealed.artifact, ciphertext: 'AA' };
    await expect(custody.open({ artifact: substituted, ...caseInput })).resolves.toEqual({
      kind: 'Rejected',
    });
    const forged = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose: 'TrialHoldout',
      segment: 3,
      nonce: sealed.artifact.nonce,
      tag: sealed.artifact.tag,
      ciphertext: Buffer.from('changed').toString('base64url'),
      plaintextByteCount: 7,
    });
    if (forged.kind !== 'Prepared') throw new Error('forge setup failed');
    await expect(custody.open({ artifact: forged.artifact, ...caseInput })).resolves.toEqual({
      kind: 'Corrupt',
    });
    const rebound = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose: 'TerminalCase',
      segment: 3,
      nonce: sealed.artifact.nonce,
      tag: sealed.artifact.tag,
      ciphertext: sealed.artifact.ciphertext,
      plaintextByteCount: sealed.artifact.plaintextByteCount,
    });
    if (rebound.kind !== 'Prepared') throw new Error('rebound setup failed');
    await expect(
      custody.open({ artifact: rebound.artifact, ...caseInput, purpose: 'TerminalCase' }),
    ).resolves.toEqual({ kind: 'Corrupt' });
    await expect(
      new AesGcmProtectedCaseCustody(randomBytes(32)).open({
        artifact: sealed.artifact,
        ...caseInput,
      }),
    ).resolves.toEqual({ kind: 'Corrupt' });
  });

  it('never reuses a nonce with the same parent key and refuses invalid plaintext', async () => {
    const custody = new AesGcmProtectedCaseCustody(randomBytes(32), () => Buffer.alloc(12, 7));
    expect((await custody.seal(caseInput)).kind).toBe('Sealed');
    await expect(custody.seal(caseInput)).resolves.toEqual({ kind: 'NonceExhausted' });
    await expect(custody.seal({ ...caseInput, plaintext: new Uint8Array() })).resolves.toEqual({
      kind: 'Rejected',
    });
    await expect(
      custody.seal({ ...caseInput, plaintext: new Uint8Array(512 * 1024 + 1) }),
    ).resolves.toEqual({ kind: 'Rejected' });
  });
});
