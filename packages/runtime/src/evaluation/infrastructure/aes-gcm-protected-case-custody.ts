import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  decodeProtectedEvaluationArtifact,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import type { ProtectedCaseCustody } from '../application/evaluation-conversations.js';

type CaseScope = {
  readonly evaluationId: string;
  readonly objectSaid: string;
  readonly purpose: 'TrialHoldout' | 'OracleObservation' | 'TerminalCase';
  readonly segment: number;
};

function authenticatedScope(scope: CaseScope): Buffer {
  return Buffer.from(
    JSON.stringify({
      evaluationId: scope.evaluationId,
      objectSaid: scope.objectSaid,
      purpose: scope.purpose,
      segment: scope.segment,
    }),
  );
}

function canonicalBase64Url(value: string): Buffer | undefined {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

/** Trusted-parent key custody for sealed Evaluation cases; never compose into a worker. */
export class AesGcmProtectedCaseCustody implements ProtectedCaseCustody {
  readonly #key: Buffer;
  readonly #nonces = new Set<string>();
  readonly #nextNonce: () => Uint8Array;

  constructor(key: Uint8Array, nextNonce: () => Uint8Array = () => randomBytes(12)) {
    if (key.byteLength !== 32) throw new Error('AES-256-GCM custody requires a 32-byte key');
    this.#key = Buffer.from(key);
    this.#nextNonce = nextNonce;
  }

  seal(
    input: Parameters<ProtectedCaseCustody['seal']>[0],
  ): ReturnType<ProtectedCaseCustody['seal']> {
    return Promise.resolve(this.#seal(input));
  }

  #seal(
    input: Parameters<ProtectedCaseCustody['seal']>[0],
  ): Awaited<ReturnType<ProtectedCaseCustody['seal']>> {
    if (
      !(input.plaintext instanceof Uint8Array) ||
      input.plaintext.byteLength < 1 ||
      input.plaintext.byteLength > 512 * 1024
    )
      return { kind: 'Rejected' };
    let nonce: Uint8Array;
    try {
      nonce = this.#nextNonce();
    } catch {
      return { kind: 'Unavailable' };
    }
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 12) return { kind: 'Rejected' };
    const nonceText = Buffer.from(nonce).toString('base64url');
    if (this.#nonces.has(nonceText)) return { kind: 'NonceExhausted' };
    this.#nonces.add(nonceText);
    try {
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(authenticatedScope(input));
      const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
      const prepared = prepareProtectedEvaluationArtifact({
        evaluationId: input.evaluationId,
        objectSaid: input.objectSaid,
        purpose: input.purpose,
        segment: input.segment,
        nonce: nonceText,
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        plaintextByteCount: input.plaintext.byteLength,
      });
      return prepared.kind === 'Prepared'
        ? { kind: 'Sealed', artifact: prepared.artifact }
        : { kind: 'Rejected' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  open(
    input: Parameters<ProtectedCaseCustody['open']>[0],
  ): ReturnType<ProtectedCaseCustody['open']> {
    return Promise.resolve(this.#open(input));
  }

  #open(
    input: Parameters<ProtectedCaseCustody['open']>[0],
  ): Awaited<ReturnType<ProtectedCaseCustody['open']>> {
    const decoded = decodeProtectedEvaluationArtifact(input.artifact);
    if (decoded.kind !== 'Accepted') return { kind: 'Rejected' };
    const artifact = decoded.artifact;
    if (
      artifact.evaluationId !== input.evaluationId ||
      artifact.objectSaid !== input.objectSaid ||
      artifact.purpose !== input.purpose ||
      artifact.segment !== input.segment
    )
      return { kind: 'Rejected' };
    const nonce = canonicalBase64Url(artifact.nonce);
    const tag = canonicalBase64Url(artifact.tag);
    const ciphertext = canonicalBase64Url(artifact.ciphertext);
    if (!nonce || nonce.byteLength !== 12 || !tag || tag.byteLength !== 16 || !ciphertext)
      return { kind: 'Corrupt' };
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(authenticatedScope(artifact));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength !== artifact.plaintextByteCount) return { kind: 'Corrupt' };
      return { kind: 'Opened', plaintext: new Uint8Array(plaintext) };
    } catch {
      return { kind: 'Corrupt' };
    }
  }
}
