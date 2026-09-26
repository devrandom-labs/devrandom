import { describe, expect, it } from 'vitest';

import { decodeEvidenceArtifact, prepareEvidenceArtifact } from './evidence-artifact.js';

describe('evidence artifact protocol', () => {
  it('binds the exact bytes, media type, length, and content digest', () => {
    const bytes = new TextEncoder().encode('public verifier output\n');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');

    expect(prepared).toMatchObject({
      kind: 'Prepared',
      artifact: {
        version: 1,
        mediaType: 'text/plain; charset=utf-8',
        byteLength: bytes.byteLength,
      },
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture artifact must prepare');
    }
    expect(prepared.artifact.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(prepared.artifact.d).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(decodeEvidenceArtifact(prepared.artifact, bytes)).toEqual({
      kind: 'Accepted',
      artifact: prepared.artifact,
    });
  });

  it('rejects byte substitution and mutation under a retained SAID', () => {
    const bytes = new TextEncoder().encode('expected');
    const prepared = prepareEvidenceArtifact(bytes, 'application/octet-stream');
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture artifact must prepare');
    }

    expect(decodeEvidenceArtifact(prepared.artifact, new TextEncoder().encode('replaced'))).toEqual(
      { kind: 'Rejected', reason: 'ContentDigestMismatch' },
    );
    expect(
      decodeEvidenceArtifact({ ...prepared.artifact, mediaType: 'application/json' }, bytes),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });

  it('rejects artifacts above the exact 512 KiB bound and unknown media types', () => {
    expect(
      prepareEvidenceArtifact(new Uint8Array(512 * 1_024 + 1), 'application/octet-stream'),
    ).toEqual({ kind: 'Rejected', reason: 'ArtifactTooLarge' });
    expect(prepareEvidenceArtifact(new Uint8Array(), 'text/html')).toEqual({
      kind: 'Rejected',
      reason: 'MediaTypeInvalid',
    });
  });
});
