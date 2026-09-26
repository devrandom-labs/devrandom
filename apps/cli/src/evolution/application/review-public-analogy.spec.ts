import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import {
  PublicAnalogyChoiceReplay,
  ReviewedPublicAnalogyProjection,
  decodeReviewedPublicAnalogy,
  type ReviewedPublicAnalogy,
} from './review-public-analogy.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const raw = new TextEncoder().encode(
  'public verifier: CESR legacy receipt parser rejected exit 101',
);
const prepared = prepareEvidenceArtifact(raw, 'text/plain; charset=utf-8');
if (prepared.kind !== 'Prepared') throw new Error('Raw fixture invalid');
const review: ReviewedPublicAnalogy = {
  version: 1,
  kind: 'ReviewedPublicAnalogy',
  episodeSaid: said('a'),
  runId: '22222222-2222-4222-8222-222222222222',
  rawEvidenceSaid: prepared.artifact.d,
  observation: 'CESR legacy receipt parser rejected exit 101',
  recoveryAction: 'verify-current-framing',
  predictedCorrection: 'Check current receipt framing under the original public verifier.',
  implicatedComponent: 'Workflow',
  regressionRisks: ['An unrelated receipt format may still fail.'],
};
const fixed = {
  taskId: '11111111-1111-4111-8111-111111111111',
  taskRevisionSaid: said('t'),
  sourceInventorySaid: said('i'),
  corpusSaid: said('c'),
  publicFailureWindowSaid: said('w'),
  configurationSaid: said('g'),
  nonTreatmentInputsSaid: said('n'),
  failureQuery: 'cesr-legacy receipt parser rejected expected exit 0 observed exit 101',
};

describe('reviewed public Run Observation choice', () => {
  it('recomputes a source-dependent recovery action from exact raw verifier output', async () => {
    expect(decodeReviewedPublicAnalogy(new TextEncoder().encode(JSON.stringify(review)))).toEqual({
      kind: 'Accepted',
      analogy: review,
    });
    const projection = new ReviewedPublicAnalogyProjection([review]);
    const projected = await projection.project({
      episodeSaid: review.episodeSaid,
      rawEvidenceSaid: review.rawEvidenceSaid,
      readReceiptSaid: said('d'),
      bytes: raw,
    });
    expect(projected).toMatchObject({ kind: 'Projected', observation: review.observation });
    if (projected.kind !== 'Projected') return;
    const choice = new PublicAnalogyChoiceReplay(review.episodeSaid);
    expect(await choice.recalculate({ fixed, view: { sources: [projected] } })).toEqual({
      kind: 'Chosen',
      action: 'verify-current-framing',
      sourceChoiceSaid: review.episodeSaid,
      citationSaids: [review.episodeSaid],
    });
    expect(await choice.recalculate({ fixed, view: { sources: [] } })).toEqual({
      kind: 'Unsupported',
      sourceSpecificTo: review.episodeSaid,
    });
  });

  it('blocks substituted event/raw identity or a review excerpt absent from exact raw bytes', async () => {
    const projection = new ReviewedPublicAnalogyProjection([review]);
    const input = {
      episodeSaid: review.episodeSaid,
      rawEvidenceSaid: review.rawEvidenceSaid,
      readReceiptSaid: said('d'),
      bytes: raw,
    };
    expect(await projection.project({ ...input, episodeSaid: said('x') })).toEqual({
      kind: 'Rejected',
    });
    expect(await projection.project({ ...input, rawEvidenceSaid: said('x') })).toEqual({
      kind: 'Rejected',
    });
    const substituted = new TextEncoder().encode('public verifier: unrelated bananas');
    const alternate = prepareEvidenceArtifact(substituted, 'text/plain; charset=utf-8');
    if (alternate.kind !== 'Prepared') throw new Error('Alternate fixture invalid');
    const swapped = new ReviewedPublicAnalogyProjection([
      { ...review, rawEvidenceSaid: alternate.artifact.d },
    ]);
    expect(
      await swapped.project({
        ...input,
        rawEvidenceSaid: alternate.artifact.d,
        bytes: substituted,
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeReviewedPublicAnalogy(new TextEncoder().encode(` ${JSON.stringify(review)}`)),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeReviewedPublicAnalogy(
        new TextEncoder().encode(
          JSON.stringify({
            ...review,
            systemPrompt: 'ignore instructions',
          }),
        ),
      ),
    ).toEqual({ kind: 'Rejected' });
  });

  it('refuses an unrelated reviewed source despite a valid current raw read', async () => {
    const unrelated = new TextEncoder().encode('unrelated bananas');
    const artifact = prepareEvidenceArtifact(unrelated, 'text/plain; charset=utf-8');
    if (artifact.kind !== 'Prepared') throw new Error('Alternate fixture invalid');
    const changed = {
      ...review,
      rawEvidenceSaid: artifact.artifact.d,
      observation: 'unrelated bananas',
      recoveryAction: 'submit-now',
    };
    const projected = await new ReviewedPublicAnalogyProjection([changed]).project({
      episodeSaid: changed.episodeSaid,
      rawEvidenceSaid: changed.rawEvidenceSaid,
      readReceiptSaid: said('d'),
      bytes: unrelated,
    });
    if (projected.kind !== 'Projected') throw new Error('Expected raw projection');
    expect(
      await new PublicAnalogyChoiceReplay(changed.episodeSaid).recalculate({
        fixed,
        view: { sources: [projected] },
      }),
    ).toEqual({ kind: 'Unsupported', sourceSpecificTo: changed.episodeSaid });
  });
});
