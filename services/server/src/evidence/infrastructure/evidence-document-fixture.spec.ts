import { Binary } from 'mongodb';
import { describe, expect, it } from 'vitest';

import {
  acceptEvidenceBatch,
  admitEvidenceArtifact,
  createEvidenceStream,
  sealEvidenceStream,
  taskBudgetCeilings,
  type EvidenceStream,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  type EvidenceArtifact,
  type EvidenceBatch,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';

import {
  decodeEvidenceArtifactDocument,
  encodeEvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import {
  decodeEvidenceBatchDocument,
  encodeEvidenceBatchDocument,
} from './evidence-batch-document.js';
import {
  decodeEvidenceCheckpointDocument,
  encodeEvidenceCheckpointDocument,
} from './evidence-checkpoint-document.js';
import {
  decodeEvidenceEventDocument,
  encodeEvidenceEventDocument,
} from './evidence-event-document.js';
import {
  decodeEvidenceStreamDocument,
  encodeEvidenceStreamDocument,
} from './evidence-stream-document.js';
import {
  decodeEvidenceUsageDocument,
  evidenceUsageInitialDocument,
} from './evidence-usage-document.js';

const ownerAid = `E${'a'.repeat(43)}`;
const personalAgentAid = `E${'b'.repeat(43)}`;
const taskRevisionSaid = `E${'c'.repeat(43)}`;
const taskMandateSaid = `E${'d'.repeat(43)}`;
const harnessRevisionSaid = `E${'e'.repeat(43)}`;
const governorAid = `E${'f'.repeat(43)}`;
const promotionMandateSaid = `E${'g'.repeat(43)}`;
const commandSaid = `E${'h'.repeat(43)}`;
const taskId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const runId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const incarnationId = 'd9cb18e4-f4f8-4378-a852-353eef083d91';
const evidenceStreamId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const harnessLineageId = 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94';
const receivedAt = '2026-09-24T20:00:05.000Z';

function zeroBudget(): TaskBudgets {
  return {
    workAccessAttemptLifetimeSeconds: 0,
    workAccessGrantLifetimeSeconds: 0,
    nonterminalAttemptsPerUserClient: 0,
    activeGrantsPerUserClient: 0,
    publicAttemptCreationsPerMinutePerLoopbackSource: 0,
    nonterminalAttemptsGlobally: 0,
    requestsPerGrant: 0,
    tasksPerAdmittedUser: 0,
    runsPerAdmittedUser: 0,
    activeRunsPerAdmittedUser: 0,
    hostedWorkTasksGlobally: 0,
    hostedWorkRunsGlobally: 0,
    activeHostedWorkRunsGlobally: 0,
    ordinaryJsonRequestBodyBytes: 0,
    evidenceBatchBodyBytes: 0,
    artifactRequestBodyBytes: 0,
    evidencePlusArtifactsPerRunBytes: 0,
    acceptedEvidencePlusArtifactsGloballyBytes: 0,
    runWallTimeSeconds: 0,
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    oneChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
    providerSpendMicroUsd: 0,
  };
}

function event(): EvidenceEvent {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId,
    taskRevisionSaid,
    runId,
    incarnationId,
    harnessRevisionSaid,
    personalAgentAid,
    taskMandateSaid,
    occurredAt: '2026-09-24T20:00:01.000Z',
    recordedAt: '2026-09-24T20:00:02.000Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: 1 },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('evidence event fixture must be valid');
  }
  return prepared.event;
}

function batch(events: readonly EvidenceEvent[]): EvidenceBatch {
  const prepared = prepareEvidenceBatch({
    version: 1,
    runId,
    evidenceStreamId,
    events: [...events],
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('evidence batch fixture must be valid');
  }
  return prepared.batch;
}

function acknowledgement(value: EvidenceBatch): EvidenceBatchAcknowledgement {
  const chainHeadSaid = value.eventSaids.at(-1);
  if (chainHeadSaid === undefined) {
    throw new Error('evidence batch fixture must have a chain head');
  }
  return {
    version: 1,
    disposition: { kind: 'Accepted' },
    runId,
    evidenceStreamId,
    batchSaid: value.d,
    acceptedThroughSequence: value.endingSequence,
    chainHeadSaid,
    receivedAt,
  };
}

function artifact(bytes: Uint8Array): EvidenceArtifact {
  const prepared = prepareEvidenceArtifact(bytes, 'application/octet-stream');
  if (prepared.kind !== 'Prepared') {
    throw new Error('evidence artifact fixture must be valid');
  }
  return prepared.artifact;
}

function checkpoint(chainHeadSaid: string): VerifiedCheckpoint {
  const receipt = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'public-tests',
    commandSaid,
    recordedAt: '2026-09-24T20:00:03.000Z',
    outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
  });
  if (receipt.kind !== 'Prepared') {
    throw new Error('verifier receipt fixture must be valid');
  }
  const prepared = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId,
      taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid,
      harnessLineageId,
      personalAgentAid,
      governorAid,
      taskMandateSaid,
      promotionMandateSaid,
      purpose: { kind: 'Retained' },
      repository: {
        objectFormat: 'sha1',
        baseCommit: '1'.repeat(40),
        baseTree: '2'.repeat(40),
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [receipt.receipt],
      evidence: { eventCount: 1, finalSequence: 0, chainHeadSaid },
      budget: { consumed: zeroBudget(), remaining: taskBudgetCeilings },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
        verification: { kind: 'NotSubmitted' },
      },
      continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
    },
    ['public-tests'],
  );
  if (prepared.kind !== 'Prepared') {
    throw new Error('checkpoint fixture must be valid');
  }
  return prepared.checkpoint;
}

function stream(): EvidenceStream {
  const created = createEvidenceStream({
    streamId: evidenceStreamId,
    runId,
    ownerAid,
    taskId,
    taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid,
    personalAgentAid,
    taskMandateSaid,
    combinedByteCeiling: 64 * 1_024 * 1_024,
  });
  if (created.kind !== 'Created') {
    throw new Error('evidence stream fixture must be valid');
  }
  const withArtifact = admitEvidenceArtifact(created.stream, { byteLength: 4 });
  if (withArtifact.kind !== 'Admitted') {
    throw new Error('artifact admission fixture must be valid');
  }
  const accepted = acceptEvidenceBatch(withArtifact.stream, {
    batchSaid: `E${'i'.repeat(43)}`,
    startingSequence: 0,
    endingSequence: 0,
    predecessor: { kind: 'Genesis' },
    eventSaids: [`E${'j'.repeat(43)}`],
    encodedBytes: 256,
    checkpoint: {
      kind: 'Present',
      checkpointSaid: `E${'k'.repeat(43)}`,
      lifecycle: {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid: `E${'k'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' },
    },
  });
  if (accepted.kind !== 'Accepted') {
    throw new Error('batch acceptance fixture must be valid');
  }
  const sealed = sealEvidenceStream(accepted.stream, {
    exchangeSaid: `E${'l'.repeat(43)}`,
    eventCount: 1,
    finalSequence: 0,
    chainHeadSaid: `E${'j'.repeat(43)}`,
    sealedAt: receivedAt,
  });
  if (sealed.kind !== 'Sealed') {
    throw new Error('stream seal fixture must be valid');
  }
  return sealed.stream;
}

describe('Mongo Evidence document codecs', () => {
  it('round-trips one domain-owned sealed Evidence Stream and rejects changed identities', () => {
    const value = stream();
    const encoded = encodeEvidenceStreamDocument(value);

    expect(decodeEvidenceStreamDocument(encoded)).toEqual(value);
    expect(() => decodeEvidenceStreamDocument({ ...encoded, _id: runId })).toThrow(
      'EvidenceStreamDocumentInvalid',
    );
    expect(() =>
      decodeEvidenceStreamDocument({
        ...encoded,
        acceptedEvidenceBytes: value.binding.combinedByteCeiling,
      }),
    ).toThrow('EvidenceStreamDocumentInvalid');
  });

  it('round-trips immutable artifact bytes and rechecks their protocol envelope', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const value = artifact(bytes);
    const encoded = encodeEvidenceArtifactDocument({
      ownerAid,
      runId,
      evidenceStreamId,
      artifact: value,
      bytes,
      acceptedAt: receivedAt,
    });

    expect(encoded.bytes).toBeInstanceOf(Binary);
    expect(encoded._id).toBe(`${runId}:${value.d}`);
    expect(decodeEvidenceArtifactDocument(encoded)).toEqual({
      ownerAid,
      runId,
      evidenceStreamId,
      artifact: value,
      bytes,
      acceptedAt: receivedAt,
    });
    expect(decodeEvidenceArtifactDocument({ ...encoded, _id: value.d })).toEqual(
      decodeEvidenceArtifactDocument(encoded),
    );
    expect(() =>
      decodeEvidenceArtifactDocument({ ...encoded, bytes: new Binary(new Uint8Array([9])) }),
    ).toThrow('EvidenceArtifactDocumentInvalid');
  });

  it('round-trips the batch acknowledgement and each immutable event independently', () => {
    const events = [event()];
    const value = batch(events);
    const accepted = acknowledgement(value);
    const encodedBatch = encodeEvidenceBatchDocument({
      ownerAid,
      commandFingerprint: `sha256:${'a'.repeat(64)}`,
      batch: value,
      events,
      acknowledgement: accepted,
    });
    const encodedEvent = encodeEvidenceEventDocument({
      ownerAid,
      evidenceStreamId,
      batchSaid: value.d,
      event: events[0] ?? event(),
      receivedAt,
    });

    expect(decodeEvidenceBatchDocument(encodedBatch, events)).toEqual({
      ownerAid,
      commandFingerprint: `sha256:${'a'.repeat(64)}`,
      batch: value,
      events,
      acknowledgement: accepted,
    });
    expect(decodeEvidenceEventDocument(encodedEvent)).toEqual({
      ownerAid,
      evidenceStreamId,
      batchSaid: value.d,
      event: events[0],
      receivedAt,
    });
    expect(() => decodeEvidenceEventDocument({ ...encodedEvent, sequence: 9 })).toThrow(
      'EvidenceEventDocumentInvalid',
    );
  });

  it('round-trips a protocol-verified checkpoint and rejects another batch binding', () => {
    const events = [event()];
    const value = checkpoint(events[0]?.d ?? `E${'m'.repeat(43)}`);
    const batchSaid = `E${'n'.repeat(43)}`;
    const encoded = encodeEvidenceCheckpointDocument(
      {
        ownerAid,
        evidenceStreamId,
        batchSaid,
        checkpoint: value,
        receivedAt,
      },
      ['public-tests'],
    );

    expect(decodeEvidenceCheckpointDocument(encoded, ['public-tests'])).toEqual({
      ownerAid,
      evidenceStreamId,
      batchSaid,
      checkpoint: value,
      receivedAt,
    });
    expect(() =>
      decodeEvidenceCheckpointDocument({ ...encoded, runId: taskId }, ['public-tests']),
    ).toThrow('EvidenceCheckpointDocumentInvalid');
  });

  it('accepts only the exact bounded global Evidence usage singleton', () => {
    expect(decodeEvidenceUsageDocument(evidenceUsageInitialDocument)).toEqual(
      evidenceUsageInitialDocument,
    );
    expect(() =>
      decodeEvidenceUsageDocument({
        ...evidenceUsageInitialDocument,
        acceptedBytes: 256 * 1_024 * 1_024 + 1,
      }),
    ).toThrow('EvidenceUsageDocumentInvalid');
  });
});
