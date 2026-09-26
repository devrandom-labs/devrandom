import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { assessC2PublicSubmission } from './c2-workflow-transition.js';

const said = (character: string): string => `E${character.repeat(43)}`;

describe('C2 stopped-source public gate', () => {
  const capture = said('s');
  const proposal = said('p');
  const bytes = Buffer.from('{"kind":"OriginalPublicVerifier","passed":false}', 'utf8');
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('Fixture artifact invalid.');

  it('retains a complete public failure as negative trial evidence', () => {
    expect(
      assessC2PublicSubmission(
        { capturedSourceSaid: capture, proposalEventSaid: proposal },
        {
          kind: 'Failed',
          capturedSourceSaid: capture,
          proposalEventSaid: proposal,
          publicVerifierReceiptSaid: artifact.artifact.d,
          receiptBytes: bytes,
        },
      ),
    ).toMatchObject({ kind: 'Negative', receiptSaid: artifact.artifact.d });
  });

  it('blocks a swapped source, proposal, receipt or unavailable public gate', () => {
    const failure = {
      kind: 'Failed' as const,
      capturedSourceSaid: capture,
      proposalEventSaid: proposal,
      publicVerifierReceiptSaid: artifact.artifact.d,
      receiptBytes: bytes,
    };
    for (const changed of [
      { ...failure, capturedSourceSaid: said('x') },
      { ...failure, proposalEventSaid: said('x') },
      { ...failure, receiptBytes: Buffer.from('changed') },
    ])
      expect(
        assessC2PublicSubmission(
          { capturedSourceSaid: capture, proposalEventSaid: proposal },
          changed,
        ),
      ).toEqual({ kind: 'Invalid' });
    expect(
      assessC2PublicSubmission(
        { capturedSourceSaid: capture, proposalEventSaid: proposal },
        { kind: 'Unavailable' },
      ),
    ).toEqual({ kind: 'Invalid' });
  });
});
