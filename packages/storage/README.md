# Storage adapter package

Owns MongoDB persistence and Atlas Vector Search adapters. It stores and
retrieves domain facts but does not decide authorization, evaluation,
promotion, or semantic correctness.

MongoDB stores durable Task, Run, evidence, checkpoint, and Harness Revision
facts. XState snapshots and Pi Agent Session state remain runtime material;
embeddings and summaries remain derived views with raw-evidence references.

The disposable E0 contract tests deliberately keep their probe documents
private. `just test-integration` runs ordinary driver behavior against Compose
MongoDB. `just test-atlas-integration` queries the pinned Atlas Local service
and is the separate proof for real Vector Search.
