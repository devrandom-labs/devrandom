import { describe, expect, it, vi } from 'vitest';

import { acquireFirstRunLease, createRun, taskBudgetCeilings, type Run } from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  type EvidenceBatchAcknowledgement,
  type EvidenceProblem,
} from '@devrandom/protocol';
import type { EvidenceRecorder } from '@devrandom/runtime';

import {
  deliverNextEvidencePage,
  deliverRunEvidence,
  type HostedEvidence,
} from './evidence-delivery.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const streamId = 'a30aae94-a652-485f-a2cc-8980134f4acc';
const said = (character: string) => `E${character.repeat(43)}`;

function leasedRun(): Run {
  const created = createRun({
    runId,
    ownerAid: said('z'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('a'),
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: said('b'),
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: said('b'),
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('g'),
    evidenceStreamId: streamId,
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T19:59:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('Run fixture must prepare');
  }
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T19:59:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('Run fixture must acquire a lease');
  }
  return leased.run;
}

function deliveryFixture() {
  const bytes = new TextEncoder().encode('tool output\n');
  const preparedArtifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (preparedArtifact.kind !== 'Prepared') {
    throw new Error('artifact fixture must prepare');
  }
  const preparedEvent = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('a'),
    runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.001Z',
    producer: { kind: 'ToolGateway' },
    event: {
      kind: 'Observation',
      source: 'ToolEffect',
      artifactSaid: preparedArtifact.artifact.d,
    },
  });
  if (preparedEvent.kind !== 'Prepared') {
    throw new Error('event fixture must prepare');
  }
  const preparedBatch = prepareEvidenceBatch({
    version: 1,
    runId,
    evidenceStreamId: streamId,
    events: [preparedEvent.event],
  });
  if (preparedBatch.kind !== 'Prepared') {
    throw new Error('batch fixture must prepare');
  }
  const acknowledgement: EvidenceBatchAcknowledgement = {
    version: 1,
    disposition: { kind: 'Accepted' },
    runId,
    evidenceStreamId: streamId,
    batchSaid: preparedBatch.batch.d,
    acceptedThroughSequence: 0,
    chainHeadSaid: preparedEvent.event.d,
    receivedAt: '2026-09-24T20:00:01.000Z',
  };
  return {
    artifact: preparedArtifact.artifact,
    bytes,
    event: preparedEvent.event,
    batch: preparedBatch.batch,
    acknowledgement,
  };
}

function recorder() {
  const fixture = deliveryFixture();
  const readiness = vi.fn<EvidenceRecorder['readiness']>().mockReturnValue({
    kind: 'Ready',
    readiness: { kind: 'Genesis', streamId },
  });
  const record = vi.fn<EvidenceRecorder['record']>().mockReturnValue({ kind: 'Unavailable' });
  const page = vi.fn<EvidenceRecorder['page']>().mockReturnValue({
    kind: 'Page',
    page: { batch: fixture.batch, events: [fixture.event], encodedBytes: 512 },
  });
  const acknowledge = vi.fn<EvidenceRecorder['acknowledge']>().mockReturnValue({
    kind: 'Acknowledged',
    acknowledgement: fixture.acknowledgement,
  });
  const storeArtifact = vi
    .fn<EvidenceRecorder['storeArtifact']>()
    .mockReturnValue({ kind: 'Unavailable' });
  const artifact = vi.fn<EvidenceRecorder['artifact']>().mockReturnValue({
    kind: 'Read',
    artifact: fixture.artifact,
    bytes: fixture.bytes,
  });
  const storeCheckpoint = vi
    .fn<EvidenceRecorder['storeCheckpoint']>()
    .mockReturnValue({ kind: 'CheckpointRejected' });
  const checkpoint = vi
    .fn<EvidenceRecorder['checkpoint']>()
    .mockReturnValue({ kind: 'CheckpointNotFound' });
  const recordSealAcknowledgement = vi
    .fn<EvidenceRecorder['recordSealAcknowledgement']>()
    .mockReturnValue({ kind: 'AcknowledgementRejected' });
  const sealAcknowledgement = vi
    .fn<EvidenceRecorder['sealAcknowledgement']>()
    .mockReturnValue({ kind: 'NotFound' });
  const close = vi.fn<EvidenceRecorder['close']>();
  return {
    run: leasedRun(),
    readiness,
    recordBudgetDebit: () => ({ kind: 'Unavailable' }),
    withhold: () => ({ kind: 'Unavailable' }),
    record,
    page,
    acknowledge,
    storeArtifact,
    artifact,
    storeCheckpoint,
    checkpoint,
    recordCheckpointAcceptance: () => ({ kind: 'Unavailable' }),
    recordSealAcknowledgement,
    sealAcknowledgement,
    close,
  } satisfies EvidenceRecorder;
}

function hosted() {
  const fixture = deliveryFixture();
  const storeArtifact = vi.fn<HostedEvidence['storeArtifact']>().mockResolvedValue({
    kind: 'Stored',
    acknowledgement: {
      version: 1,
      disposition: 'Stored',
      runId,
      artifact: fixture.artifact,
      receivedAt: '2026-09-24T20:00:01.000Z',
    },
  });
  const appendBatch = vi.fn<HostedEvidence['appendBatch']>().mockResolvedValue({
    kind: 'Accepted',
    acknowledgement: fixture.acknowledgement,
  });
  return {
    storeArtifact,
    appendBatch,
  } satisfies HostedEvidence;
}

describe('Evidence delivery', () => {
  it.each<EvidenceProblem>([
    {
      type: 'https://devrandom.example/problems/evidence-unavailable',
      title: 'Evidence dependency is unavailable',
      status: 503,
      code: 'EvidenceUnavailable',
      dependency: 'HostedMongoDB',
      correlationId: runId,
    },
    {
      type: 'https://devrandom.example/problems/evidence-conflict',
      title: 'Evidence delivery conflicts with the accepted stream',
      status: 409,
      code: 'EvidenceConflict',
      reason: 'CursorConcurrentUpdate',
      correlationId: runId,
    },
  ])('retries transient transport rejection $code', async (problem) => {
    const local = recorder();
    const remote = hosted();
    const cancellation = new AbortController();
    remote.appendBatch.mockResolvedValue({ kind: 'RequestRejected', problem });
    const waitUntil = vi.fn(() => {
      cancellation.abort();
      return Promise.resolve({ kind: 'Aborted' as const });
    });
    await expect(
      deliverRunEvidence({
        recorder: local,
        hosted: remote,
        signal: cancellation.signal,
        clock: { monotonicNow: () => 0, waitUntil },
      }),
    ).resolves.toEqual({ kind: 'Aborted' });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(local.acknowledge).not.toHaveBeenCalled();
  });

  it('reports an expired transport grant as a dependency loss without claiming corrupt evidence', async () => {
    const local = recorder();
    const remote = hosted();
    remote.appendBatch.mockResolvedValue({
      kind: 'RequestRejected',
      problem: {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId: runId,
      },
    });
    await expect(
      deliverRunEvidence({
        recorder: local,
        hosted: remote,
        signal: new AbortController().signal,
        clock: { monotonicNow: () => 0, waitUntil: () => Promise.reject(new Error('must stop')) },
      }),
    ).resolves.toEqual({ kind: 'DependencyUnavailable' });
    expect(local.acknowledge).not.toHaveBeenCalled();
  });

  it('retries a transient failure serially and sends the identical pending batch', async () => {
    const local = recorder();
    const remote = hosted();
    const cancellation = new AbortController();
    remote.appendBatch.mockResolvedValueOnce({ kind: 'ServerUnavailable' });
    local.acknowledge.mockImplementation((acknowledgement) => {
      local.page.mockReturnValue({ kind: 'Empty' });
      return { kind: 'Acknowledged', acknowledgement };
    });
    const waitUntil = vi
      .fn()
      .mockImplementationOnce(() => {
        expect(local.acknowledge).not.toHaveBeenCalled();
        return Promise.resolve({ kind: 'Reached' });
      })
      .mockImplementationOnce(() => {
        cancellation.abort();
        return Promise.resolve({ kind: 'Aborted' });
      });
    await expect(
      deliverRunEvidence({
        recorder: local,
        hosted: remote,
        signal: cancellation.signal,
        clock: { monotonicNow: () => 0, waitUntil },
      }),
    ).resolves.toEqual({ kind: 'Aborted' });
    expect(remote.appendBatch).toHaveBeenCalledTimes(2);
    expect(remote.appendBatch.mock.calls[0]).toEqual(remote.appendBatch.mock.calls[1]);
    expect(local.acknowledge).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledTimes(2);
  });

  it('does not open another transport page while the current acknowledgement is pending', async () => {
    const local = recorder();
    const remote = hosted();
    const cancellation = new AbortController();
    const response = Promise.withResolvers<Awaited<ReturnType<HostedEvidence['appendBatch']>>>();
    remote.appendBatch.mockReturnValue(response.promise);
    const delivery = deliverRunEvidence({
      recorder: local,
      hosted: remote,
      signal: cancellation.signal,
      clock: {
        monotonicNow: () => 0,
        waitUntil: () => Promise.reject(new Error('unexpected wait')),
      },
    });
    await vi.waitFor(() => {
      expect(remote.appendBatch).toHaveBeenCalledOnce();
    });
    expect(local.page).toHaveBeenCalledOnce();
    cancellation.abort();
    response.resolve({ kind: 'Accepted', acknowledgement: deliveryFixture().acknowledgement });
    await expect(delivery).resolves.toEqual({ kind: 'Aborted' });
    expect(local.acknowledge).not.toHaveBeenCalled();
    expect(local.page).toHaveBeenCalledOnce();
  });

  it('does not transport an already-cancelled page', async () => {
    const local = recorder();
    const remote = hosted();
    const input = { recorder: local, hosted: remote, signal: AbortSignal.abort() };
    await expect(deliverNextEvidencePage(input)).resolves.toEqual({ kind: 'Aborted' });
    expect(remote.storeArtifact).not.toHaveBeenCalled();
    expect(remote.appendBatch).not.toHaveBeenCalled();
    expect(local.acknowledge).not.toHaveBeenCalled();
  });

  it('leaves an in-flight batch unacknowledged when cancellation wins', async () => {
    const local = recorder();
    const remote = hosted();
    const cancellation = new AbortController();
    remote.appendBatch.mockImplementation(() => {
      cancellation.abort();
      return Promise.resolve({
        kind: 'Accepted',
        acknowledgement: deliveryFixture().acknowledgement,
      });
    });
    const input = { recorder: local, hosted: remote, signal: cancellation.signal };
    await expect(deliverNextEvidencePage(input)).resolves.toEqual({ kind: 'Aborted' });
    expect(local.acknowledge).not.toHaveBeenCalled();
  });

  it('uploads referenced artifacts before one exact batch and advances only from its acknowledgement', async () => {
    const local = recorder();
    const remote = hosted();

    const outcome = await deliverNextEvidencePage({ recorder: local, hosted: remote });

    expect(outcome).toMatchObject({ kind: 'Delivered' });
    expect(remote.storeArtifact).toHaveBeenCalledOnce();
    expect(remote.appendBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(remote.storeArtifact).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(remote.appendBatch).mock.invocationCallOrder[0] ?? 0,
    );
    const sent = vi.mocked(remote.appendBatch).mock.calls[0];
    expect(sent?.[0]).toBe(runId);
    expect(sent?.[1]).toEqual({
      version: 1,
      batch: deliveryFixture().batch,
      events: [deliveryFixture().event],
    });
    expect(local.acknowledge).toHaveBeenCalledWith(deliveryFixture().acknowledgement);
  });

  it('does not send a batch when a referenced artifact is missing locally', async () => {
    const local = recorder();
    vi.mocked(local.artifact).mockReturnValue({ kind: 'ArtifactNotFound' });
    const remote = hosted();

    await expect(
      deliverNextEvidencePage({
        recorder: local,
        hosted: remote,
      }),
    ).resolves.toEqual({ kind: 'LocalStateCorruption' });
    expect(remote.storeArtifact).not.toHaveBeenCalled();
    expect(remote.appendBatch).not.toHaveBeenCalled();
    expect(local.acknowledge).not.toHaveBeenCalled();
  });
});
