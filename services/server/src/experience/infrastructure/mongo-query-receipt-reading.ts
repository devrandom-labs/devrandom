import { isDeepStrictEqual } from 'node:util';

import { Binary, type Collection, type Db } from 'mongodb';

import { assessSourceExposure } from '@devrandom/domain';
import { decodeEvaluationSourceInventory, decodeEvidenceArtifact } from '@devrandom/protocol';

import type { RawEvidenceReading } from '../../evidence/application/read-evidence.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import type { ExperienceQueryReceiptReading } from '../application/read-query-receipt.js';
import {
  type AtlasExperienceProfile,
  type ExperienceEpisodeDocument,
  type ExperienceQueryReceiptDocument,
  experienceCollectionNames,
} from './mongo-atlas-experience.js';

interface ReceiptSource {
  readonly episodeSaid: string;
  readonly rawEvidenceSaid: string;
  readonly score: number;
}

interface ReceiptContent {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly sourceInventorySaid: string;
  readonly corpusSaid: string;
  readonly failureQuery: string;
  readonly sources: readonly ReceiptSource[];
  readonly chargedMicroUsd: number;
  readonly indexName: string;
  readonly modelId: string;
  readonly modelVersion: string;
}

interface ReceiptContentCandidate {
  readonly ownerAid?: unknown;
  readonly taskId?: unknown;
  readonly sourceInventorySaid?: unknown;
  readonly corpusSaid?: unknown;
  readonly failureQuery?: unknown;
  readonly sources?: unknown;
  readonly chargedMicroUsd?: unknown;
  readonly indexName?: unknown;
  readonly modelId?: unknown;
  readonly modelVersion?: unknown;
}

interface ReceiptSourceCandidate {
  readonly episodeSaid?: unknown;
  readonly rawEvidenceSaid?: unknown;
  readonly score?: unknown;
}

function receiptContent(input: unknown): input is ReceiptContent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const value = input as ReceiptContentCandidate;
  if (
    Object.keys(value).length !== 10 ||
    typeof value.ownerAid !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.sourceInventorySaid !== 'string' ||
    typeof value.corpusSaid !== 'string' ||
    typeof value.failureQuery !== 'string' ||
    value.failureQuery.length < 1 ||
    value.failureQuery.length > 1024 ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > 3 ||
    !Number.isSafeInteger(value.chargedMicroUsd) ||
    typeof value.indexName !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.modelVersion !== 'string'
  )
    return false;
  const episodes = new Set<string>();
  for (const source of value.sources) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return false;
    const entry = source as ReceiptSourceCandidate;
    if (
      Object.keys(entry).length !== 3 ||
      typeof entry.episodeSaid !== 'string' ||
      typeof entry.rawEvidenceSaid !== 'string' ||
      typeof entry.score !== 'number' ||
      !Number.isFinite(entry.score) ||
      entry.score < 0 ||
      episodes.has(entry.episodeSaid)
    )
      return false;
    episodes.add(entry.episodeSaid);
  }
  return true;
}

/** Exact query-receipt drill-down; a receipt loses read authority with its sources. */
export class MongoExperienceQueryReceipts implements ExperienceQueryReceiptReading {
  readonly #receipts: Collection<ExperienceQueryReceiptDocument>;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #episodes: Collection<ExperienceEpisodeDocument>;
  readonly #reading: RawEvidenceReading;
  readonly #profile: AtlasExperienceProfile;

  constructor(
    database: Db,
    dependencies: {
      readonly reading: RawEvidenceReading;
      readonly profile: AtlasExperienceProfile;
      readonly preparationsDatabase: Db;
    },
  ) {
    this.#receipts = database.collection(experienceCollectionNames.queryReceipts);
    this.#preparations = dependencies.preparationsDatabase.collection(
      evaluationCollectionNames.preparations,
    );
    this.#episodes = database.collection(experienceCollectionNames.episodes);
    this.#reading = dependencies.reading;
    this.#profile = dependencies.profile;
  }

  async read(
    input: Parameters<ExperienceQueryReceiptReading['read']>[0],
  ): ReturnType<ExperienceQueryReceiptReading['read']> {
    const { ownerAid, taskId, sourceInventorySaid, receiptSaid, scope } = input;
    try {
      const prepared = await this.#preparations.findOne({
        ownerAid,
        'sourceInventory.d': sourceInventorySaid,
      });
      if (prepared === null) return { kind: 'Denied' };
      const inventory = prepared.sourceInventory;
      if (
        decodeEvaluationSourceInventory(inventory).kind !== 'Accepted' ||
        inventory.d !== sourceInventorySaid ||
        inventory.ownerAid !== ownerAid ||
        inventory.taskId !== taskId ||
        inventory.taskRevisionSaid !== scope.taskRevisionSaid ||
        inventory.repositoryResourceSaid !== scope.repositoryResourceSaid ||
        inventory.corpusSaid !== scope.allowedCorpusSaid ||
        scope.ownerAid !== ownerAid ||
        scope.taskId !== taskId ||
        scope.mandate.kind !== 'AuthorizedExperience' ||
        inventory.experienceMandateSaid !== scope.mandate.mandateSaid
      )
        return { kind: 'Denied' };
      const receipt = await this.#receipts.findOne({
        _id: receiptSaid,
        ownerAid,
        sourceInventorySaid,
      });
      if (receipt === null || !(receipt.bytes instanceof Binary)) return { kind: 'Denied' };
      const bytes = Uint8Array.from(receipt.bytes.buffer);
      if (bytes.byteLength > 32 * 1024 || receipt._id !== receiptSaid) return { kind: 'Denied' };
      const decodedArtifact = decodeEvidenceArtifact(receipt.artifact, bytes);
      if (
        decodedArtifact.kind !== 'Accepted' ||
        decodedArtifact.artifact.d !== receiptSaid ||
        decodedArtifact.artifact.mediaType !== 'application/json'
      )
        return { kind: 'Denied' };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const decoded: unknown = JSON.parse(text);
      if (!receiptContent(decoded)) return { kind: 'Denied' };
      if (
        text !== JSON.stringify(decoded) ||
        receipt.ownerAid !== ownerAid ||
        receipt.taskId !== taskId ||
        receipt.taskRevisionSaid !== inventory.taskRevisionSaid ||
        receipt.repositoryResourceSaid !== inventory.repositoryResourceSaid ||
        receipt.corpusSaid !== inventory.corpusSaid ||
        receipt.sourceInventorySaid !== sourceInventorySaid ||
        receipt.indexName !== this.#profile.indexName ||
        receipt.modelId !== this.#profile.modelId ||
        receipt.modelVersion !== this.#profile.modelVersion ||
        receipt.query !== decoded.failureQuery ||
        !isDeepStrictEqual(receipt.sources, decoded.sources) ||
        receipt.chargedMicroUsd !== decoded.chargedMicroUsd ||
        decoded.ownerAid !== ownerAid ||
        decoded.taskId !== taskId ||
        decoded.sourceInventorySaid !== sourceInventorySaid ||
        decoded.corpusSaid !== inventory.corpusSaid ||
        decoded.indexName !== this.#profile.indexName ||
        decoded.modelId !== this.#profile.modelId ||
        decoded.modelVersion !== this.#profile.modelVersion ||
        decoded.chargedMicroUsd < 0 ||
        decoded.chargedMicroUsd > this.#profile.maximumEmbeddingChargeMicroUsd
      )
        return { kind: 'Denied' };
      for (const result of decoded.sources) {
        const source = inventory.sources.find(
          (candidate) =>
            candidate.episodeSaid === result.episodeSaid &&
            candidate.rawEvidenceSaid === result.rawEvidenceSaid,
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
          return { kind: 'Denied' };
        const episode = await this.#episodes.findOne({ _id: source.episodeSaid, ownerAid });
        if (
          episode === null ||
          episode.episodeSaid !== source.episodeSaid ||
          episode.rawEvidenceSaid !== source.rawEvidenceSaid ||
          episode.ownerAid !== ownerAid ||
          episode.repositoryResourceSaid !== inventory.repositoryResourceSaid ||
          episode.corpusSaid !== inventory.corpusSaid ||
          episode.disclosure !== 'AuthorizedAnalogy' ||
          episode.sourceInventorySaid !== sourceInventorySaid ||
          episode.embeddingModelId !== this.#profile.modelId ||
          episode.embeddingModelVersion !== this.#profile.modelVersion ||
          !Array.isArray(episode.embedding) ||
          episode.embedding.length !== this.#profile.dimensions ||
          !episode.embedding.every(
            (component) =>
              typeof component === 'number' &&
              Number.isFinite(component) &&
              Math.abs(component) <= 1_000_000,
          )
        )
          return { kind: 'Denied' };
        const raw = await this.#reading.read({
          ownerAid,
          scope,
          query: {
            version: 1,
            taskId,
            sourceInventorySaid,
            evidenceSaid: source.rawEvidenceSaid,
            offset: 0,
            maximumBytes: 1,
          },
        });
        if (raw.kind === 'Unavailable') return { kind: 'Unavailable' };
        if (
          raw.kind !== 'Read' ||
          raw.sourceSaid !== source.episodeSaid ||
          !Number.isSafeInteger(raw.totalBytes) ||
          raw.totalBytes < 1 ||
          raw.bytes.byteLength !== 1
        )
          return { kind: 'Denied' };
      }
      if (input.offset > bytes.byteLength) return { kind: 'Denied' };
      return {
        kind: 'Read',
        artifact: receipt.artifact,
        bytes: bytes.slice(input.offset, input.offset + input.maximumBytes),
        totalBytes: bytes.byteLength,
        offset: input.offset,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
