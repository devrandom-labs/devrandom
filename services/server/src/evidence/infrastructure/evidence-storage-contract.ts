export const evidenceCollectionNames = Object.freeze({
  streams: 'evidenceStreams',
  artifacts: 'artifacts',
  batches: 'evidenceBatches',
  events: 'evidenceEvents',
  checkpoints: 'checkpoints',
  usage: 'evidenceResourceUsage',
});

export type EvidenceCollectionName =
  (typeof evidenceCollectionNames)[keyof typeof evidenceCollectionNames];

export const evidenceCollectionContracts = Object.freeze([
  { name: evidenceCollectionNames.streams },
  { name: evidenceCollectionNames.artifacts },
  { name: evidenceCollectionNames.batches },
  { name: evidenceCollectionNames.events },
  { name: evidenceCollectionNames.checkpoints },
  { name: evidenceCollectionNames.usage },
] as const);

export const evidenceIndexDefinitions = Object.freeze([
  {
    collection: evidenceCollectionNames.streams,
    name: 'evidence-stream-binding-run-incarnation-unique',
    key: { 'binding.runId': 1, 'binding.incarnationId': 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.artifacts,
    name: 'evidence-artifact-run-content-unique',
    key: { runId: 1, 'artifact.d': 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.batches,
    name: 'evidence-batch-stream-start-unique',
    key: { evidenceStreamId: 1, startingSequence: 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.events,
    name: 'evidence-event-stream-sequence-unique',
    key: { evidenceStreamId: 1, sequence: 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.checkpoints,
    name: 'checkpoint-run',
    key: { runId: 1 },
  },
] as const);

/** Exact stream index deployed before the per-Run evidence repair. */
export const previousEvidenceStreamRunIndex = Object.freeze({
  collection: evidenceCollectionNames.streams,
  name: 'evidence-stream-run-unique',
  key: { runId: 1 },
  unique: true,
});

/** Exact v2 single-incarnation indexes replaced atomically at storage bootstrap. */
export const previousSingleIncarnationIndexes = Object.freeze([
  {
    collection: evidenceCollectionNames.streams,
    name: 'evidence-stream-binding-run-unique',
    key: { 'binding.runId': 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.batches,
    name: 'evidence-batch-run-start-unique',
    key: { runId: 1, startingSequence: 1 },
    unique: true,
  },
  {
    collection: evidenceCollectionNames.events,
    name: 'evidence-event-run-sequence-unique',
    key: { runId: 1, sequence: 1 },
    unique: true,
  },
] as const);

export const evidenceUsageDocumentId = 'evidence-usage/1' as const;
