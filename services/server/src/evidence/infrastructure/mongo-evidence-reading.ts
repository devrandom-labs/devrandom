import type { Collection, Db } from 'mongodb';

import { assessSourceExposure } from '@devrandom/domain';
import {
  decodeEvaluationSourceInventory,
  evidenceArtifactReferences,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import type { RawEvidenceReading } from '../application/read-evidence.js';
import {
  decodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';

/** Deterministic raw drill-down; inventory, episode, event and bytes must all agree. */
export class MongoEvidenceReading implements RawEvidenceReading {
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;

  constructor(database: Db) {
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#events = database.collection(evidenceCollectionNames.events);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
  }

  async read(input: Parameters<RawEvidenceReading['read']>[0]) {
    const { query, ownerAid, scope } = input;
    try {
      const prepared = await this.#preparations.findOne({
        ownerAid,
        'sourceInventory.d': query.sourceInventorySaid,
      });
      if (prepared === null) return { kind: 'Denied' } as const;
      const inventory = prepared.sourceInventory;
      if (
        decodeEvaluationSourceInventory(inventory).kind !== 'Accepted' ||
        inventory.ownerAid !== ownerAid ||
        inventory.taskId !== query.taskId ||
        inventory.taskRevisionSaid !== scope.taskRevisionSaid ||
        inventory.repositoryResourceSaid !== scope.repositoryResourceSaid ||
        inventory.corpusSaid !== scope.allowedCorpusSaid ||
        scope.mandate.kind !== 'AuthorizedExperience' ||
        inventory.experienceMandateSaid !== scope.mandate.mandateSaid
      )
        return { kind: 'Denied' } as const;
      const source = inventory.sources.find(
        (candidate) => candidate.rawEvidenceSaid === query.evidenceSaid,
      );
      if (source === undefined) return { kind: 'NotFound' } as const;
      if (
        assessSourceExposure(scope, {
          kind: 'AnalogousEpisode',
          ownerAid: source.ownerAid,
          repositoryResourceSaid: source.repositoryResourceSaid,
          corpusSaid: source.corpusSaid,
          rawEvidenceSaid: source.rawEvidenceSaid,
          disclosure: source.disclosure,
        }).kind !== 'Allowed'
      )
        return { kind: 'Denied' } as const;
      const episodeDocument = await this.#events.findOne({ _id: source.episodeSaid, ownerAid });
      if (episodeDocument === null) return { kind: 'NotFound' } as const;
      const episode = decodeEvidenceEventDocument(episodeDocument);
      if (!evidenceArtifactReferences(episode.event.event).includes(query.evidenceSaid))
        return { kind: 'Denied' } as const;
      const rawDocument = await this.#artifacts.findOne({
        _id: evidenceArtifactDocumentId(episode.event.runId, query.evidenceSaid),
        ownerAid,
        runId: episode.event.runId,
        evidenceStreamId: episodeDocument.evidenceStreamId,
      });
      if (rawDocument === null) return { kind: 'NotFound' } as const;
      const raw = decodeEvidenceArtifactDocument(rawDocument);
      if (query.offset > raw.bytes.byteLength) return { kind: 'NotFound' } as const;
      const bytes = raw.bytes.slice(query.offset, query.offset + query.maximumBytes);
      const receiptBytes = new TextEncoder().encode(
        JSON.stringify({
          ownerAid,
          taskId: query.taskId,
          sourceInventorySaid: query.sourceInventorySaid,
          episodeSaid: source.episodeSaid,
          evidenceSaid: query.evidenceSaid,
          offset: query.offset,
          returnedBytes: bytes.byteLength,
          totalBytes: raw.bytes.byteLength,
        }),
      );
      const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
      if (receipt.kind !== 'Prepared') return { kind: 'Unavailable' } as const;
      return {
        kind: 'Read',
        bytes,
        totalBytes: raw.bytes.byteLength,
        sourceSaid: source.episodeSaid,
        readReceiptSaid: receipt.artifact.d,
      } as const;
    } catch {
      return { kind: 'Unavailable' } as const;
    }
  }
}
