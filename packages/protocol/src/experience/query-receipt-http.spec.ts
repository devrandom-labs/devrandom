import { describe, expect, it } from 'vitest';

import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import { decodeExperienceQueryReceiptReadResponse } from './query-receipt-http.js';

describe('exact Experience query receipt transport', () => {
  it('decodes a canonical bounded slice and rejects substituted metadata or noncanonical base64url', () => {
    const full = Buffer.from('{"query":"legacy parser"}', 'utf8');
    const identified = prepareEvidenceArtifact(full, 'application/json');
    if (identified.kind !== 'Prepared') throw new Error('fixture artifact invalid');
    const response = {
      version: 1,
      kind: 'Read',
      artifact: identified.artifact,
      totalBytes: full.byteLength,
      offset: 2,
      bytesBase64Url: full.subarray(2, 7).toString('base64url'),
    };
    expect(decodeExperienceQueryReceiptReadResponse(response)).toEqual({
      kind: 'Accepted',
      response,
      bytes: full.subarray(2, 7),
    });
    expect(
      decodeExperienceQueryReceiptReadResponse({
        ...response,
        artifact: { ...response.artifact, contentDigest: `sha256:${'0'.repeat(64)}` },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeExperienceQueryReceiptReadResponse({ ...response, bytesBase64Url: 'YQ==' }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeExperienceQueryReceiptReadResponse({ ...response, offset: full.byteLength }),
    ).toEqual({ kind: 'Rejected' });
  });
});
