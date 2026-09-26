import { describe, expect, it } from 'vitest';

import {
  decodeProtectedEvaluationArtifact,
  prepareProtectedEvaluationArtifact,
} from './protected-artifact.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const input = {
  evaluationId: id('1'),
  objectSaid: said('o'),
  purpose: 'TrialHoldout',
  segment: 0,
  nonce: 'AAAAAAAAAAAAAAAA',
  tag: 'AAAAAAAAAAAAAAAAAAAAAA',
  ciphertext: 'AA',
  plaintextByteCount: 1,
};

describe('encrypted protected artifact contract', () => {
  it('binds only ciphertext and authenticated scope metadata', () => {
    const prepared = prepareProtectedEvaluationArtifact(input);
    if (prepared.kind !== 'Prepared') throw new Error('artifact rejected');
    expect(decodeProtectedEvaluationArtifact(prepared.artifact)).toEqual({
      kind: 'Accepted',
      artifact: prepared.artifact,
    });
    expect(prepared.artifact).not.toHaveProperty('plaintext');
  });

  it('rejects plaintext, malformed nonce and substituted purpose', () => {
    expect(prepareProtectedEvaluationArtifact({ ...input, plaintext: 'answer' })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareProtectedEvaluationArtifact({ ...input, nonce: 'AA' })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    const prepared = prepareProtectedEvaluationArtifact(input);
    if (prepared.kind !== 'Prepared') throw new Error('artifact rejected');
    expect(
      decodeProtectedEvaluationArtifact({ ...prepared.artifact, purpose: 'TerminalCase' }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });
});
