import { describe, expect, it } from 'vitest';

import {
  evidenceCollectionContracts,
  evidenceIndexDefinitions,
} from './evidence-storage-contract.js';
import {
  evidenceArtifactCollectionValidator,
  evidenceBatchCollectionValidator,
  evidenceCheckpointCollectionValidator,
  evidenceEventCollectionValidator,
  evidenceStreamCollectionValidator,
  evidenceUsageCollectionValidator,
} from './mongo-evidence-bootstrap.js';

describe('Mongo Evidence bootstrap contract', () => {
  it('declares the exact collections and named indexes for immutable content and ordered streams', () => {
    expect(evidenceCollectionContracts.map((contract) => contract.name)).toEqual([
      'evidenceStreams',
      'artifacts',
      'evidenceBatches',
      'evidenceEvents',
      'checkpoints',
      'evidenceResourceUsage',
    ]);
    expect(evidenceIndexDefinitions).toEqual([
      {
        collection: 'evidenceStreams',
        name: 'evidence-stream-binding-run-incarnation-unique',
        key: { 'binding.runId': 1, 'binding.incarnationId': 1 },
        unique: true,
      },
      {
        collection: 'artifacts',
        name: 'evidence-artifact-run-content-unique',
        key: { runId: 1, 'artifact.d': 1 },
        unique: true,
      },
      {
        collection: 'evidenceBatches',
        name: 'evidence-batch-stream-start-unique',
        key: { evidenceStreamId: 1, startingSequence: 1 },
        unique: true,
      },
      {
        collection: 'evidenceEvents',
        name: 'evidence-event-stream-sequence-unique',
        key: { evidenceStreamId: 1, sequence: 1 },
        unique: true,
      },
      {
        collection: 'checkpoints',
        name: 'checkpoint-run',
        key: { runId: 1 },
      },
    ]);
  });

  it('uses closed strict validators including BSON binary artifact bytes', () => {
    for (const validator of [
      evidenceStreamCollectionValidator,
      evidenceArtifactCollectionValidator,
      evidenceBatchCollectionValidator,
      evidenceEventCollectionValidator,
      evidenceCheckpointCollectionValidator,
      evidenceUsageCollectionValidator,
    ]) {
      expect(validator.$jsonSchema).toMatchObject({
        bsonType: 'object',
        additionalProperties: false,
      });
    }
    expect(evidenceArtifactCollectionValidator).toMatchObject({
      $jsonSchema: {
        properties: { bytes: { bsonType: 'binData' }, acceptedAt: { bsonType: 'date' } },
      },
    });
  });
});
