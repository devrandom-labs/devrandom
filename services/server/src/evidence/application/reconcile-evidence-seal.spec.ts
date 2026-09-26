import { acquireFirstRunLease, acceptEvidenceBatch, createEvidenceStream } from '@devrandom/domain';
import { describe, expect, it, vi } from 'vitest';

import { runFixture } from '../../run/test/run-fixture.js';
import { reconcileEvidenceSeal } from './reconcile-evidence-seal.js';
import type { EvidenceSealContexts, EvidenceSeals } from './evidence-seals.js';

const exchangeSaid = `E${'z'.repeat(43)}`;
const checkpointSaid = `E${'c'.repeat(43)}`;
const eventSaid = `E${'v'.repeat(43)}`;
const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';

function context() {
  const acquired = acquireFirstRunLease(runFixture(), {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('expected a held Run lease');
  }
  const created = createEvidenceStream({
    streamId: acquired.run.binding.evidenceStreamId,
    runId: acquired.run.binding.runId,
    ownerAid: acquired.run.binding.ownerAid,
    taskId: acquired.run.binding.taskId,
    taskRevisionSaid: acquired.run.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: acquired.run.binding.initialHarnessRevisionSaid,
    personalAgentAid: acquired.run.binding.personalAgentAid,
    taskMandateSaid: acquired.run.binding.taskMandateSaid,
    combinedByteCeiling: acquired.run.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (created.kind !== 'Created') {
    throw new Error('expected an evidence stream');
  }
  const accepted = acceptEvidenceBatch(created.stream, {
    batchSaid: `E${'b'.repeat(43)}`,
    startingSequence: 0,
    endingSequence: 0,
    predecessor: { kind: 'Genesis' },
    eventSaids: [eventSaid],
    encodedBytes: 128,
    checkpoint: {
      kind: 'Present',
      checkpointSaid,
      lifecycle: {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' },
    },
  });
  if (accepted.kind !== 'Accepted') {
    throw new Error('expected accepted evidence');
  }
  return { run: acquired.run, stream: accepted.stream };
}

function contexts(): EvidenceSealContexts {
  return {
    inspect: vi.fn().mockResolvedValue({
      kind: 'EvidenceSealContextFound',
      ...context(),
    }),
  };
}

function seals() {
  const commit = vi.fn<EvidenceSeals['commit']>().mockResolvedValue({
    kind: 'EvidenceStreamSealed',
    stream: context().stream,
  });
  const storage: EvidenceSeals = { commit };
  return { storage, commit };
}

describe('reconcile evidence seal', () => {
  it('accepts only the exact personal-agent KERIA exchange before committing settlement', async () => {
    const { storage, commit } = seals();
    const inspect = vi.fn().mockResolvedValue({ kind: 'Verified', exchangeSaid });
    const found = context();

    await reconcileEvidenceSeal(
      {
        ownerAid: found.run.binding.ownerAid,
        runId: found.run.binding.runId,
        sealExchangeSaid: exchangeSaid,
        observedAt: '2026-09-24T20:01:00.000Z',
      },
      {
        issuerAid: `E${'i'.repeat(43)}`,
        contexts: contexts(),
        exchanges: { inspect },
        seals: storage,
      },
    );

    expect(inspect).toHaveBeenCalledWith({
      exchangeSaid,
      sourceAid: found.run.binding.personalAgentAid,
      recipientAid: `E${'i'.repeat(43)}`,
      payload: {
        version: 1,
        kind: 'EvidenceStreamSeal',
        runId: found.run.binding.runId,
        evidenceStreamId: found.run.binding.evidenceStreamId,
        eventCount: 1,
        finalSequence: 0,
        chainHeadSaid: eventSaid,
        harnessRevisionSaid: found.run.binding.initialHarnessRevisionSaid,
        taskMandateSaid: found.run.binding.taskMandateSaid,
      },
    });
    expect(commit).toHaveBeenCalledWith({
      ownerAid: found.run.binding.ownerAid,
      runId: found.run.binding.runId,
      expectedRunVersion: found.run.version,
      expectedStreamVersion: found.stream.version,
      exchangeSaid,
      sealedAt: '2026-09-24T20:01:00.000Z',
    });
  });

  it('reports a pending exchange without committing any provisional state', async () => {
    const { storage, commit } = seals();
    const outcome = await reconcileEvidenceSeal(
      {
        ownerAid: runFixture().binding.ownerAid,
        runId: runFixture().binding.runId,
        sealExchangeSaid: exchangeSaid,
        observedAt: '2026-09-24T20:01:00.000Z',
      },
      {
        issuerAid: `E${'i'.repeat(43)}`,
        contexts: contexts(),
        exchanges: { inspect: vi.fn().mockResolvedValue({ kind: 'Pending' }) },
        seals: storage,
      },
    );

    expect(outcome).toEqual({
      kind: 'EvidenceSealPending',
      sealExchangeSaid: exchangeSaid,
      stream: context().stream,
    });
    expect(commit).not.toHaveBeenCalled();
  });
});
