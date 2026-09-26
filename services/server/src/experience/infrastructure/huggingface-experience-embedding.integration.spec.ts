import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  HuggingFaceExperienceEmbedding,
  pinnedAtlasExperienceProfile,
} from './huggingface-experience-embedding.js';

const realModel = process.env.DEVRANDOM_SEMANTIC_MODEL_TEST === '1' ? it : it.skip;

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

realModel(
  'loads the exact pinned local model and ranks a related failure above an unrelated text',
  async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'devrandom-minilm-'));
    try {
      const embedding = new HuggingFaceExperienceEmbedding({ cacheDirectory });
      const embed = (text: string) =>
        embedding.embed({
          text,
          modelId: pinnedAtlasExperienceProfile.modelId,
          modelVersion: pinnedAtlasExperienceProfile.modelVersion,
          dimensions: pinnedAtlasExperienceProfile.dimensions,
        });
      const query = await embed('Rust CESR receipt parser rejects current witness signatures');
      const related = await embed(
        'The current CESR witness signature receipt does not parse in Rust',
      );
      const unrelated = await embed('Bananas are yellow fruit grown in tropical climates');
      expect(query.kind).toBe('Embedded');
      expect(related.kind).toBe('Embedded');
      expect(unrelated.kind).toBe('Embedded');
      if (query.kind !== 'Embedded' || related.kind !== 'Embedded' || unrelated.kind !== 'Embedded')
        return;
      const relatedScore = cosine(query.vector, related.vector);
      const unrelatedScore = cosine(query.vector, unrelated.vector);
      expect(query.vector).toHaveLength(384);
      expect(relatedScore).toBeGreaterThan(unrelatedScore + 0.1);
      expect((1 + relatedScore) / 2).toBeGreaterThan(pinnedAtlasExperienceProfile.minimumScore);
      expect((1 + unrelatedScore) / 2).toBeLessThan(pinnedAtlasExperienceProfile.minimumScore);
      process.stdout.write(
        `${JSON.stringify({
          kind: 'PinnedLocalSemanticModel',
          modelId: pinnedAtlasExperienceProfile.modelId,
          modelVersion: pinnedAtlasExperienceProfile.modelVersion,
          dimensions: query.vector.length,
          relatedScore,
          unrelatedScore,
          chargedMicroUsd:
            query.chargedMicroUsd + related.chargedMicroUsd + unrelated.chargedMicroUsd,
        })}\n`,
      );
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);
