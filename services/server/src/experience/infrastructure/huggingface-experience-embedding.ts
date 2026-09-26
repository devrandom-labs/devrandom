import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { AtlasExperienceProfile, ExperienceEmbedding } from './mongo-atlas-experience.js';

/** E3 A5: one immutable local sentence model for both episode and failure-query vectors. */
export const pinnedAtlasExperienceProfile: AtlasExperienceProfile = Object.freeze({
  indexName: 'experience-minilm-l6-v2-q8-v1',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelVersion: '751bff37182d3f1213fa05d7196b954e230abad9',
  dimensions: 384,
  minimumScore: 0.7,
  maximumEmbeddingChargeMicroUsd: 0,
});

type FeatureExtractor = (text: string) => Promise<unknown>;

export interface HuggingFaceExperienceEmbeddingOptions {
  /** Private, server-owned model cache; the CLI and workers cannot read it. */
  readonly cacheDirectory?: string;
  /** Narrow test seam; production loads the pinned ONNX model locally. */
  load?(): Promise<FeatureExtractor>;
}

async function loadPinnedModel(cacheDirectory: string): Promise<FeatureExtractor> {
  if (!isAbsolute(cacheDirectory)) throw new Error('Model cache must be an absolute server path.');
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(cacheDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700)
    throw new Error('Model cache must be a private server directory.');
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', pinnedAtlasExperienceProfile.modelId, {
    revision: pinnedAtlasExperienceProfile.modelVersion,
    dtype: 'q8',
    device: 'cpu',
    cache_dir: cacheDirectory,
  });
  return (text) => extractor(text, { pooling: 'mean', normalize: true });
}

function vectorFromModel(output: unknown): readonly number[] | undefined {
  if (typeof output !== 'object' || output === null || !('dims' in output) || !('data' in output))
    return undefined;
  const { dims, data } = output;
  if (
    !Array.isArray(dims) ||
    dims.length !== 2 ||
    dims[0] !== 1 ||
    dims[1] !== pinnedAtlasExperienceProfile.dimensions ||
    !(data instanceof Float32Array) ||
    data.length !== pinnedAtlasExperienceProfile.dimensions
  )
    return undefined;
  const vector = Array.from(data);
  const magnitude = Math.sqrt(
    vector.reduce((total, component) => total + component * component, 0),
  );
  return vector.every((component) => Number.isFinite(component)) &&
    magnitude >= 0.98 &&
    magnitude <= 1.02
    ? vector
    : undefined;
}

/** Server-owned CPU inference; no provider credential or outbound text request. */
export class HuggingFaceExperienceEmbedding implements ExperienceEmbedding {
  readonly #options: HuggingFaceExperienceEmbeddingOptions;
  #extractor: Promise<FeatureExtractor> | undefined;

  constructor(options: HuggingFaceExperienceEmbeddingOptions) {
    this.#options = options;
  }

  async embed(
    input: Parameters<ExperienceEmbedding['embed']>[0],
  ): ReturnType<ExperienceEmbedding['embed']> {
    if (
      input.modelId !== pinnedAtlasExperienceProfile.modelId ||
      input.modelVersion !== pinnedAtlasExperienceProfile.modelVersion ||
      input.dimensions !== pinnedAtlasExperienceProfile.dimensions ||
      typeof input.text !== 'string'
    )
      return { kind: 'Unavailable' };
    const text = input.text.normalize('NFC');
    const length = Buffer.byteLength(text, 'utf8');
    if (length === 0 || length > 8192) return { kind: 'Unavailable' };
    try {
      this.#extractor ??=
        this.#options.load === undefined
          ? loadPinnedModel(this.#options.cacheDirectory ?? '')
          : this.#options.load();
      const output = await (await this.#extractor)(text);
      const vector = vectorFromModel(output);
      return vector === undefined
        ? { kind: 'Unavailable' }
        : { kind: 'Embedded', vector, chargedMicroUsd: 0 };
    } catch {
      this.#extractor = undefined;
      return { kind: 'Unavailable' };
    }
  }
}
