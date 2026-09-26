import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  HuggingFaceExperienceEmbedding,
  pinnedAtlasExperienceProfile,
} from './huggingface-experience-embedding.js';

it('serves only the pinned local 384-dimensional sentence model with zero provider charge', async () => {
  let calls = 0;
  const embedding = new HuggingFaceExperienceEmbedding({
    load: () =>
      Promise.resolve(() => {
        calls += 1;
        return Promise.resolve({
          dims: [1, 384],
          data: Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
        });
      }),
  });
  const request = {
    text: 'The CESR legacy receipt parser rejects a current witness signature.',
    modelId: pinnedAtlasExperienceProfile.modelId,
    modelVersion: pinnedAtlasExperienceProfile.modelVersion,
    dimensions: pinnedAtlasExperienceProfile.dimensions,
  };
  expect(await embedding.embed({ ...request, modelVersion: 'main' })).toEqual({
    kind: 'Unavailable',
  });
  expect(await embedding.embed({ ...request, dimensions: 3 })).toEqual({ kind: 'Unavailable' });
  expect(calls).toBe(0);
  const result = await embedding.embed(request);
  expect(result.kind).toBe('Embedded');
  if (result.kind !== 'Embedded') return;
  expect(result.vector).toHaveLength(384);
  expect(result.chargedMicroUsd).toBe(0);
  expect(calls).toBe(1);
});

it('withholds malformed, unbounded and failed local model output', async () => {
  const embedding = new HuggingFaceExperienceEmbedding({
    load: () =>
      Promise.resolve(() => Promise.resolve({ dims: [1, 383], data: new Float32Array(383) })),
  });
  const request = {
    text: 'A real failure query',
    modelId: pinnedAtlasExperienceProfile.modelId,
    modelVersion: pinnedAtlasExperienceProfile.modelVersion,
    dimensions: pinnedAtlasExperienceProfile.dimensions,
  };
  expect(await embedding.embed(request)).toEqual({ kind: 'Unavailable' });
  expect(await embedding.embed({ ...request, text: 'x'.repeat(8193) })).toEqual({
    kind: 'Unavailable',
  });
  const nonFinite = new HuggingFaceExperienceEmbedding({
    load: () =>
      Promise.resolve(() =>
        Promise.resolve({
          dims: [1, 384],
          data: Float32Array.from({ length: 384 }, (_, index) => (index === 0 ? Number.NaN : 0)),
        }),
      ),
  });
  expect(await nonFinite.embed(request)).toEqual({ kind: 'Unavailable' });
});

it('refuses a model cache readable by other principals before loading weights', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'devrandom-model-cache-'));
  try {
    await chmod(cacheDirectory, 0o755);
    const embedding = new HuggingFaceExperienceEmbedding({ cacheDirectory });
    expect(
      await embedding.embed({
        text: 'A real failure query',
        modelId: pinnedAtlasExperienceProfile.modelId,
        modelVersion: pinnedAtlasExperienceProfile.modelVersion,
        dimensions: pinnedAtlasExperienceProfile.dimensions,
      }),
    ).toEqual({ kind: 'Unavailable' });
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
