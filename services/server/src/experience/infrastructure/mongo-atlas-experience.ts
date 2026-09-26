import { isDeepStrictEqual } from 'node:util';

import { Binary, type Collection, type Db, type Document } from 'mongodb';

import { assessSourceExposure } from '@devrandom/domain';
import {
  decodeEvaluationSourceInventory,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';

import type { RawEvidenceReading } from '../../evidence/application/read-evidence.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import type {
  AnalogousExperience,
  ExperienceRetrievalOutcome,
} from '../application/retrieve-experience.js';

export const experienceCollectionNames = Object.freeze({
  episodes: 'experienceEpisodes',
  queryReceipts: 'experienceQueryReceipts',
});

export interface ExperienceEmbedding {
  embed(input: {
    readonly text: string;
    readonly modelId: string;
    readonly modelVersion: string;
    readonly dimensions: number;
  }): Promise<
    | {
        readonly kind: 'Embedded';
        readonly vector: readonly number[];
        readonly chargedMicroUsd: number;
      }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface AtlasExperienceProfile {
  readonly indexName: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly minimumScore: number;
  readonly maximumEmbeddingChargeMicroUsd: number;
}

export interface ExperienceEpisodeDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly repositoryResourceSaid: string;
  readonly corpusSaid: string;
  readonly disclosure: string;
  readonly episodeSaid: string;
  readonly rawEvidenceSaid: string;
  readonly sourceInventorySaid: string;
  readonly embeddingModelId: string;
  readonly embeddingModelVersion: string;
  readonly embedding: readonly number[];
  readonly acceptedAt: Date;
}

interface SearchIndexStatus {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly queryable?: unknown;
  readonly latestDefinition?: unknown;
  readonly latestDefinitionVersion?: { readonly version?: unknown };
  readonly statusDetail?: readonly {
    readonly status?: unknown;
    readonly queryable?: unknown;
    readonly mainIndex?: {
      readonly status?: unknown;
      readonly queryable?: unknown;
      readonly definitionVersion?: { readonly version?: unknown };
      readonly definition?: unknown;
    };
    readonly stagedIndex?: unknown;
  }[];
}

interface VectorMatch {
  readonly episodeSaid: string;
  readonly rawEvidenceSaid: string;
  readonly score: number;
}

export interface ExperienceQueryReceiptDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly repositoryResourceSaid: string;
  readonly corpusSaid: string;
  readonly query: string;
  readonly sourceInventorySaid: string;
  readonly sources: readonly VectorMatch[];
  readonly chargedMicroUsd: number;
  readonly indexName: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Binary;
  readonly acceptedAt: Date;
}

export function experienceIndexDefinition(dimensions: number) {
  return {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: dimensions, similarity: 'cosine' },
      { type: 'filter', path: 'ownerAid' },
      { type: 'filter', path: 'repositoryResourceSaid' },
      { type: 'filter', path: 'corpusSaid' },
      { type: 'filter', path: 'disclosure' },
      { type: 'filter', path: 'episodeSaid' },
      { type: 'filter', path: 'embeddingModelId' },
      { type: 'filter', path: 'embeddingModelVersion' },
    ],
  } as const;
}

export function exactExperiencePipeline(input: {
  readonly profile: AtlasExperienceProfile;
  readonly ownerAid: string;
  readonly repositoryResourceSaid: string;
  readonly corpusSaid: string;
  readonly episodeSaids: readonly string[];
  readonly vector: readonly number[];
}) {
  return [
    {
      $vectorSearch: {
        index: input.profile.indexName,
        path: 'embedding',
        queryVector: [...input.vector],
        exact: true,
        filter: {
          $and: [
            { ownerAid: { $eq: input.ownerAid } },
            { repositoryResourceSaid: { $eq: input.repositoryResourceSaid } },
            { corpusSaid: { $eq: input.corpusSaid } },
            { disclosure: { $eq: 'AuthorizedAnalogy' } },
            { episodeSaid: { $in: [...input.episodeSaids] } },
            { embeddingModelId: { $eq: input.profile.modelId } },
            { embeddingModelVersion: { $eq: input.profile.modelVersion } },
          ],
        },
        limit: 3,
      },
    },
    {
      $project: {
        _id: 0,
        episodeSaid: 1,
        rawEvidenceSaid: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ] as const;
}

function vectorValid(vector: readonly number[], dimensions: number): boolean {
  return (
    vector.length === dimensions &&
    vector.every((component) => Number.isFinite(component) && Math.abs(component) <= 1_000_000)
  );
}

/** Atlas ENN for approved analogous episodes; raw provenance remains in Evidence. */
export class MongoAtlasExperience implements AnalogousExperience {
  readonly #episodes: Collection<ExperienceEpisodeDocument>;
  readonly #receipts: Collection<ExperienceQueryReceiptDocument>;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #embedding: ExperienceEmbedding;
  readonly #profile: AtlasExperienceProfile;
  readonly #reading: RawEvidenceReading;

  constructor(
    database: Db,
    dependencies: {
      readonly embedding: ExperienceEmbedding;
      readonly profile: AtlasExperienceProfile;
      readonly reading: RawEvidenceReading;
    },
  ) {
    this.#episodes = database.collection(experienceCollectionNames.episodes);
    this.#receipts = database.collection(experienceCollectionNames.queryReceipts);
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#embedding = dependencies.embedding;
    this.#profile = dependencies.profile;
    this.#reading = dependencies.reading;
  }

  async ensureIndex(): Promise<'Created' | 'Ready' | 'IndexNotReady' | 'Unavailable'> {
    try {
      const [existing] = await this.#episodes.listSearchIndexes(this.#profile.indexName).toArray();
      if (existing === undefined) {
        await this.#episodes.createSearchIndex({
          name: this.#profile.indexName,
          type: 'vectorSearch',
          definition: experienceIndexDefinition(this.#profile.dimensions),
        });
        return 'Created';
      }
      return this.#indexReady(existing) ? 'Ready' : 'IndexNotReady';
    } catch {
      return 'Unavailable';
    }
  }

  #indexReady(index: SearchIndexStatus): boolean {
    const definition = experienceIndexDefinition(this.#profile.dimensions);
    const version = index.latestDefinitionVersion?.version;
    const hostDetails = Array.isArray(index.statusDetail)
      ? (index.statusDetail as NonNullable<SearchIndexStatus['statusDetail']>)
      : undefined;
    return (
      index.name === this.#profile.indexName &&
      index.type === 'vectorSearch' &&
      index.status === 'READY' &&
      index.queryable === true &&
      isDeepStrictEqual(index.latestDefinition, definition) &&
      Number.isSafeInteger(version) &&
      typeof version === 'number' &&
      version >= 0 &&
      hostDetails !== undefined &&
      hostDetails.length > 0 &&
      hostDetails.every(
        (host) =>
          host.status === 'READY' &&
          host.queryable === true &&
          host.stagedIndex === undefined &&
          host.mainIndex?.status === 'READY' &&
          host.mainIndex.queryable === true &&
          host.mainIndex.definitionVersion?.version === version &&
          isDeepStrictEqual(host.mainIndex.definition, definition),
      )
    );
  }

  async admitSource(input: {
    readonly ownerAid: string;
    readonly inventory: EvaluationSourceInventory;
    readonly episodeSaid: string;
    readonly rawEvidenceSaid: string;
    readonly scope: Parameters<RawEvidenceReading['read']>[0]['scope'];
  }): Promise<'Admitted' | 'AlreadyAdmitted' | 'Denied' | 'Unavailable'> {
    const { ownerAid, inventory, scope } = input;
    if (
      decodeEvaluationSourceInventory(inventory).kind !== 'Accepted' ||
      inventory.ownerAid !== ownerAid ||
      scope.ownerAid !== ownerAid ||
      scope.taskId !== inventory.taskId ||
      scope.taskRevisionSaid !== inventory.taskRevisionSaid ||
      scope.repositoryResourceSaid !== inventory.repositoryResourceSaid ||
      scope.allowedCorpusSaid !== inventory.corpusSaid ||
      scope.mandate.kind !== 'AuthorizedExperience' ||
      scope.mandate.mandateSaid !== inventory.experienceMandateSaid
    )
      return 'Denied';
    const source = inventory.sources.find(
      (candidate) =>
        candidate.episodeSaid === input.episodeSaid &&
        candidate.rawEvidenceSaid === input.rawEvidenceSaid,
    );
    if (
      source === undefined ||
      assessSourceExposure(scope, {
        kind: 'AnalogousEpisode',
        ownerAid: source.ownerAid,
        repositoryResourceSaid: source.repositoryResourceSaid,
        corpusSaid: source.corpusSaid,
        rawEvidenceSaid: source.rawEvidenceSaid,
        disclosure: source.disclosure,
      }).kind !== 'Allowed'
    )
      return 'Denied';
    const raw = await this.#reading.read({
      ownerAid,
      scope,
      query: {
        version: 1,
        taskId: inventory.taskId,
        sourceInventorySaid: inventory.d,
        evidenceSaid: source.rawEvidenceSaid,
        offset: 0,
        maximumBytes: 32 * 1024,
      },
    });
    if (
      raw.kind !== 'Read' ||
      raw.sourceSaid !== source.episodeSaid ||
      raw.totalBytes !== raw.bytes.byteLength
    )
      return 'Denied';
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes).normalize('NFC');
    } catch {
      return 'Denied';
    }
    if (text.length === 0 || text.length > 32 * 1024) return 'Denied';
    const embedded = await this.#embedding.embed({
      text,
      modelId: this.#profile.modelId,
      modelVersion: this.#profile.modelVersion,
      dimensions: this.#profile.dimensions,
    });
    if (
      embedded.kind !== 'Embedded' ||
      !vectorValid(embedded.vector, this.#profile.dimensions) ||
      !Number.isSafeInteger(embedded.chargedMicroUsd) ||
      embedded.chargedMicroUsd < 0 ||
      embedded.chargedMicroUsd > this.#profile.maximumEmbeddingChargeMicroUsd
    )
      return 'Unavailable';
    const document: ExperienceEpisodeDocument = {
      _id: source.episodeSaid,
      ownerAid,
      repositoryResourceSaid: source.repositoryResourceSaid,
      corpusSaid: source.corpusSaid,
      disclosure: 'AuthorizedAnalogy',
      episodeSaid: source.episodeSaid,
      rawEvidenceSaid: source.rawEvidenceSaid,
      sourceInventorySaid: inventory.d,
      embeddingModelId: this.#profile.modelId,
      embeddingModelVersion: this.#profile.modelVersion,
      embedding: [...embedded.vector],
      acceptedAt: new Date(),
    };
    try {
      const previous = await this.#episodes.findOne({ _id: document._id });
      if (previous !== null)
        return previous.ownerAid === ownerAid &&
          previous.episodeSaid === source.episodeSaid &&
          previous.rawEvidenceSaid === source.rawEvidenceSaid &&
          previous.repositoryResourceSaid === source.repositoryResourceSaid &&
          previous.corpusSaid === source.corpusSaid &&
          previous.disclosure === 'AuthorizedAnalogy' &&
          previous.sourceInventorySaid === inventory.d &&
          previous.embeddingModelId === this.#profile.modelId &&
          previous.embeddingModelVersion === this.#profile.modelVersion &&
          vectorValid(previous.embedding, this.#profile.dimensions)
          ? 'AlreadyAdmitted'
          : 'Denied';
      await this.#episodes.insertOne(document);
      return 'Admitted';
    } catch {
      return 'Unavailable';
    }
  }

  async retrieve(
    input: Parameters<AnalogousExperience['retrieve']>[0],
  ): Promise<ExperienceRetrievalOutcome> {
    const { ownerAid, query, scope } = input;
    try {
      const prepared = await this.#preparations.findOne({
        ownerAid,
        'sourceInventory.d': query.sourceInventorySaid,
      });
      if (prepared === null) return { kind: 'Denied' };
      const inventory = prepared.sourceInventory;
      if (
        decodeEvaluationSourceInventory(inventory).kind !== 'Accepted' ||
        query.taskId !== inventory.taskId ||
        query.corpusSaid !== inventory.corpusSaid ||
        scope.ownerAid !== ownerAid ||
        scope.taskId !== query.taskId ||
        scope.taskRevisionSaid !== inventory.taskRevisionSaid ||
        scope.repositoryResourceSaid !== inventory.repositoryResourceSaid ||
        scope.allowedCorpusSaid !== inventory.corpusSaid ||
        scope.mandate.kind !== 'AuthorizedExperience' ||
        scope.mandate.mandateSaid !== inventory.experienceMandateSaid
      )
        return { kind: 'Denied' };
      const [index] = await this.#episodes.listSearchIndexes(this.#profile.indexName).toArray();
      if (index === undefined || !this.#indexReady(index)) return { kind: 'IndexNotReady' };
      const embedded = await this.#embedding.embed({
        text: query.failureQuery.normalize('NFC'),
        modelId: this.#profile.modelId,
        modelVersion: this.#profile.modelVersion,
        dimensions: this.#profile.dimensions,
      });
      if (
        embedded.kind !== 'Embedded' ||
        !vectorValid(embedded.vector, this.#profile.dimensions) ||
        !Number.isSafeInteger(embedded.chargedMicroUsd) ||
        embedded.chargedMicroUsd < 0 ||
        embedded.chargedMicroUsd > this.#profile.maximumEmbeddingChargeMicroUsd
      )
        return { kind: 'Unavailable' };
      const matches = await this.#episodes
        .aggregate<VectorMatch>(
          exactExperiencePipeline({
            profile: this.#profile,
            ownerAid,
            repositoryResourceSaid: inventory.repositoryResourceSaid,
            corpusSaid: inventory.corpusSaid,
            episodeSaids: inventory.sources.map((source) => source.episodeSaid),
            vector: embedded.vector,
          }) as unknown as Document[],
        )
        .toArray();
      const sources: VectorMatch[] = [];
      for (const match of matches) {
        const allowed = inventory.sources.find(
          (source) =>
            source.episodeSaid === match.episodeSaid &&
            source.rawEvidenceSaid === match.rawEvidenceSaid,
        );
        if (allowed === undefined) return { kind: 'Denied' };
        if (!Number.isFinite(match.score) || match.score < this.#profile.minimumScore) continue;
        const raw = await this.#reading.read({
          ownerAid,
          scope,
          query: {
            version: 1,
            taskId: inventory.taskId,
            sourceInventorySaid: inventory.d,
            evidenceSaid: match.rawEvidenceSaid,
            offset: 0,
            maximumBytes: 1,
          },
        });
        if (raw.kind === 'Unavailable') return { kind: 'Unavailable' };
        if (raw.kind !== 'Read' || raw.sourceSaid !== match.episodeSaid || raw.totalBytes < 1)
          return { kind: 'Denied' };
        sources.push(match);
      }
      if (sources.length === 0) return { kind: 'Irrelevant' };
      const receiptBytes = new TextEncoder().encode(
        JSON.stringify({
          ownerAid,
          taskId: query.taskId,
          sourceInventorySaid: query.sourceInventorySaid,
          corpusSaid: query.corpusSaid,
          failureQuery: query.failureQuery,
          sources,
          chargedMicroUsd: embedded.chargedMicroUsd,
          indexName: this.#profile.indexName,
          modelId: this.#profile.modelId,
          modelVersion: this.#profile.modelVersion,
        }),
      );
      const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
      if (receipt.kind !== 'Prepared') return { kind: 'Unavailable' };
      await this.#receipts.insertOne({
        _id: receipt.artifact.d,
        ownerAid,
        taskId: query.taskId,
        taskRevisionSaid: inventory.taskRevisionSaid,
        repositoryResourceSaid: inventory.repositoryResourceSaid,
        corpusSaid: inventory.corpusSaid,
        query: query.failureQuery,
        sourceInventorySaid: query.sourceInventorySaid,
        sources,
        chargedMicroUsd: embedded.chargedMicroUsd,
        indexName: this.#profile.indexName,
        modelId: this.#profile.modelId,
        modelVersion: this.#profile.modelVersion,
        artifact: receipt.artifact,
        bytes: new Binary(Uint8Array.from(receiptBytes)),
        acceptedAt: new Date(),
      });
      return {
        kind: 'Retrieved',
        sources,
        queryReceiptSaid: receipt.artifact.d,
        chargedMicroUsd: embedded.chargedMicroUsd,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
