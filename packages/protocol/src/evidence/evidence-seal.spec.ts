import { describe, expect, it } from 'vitest';

import { decodeEvidenceSealPayload, evidenceSealExchangeRoute } from './evidence-seal.js';

const said = (character: string) => 'E'.concat(character.repeat(43));

describe('personal-agent evidence seal protocol', () => {
  it('binds the exact accepted stream head on the fixed Signify exchange route', () => {
    const payload = {
      version: 1 as const,
      kind: 'EvidenceStreamSeal' as const,
      runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      evidenceStreamId: 'a30aae94-a652-485f-a2cc-8980134f4acc',
      eventCount: 12,
      finalSequence: 11,
      chainHeadSaid: said('a'),
      harnessRevisionSaid: said('b'),
      taskMandateSaid: said('c'),
    };

    expect(evidenceSealExchangeRoute).toBe('/devrandom/evidence/seal/1');
    expect(decodeEvidenceSealPayload(payload)).toEqual({ kind: 'Accepted', payload });
  });

  it('rejects a noncontiguous final cursor and every undeclared field', () => {
    const payload = {
      version: 1 as const,
      kind: 'EvidenceStreamSeal' as const,
      runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      evidenceStreamId: 'a30aae94-a652-485f-a2cc-8980134f4acc',
      eventCount: 12,
      finalSequence: 9,
      chainHeadSaid: said('a'),
      harnessRevisionSaid: said('b'),
      taskMandateSaid: said('c'),
    };

    expect(decodeEvidenceSealPayload(payload)).toEqual({
      kind: 'Rejected',
      reason: 'CursorInvalid',
    });
    expect(
      decodeEvidenceSealPayload({ ...payload, finalSequence: 11, signature: 'invented' }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });
});
