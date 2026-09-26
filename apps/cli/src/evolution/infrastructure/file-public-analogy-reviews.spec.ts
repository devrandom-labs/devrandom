import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FilePublicAnalogyReviews } from './file-public-analogy-reviews.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const review = {
  version: 1 as const,
  kind: 'ReviewedPublicAnalogy' as const,
  episodeSaid: said('a'),
  runId: '33333333-3333-4333-8333-333333333333',
  rawEvidenceSaid: said('r'),
  observation: 'CESR legacy receipt parser rejected exit 101',
  recoveryAction: 'verify-current-framing',
  predictedCorrection: 'Check the current receipt framing under the public verifier.',
  implicatedComponent: 'Workflow' as const,
  regressionRisks: ['A changed receipt format could fail.'],
};

describe('parent public analogy review file custody', () => {
  it('commits exact SAIDed bytes once and rejects corrupt or substituted custody', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-h0-review-'));
    try {
      const custody = new FilePublicAnalogyReviews(directory);
      const committed = await custody.commit(review);
      expect(committed.kind).toBe('Committed');
      if (committed.kind !== 'Committed') return;
      expect(await custody.commit(review)).toEqual({
        kind: 'AlreadyCommitted',
        artifact: committed.artifact,
      });
      expect(await custody.read(committed.artifact.d)).toMatchObject({
        kind: 'Read',
        review,
      });
      await writeFile(
        join(directory, `${committed.artifact.d}.json`),
        JSON.stringify({ ...review, observation: 'substituted' }),
      );
      expect(await custody.read(committed.artifact.d)).toEqual({ kind: 'Unavailable' });
      expect(await custody.commit(review)).toEqual({ kind: 'Rejected' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink that impersonates review custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-h0-review-link-'));
    try {
      const real = join(root, 'real');
      const link = join(root, 'link');
      await new FilePublicAnalogyReviews(real).commit(review);
      await symlink(real, link);
      expect((await new FilePublicAnalogyReviews(link).commit(review)).kind).toBe('Rejected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
