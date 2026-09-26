import {
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  type EvidenceEvent,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { prepareQualifiedSourceInventory } from './prepare-qualified-source-inventory.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const runIds = ['1', '2', '3', '4', '5'].map(
  (digit) =>
    `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
);
const baseline = runProjectionFixture();
const taskV1 = taskProjectionFixture();
const task = {
  ...taskV1,
  revision: {
    ...taskV1.revision,
    version: 2 as const,
    constraints: {
      ...taskV1.revision.constraints,
      dataPolicy: 'RepositoryAndAuthorizedTaskExperience' as const,
      experience: {
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy' as const,
      },
    },
  },
};

function fixture(sharedOutput = false, excludedOrdinals: readonly number[] = []) {
  const runs = new Map<string, ReturnType<typeof runProjectionFixture>>();
  const pages = new Map<string, object>();
  const artifacts = new Map<string, { artifact: object; bytes: Uint8Array }>();
  const receipts = new Map<string, { receipt: PublicVerifierReceipt; checkpointSaid: string }>();
  const sources: { runId: string; eventSaid: string; rawSaid: string }[] = [];
  for (const [index, runId] of runIds.entries()) {
    const bytes = new TextEncoder().encode(
      sharedOutput
        ? 'public verifier legacy failure'
        : `public verifier legacy failure ${String(index + 1)}`,
    );
    const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (artifact.kind !== 'Prepared') throw new Error('artifact fixture');
    const receipt = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: 'public-test',
      commandSaid: said('f'),
      recordedAt: '2026-09-26T05:00:00.000Z',
      outcome: {
        kind: 'Rejected',
        reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
        elapsedMilliseconds: 1,
        outputArtifactSaids: [artifact.artifact.d],
      },
    });
    if (receipt.kind !== 'Prepared') throw new Error('receipt fixture');
    const run = {
      ...baseline,
      runId,
      evidenceStreamId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
      taskRevisionSaid: task.revisionSaid,
      taskMandateSaid: said('m'),
      submissionVerification: { kind: 'Rejected' as const },
      activation: { ...baseline.activation, runId: runIds[0] },
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: '99999999-9999-4999-8999-999999999999',
        ordinal: (index + 1) as 1 | 2 | 3 | 4 | 5,
      },
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationConfirmed' as const,
          checkpointSaid: said('k'),
          category: {
            version: 1 as const,
            taskId: task.taskId,
            taskRevisionSaid: task.revisionSaid,
            harnessRevisionSaid: baseline.harnessRevisionSaid,
            currentCommandSaid: said('d'),
            tamperCommandSaid: said('e'),
            legacyCommandSaid: said('f'),
            legacyObservedExitCode: 101,
          },
        },
      },
    };
    const makeEvent = (
      sequence: number,
      predecessor: EvidenceEvent['predecessor'],
      detail: EvidenceEvent['event'],
    ) => {
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        runId,
        incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        harnessRevisionSaid: baseline.harnessRevisionSaid,
        personalAgentAid: baseline.personalAgentAid,
        taskMandateSaid: said('m'),
        occurredAt: '2026-09-26T05:00:00.000Z',
        recordedAt: '2026-09-26T05:00:00.000Z',
        producer: { kind: 'RunSupervisor' },
        event: detail,
      });
      if (prepared.kind !== 'Prepared') throw new Error('event fixture');
      return prepared.event;
    };
    const observation = makeEvent(
      0,
      { kind: 'Genesis' },
      {
        kind: 'Observation',
        source: 'Verifier',
        artifactSaid: artifact.artifact.d,
      },
    );
    const failure = makeEvent(
      1,
      { kind: 'Previous', eventSaid: observation.d },
      {
        kind: 'FailureObserved',
        failure: 'HarnessCompatibilityFailure',
        receiptSaid: receipt.receipt.d,
      },
    );
    const excluded = excludedOrdinals.includes(index + 1);
    const excludedEvent = makeEvent(
      0,
      { kind: 'Genesis' },
      { kind: 'RunStarted', fromRunVersion: 0 },
    );
    const stream = {
      version: 1,
      runId,
      evidenceStreamId: run.evidenceStreamId,
      cursor: {
        kind: 'Accepted',
        eventCount: excluded ? 1 : 2,
        chainHeadSaid: excluded ? excludedEvent.d : failure.d,
      },
      checkpoint: { kind: 'Accepted', checkpointSaid: said('k') },
      seal: {
        kind: 'Sealed',
        eventCount: excluded ? 1 : 2,
        chainHeadSaid: excluded ? excludedEvent.d : failure.d,
        sealExchangeSaid: said('s'),
      },
    };
    runs.set(
      runId,
      (excluded
        ? {
            ...run,
            lifecycle: {
              kind: 'Ended',
              outcome: {
                kind: 'CalibrationExcluded',
                reason: 'ProviderUnavailable',
                checkpointSaid: said('k'),
              },
            },
          }
        : run) as never,
    );
    pages.set(runId, {
      stream,
      events: excluded ? [{ event: excludedEvent }] : [{ event: observation }, { event: failure }],
      nextCursor: null,
    });
    artifacts.set(`${runId}:${artifact.artifact.d}`, { artifact: artifact.artifact, bytes });
    receipts.set(`${runId}:${receipt.receipt.d}`, {
      receipt: receipt.receipt,
      checkpointSaid: said('k'),
    });
    sources.push({ runId, eventSaid: observation.d, rawSaid: artifact.artifact.d });
  }
  const qualification = {
    task,
    originRunId: baseline.runId,
    executionProfileSaid: said('p'),
    expectedActiveRevisionSaid: baseline.harnessRevisionSaid,
    runs: {
      inspect: vi.fn((runId: string) => Promise.resolve({ kind: 'Found', run: runs.get(runId) })),
    },
    evidence: {
      inspect: vi.fn((runId: string) => Promise.resolve({ kind: 'Found', page: pages.get(runId) })),
      readArtifact: vi.fn((runId: string, artifactSaid: string) =>
        Promise.resolve({
          kind: 'Read',
          ...artifacts.get(`${runId}:${artifactSaid}`),
        }),
      ),
      readVerifierReceipt: vi.fn((runId: string, receiptSaid: string) =>
        Promise.resolve({
          kind: 'Read',
          ...receipts.get(`${runId}:${receiptSaid}`),
        }),
      ),
    },
    signal: new AbortController().signal,
  };
  const ports = {
    qualification: {
      inspect: vi.fn().mockResolvedValue({
        kind: 'Qualified',
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        originRunId: baseline.runId,
        retainedCheckpointSaid: said('k'),
        retainedSealSaid: said('s'),
        expectedActiveRevisionSaid: baseline.harnessRevisionSaid,
        personalAgentAid: baseline.personalAgentAid,
        taskMandateSaid: said('m'),
        executionProfileSaid: said('p'),
      }),
    },
    history: { read: vi.fn().mockResolvedValue({ kind: 'Found', runIds }) },
    mandate: {
      inspect: vi.fn().mockResolvedValue({
        kind: 'Current',
        mandateSaid: said('m'),
        ownerAid: task.ownerAid,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      }),
    },
  };
  return { qualification, ports, pages, artifacts, sources, runs };
}

describe('qualified source inventory preparation', () => {
  it.each([1, 3, 5])(
    'retains four real analogy sources after lawful excluded calibration ordinal%s',
    async (ordinal) => {
      const test = fixture(false, [ordinal]);
      const result = await prepareQualifiedSourceInventory(test.qualification as never, test.ports);
      expect(result.kind).toBe('Prepared');
      if (result.kind !== 'Prepared') return;
      expect(result.sources).toHaveLength(4);
      expect(result.sources.map((source) => source.runId)).toEqual(
        runIds.filter((_, index) => index + 1 !== ordinal),
      );
      expect(test.qualification.evidence.readVerifierReceipt).toHaveBeenCalledTimes(4);
      expect(test.qualification.evidence.readArtifact).toHaveBeenCalledTimes(4);
    },
  );
  it('rejects two exclusions even if the earlier qualification capability said Qualified', async () => {
    const test = fixture(false, [1, 5]);
    expect(await prepareQualifiedSourceInventory(test.qualification as never, test.ports)).toEqual({
      kind: 'Blocked',
      gate: 'Timeline',
    });
  });
  it.each([
    'Unsealed',
    'WrongHead',
    'WrongCheckpoint',
    'WrongCampaign',
    'WrongOrdinal',
    'InvalidReason',
  ])('rejects excluded calibration %s before exposing its nonexistent source', async (fault) => {
    const test = fixture(false, [1]);
    const runId = runIds[0];
    if (runId === undefined) throw new Error('fixture');
    const page = test.pages.get(runId);
    const run = test.runs.get(runId);
    if (page === undefined || run === undefined) throw new Error('fixture');
    const stream: unknown = Reflect.get(page, 'stream');
    if (typeof stream !== 'object' || stream === null) throw new Error('stream fixture');
    if (fault === 'Unsealed') Reflect.set(stream, 'seal', { kind: 'Open' });
    if (fault === 'WrongHead') Reflect.set(Reflect.get(stream, 'seal'), 'chainHeadSaid', said('x'));
    if (fault === 'WrongCheckpoint')
      Reflect.set(stream, 'checkpoint', { kind: 'Accepted', checkpointSaid: said('x') });
    if (fault === 'WrongCampaign')
      Reflect.set(
        Reflect.get(run, 'purpose'),
        'campaignId',
        '88888888-8888-4888-8888-888888888888',
      );
    if (fault === 'WrongOrdinal') Reflect.set(Reflect.get(run, 'purpose'), 'ordinal', 2);
    if (fault === 'InvalidReason')
      Reflect.set(Reflect.get(Reflect.get(run, 'lifecycle'), 'outcome'), 'reason', 'H1Passed');
    expect(await prepareQualifiedSourceInventory(test.qualification as never, test.ports)).toEqual({
      kind: 'Blocked',
      gate: 'Timeline',
    });
  });

  it('requires genuine Q before reading calibration histories', async () => {
    const test = fixture();
    test.ports.qualification.inspect.mockResolvedValueOnce({ kind: 'Blocked' });
    expect(
      await prepareQualifiedSourceInventory(test.qualification as never, test.ports as never),
    ).toEqual({ kind: 'Blocked', gate: 'Qualification' });
    expect(test.ports.history.read).not.toHaveBeenCalled();
  });

  it('prepares five distinct exact public verifier sources under the current mandate', async () => {
    const test = fixture();
    const result = await prepareQualifiedSourceInventory(test.qualification as never, test.ports);
    expect(result).toMatchObject({ kind: 'Prepared' });
    if (result.kind !== 'Prepared') return;
    expect(result.sources.map((source) => source.observationEventSaid)).toEqual(
      test.sources.map((source) => source.eventSaid),
    );
    expect(result.inventory.sources.map((source) => source.rawEvidenceSaid)).toEqual(
      test.sources.map((source) => source.rawSaid),
    );
    expect(result.inventory.experienceMandateSaid).toBe(said('m'));
  });

  it('keeps five sealed Observation identities even when all public verifier bytes are identical', async () => {
    const test = fixture(true);
    const result = await prepareQualifiedSourceInventory(test.qualification as never, test.ports);
    expect(result).toMatchObject({ kind: 'Prepared' });
    if (result.kind !== 'Prepared') return;
    expect(new Set(result.sources.map((source) => source.observationEventSaid)).size).toBe(5);
    expect(new Set(result.sources.map((source) => source.rawEvidenceSaid)).size).toBe(1);
  });

  it('blocks a substituted raw artifact even when Q was previously qualified', async () => {
    const test = fixture();
    const first = test.sources[0];
    if (first === undefined) throw new Error('source fixture');
    test.artifacts.set(`${first.runId}:${first.rawSaid}`, {
      artifact: { d: first.rawSaid },
      bytes: new TextEncoder().encode('substituted'),
    });
    expect(
      await prepareQualifiedSourceInventory(test.qualification as never, test.ports as never),
    ).toEqual({ kind: 'Blocked', gate: 'RawSource' });
  });

  it('rejects a stale experience mandate before reading any Run source', async () => {
    const test = fixture();
    test.ports.mandate.inspect.mockResolvedValueOnce({
      kind: 'Current',
      mandateSaid: said('x'),
      ownerAid: task.ownerAid,
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      repositoryResourceSaid: said('r'),
      corpusSaid: said('c'),
      disclosure: 'AuthorizedAnalogy',
    });
    expect(
      await prepareQualifiedSourceInventory(test.qualification as never, test.ports as never),
    ).toEqual({ kind: 'Blocked', gate: 'Mandate' });
    expect(test.ports.history.read).not.toHaveBeenCalled();
  });

  it('rejects a receipt that does not bind the observed raw artifact', async () => {
    const test = fixture();
    const receipt = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: 'public-test',
      commandSaid: said('f'),
      recordedAt: '2026-09-26T05:00:00.000Z',
      outcome: {
        kind: 'Rejected',
        reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
        elapsedMilliseconds: 1,
        outputArtifactSaids: [said('x')],
      },
    });
    if (receipt.kind !== 'Prepared') throw new Error('receipt fixture');
    test.qualification.evidence.readVerifierReceipt.mockResolvedValueOnce({
      kind: 'Read',
      checkpointSaid: said('k'),
      receipt: receipt.receipt,
    });
    expect(
      await prepareQualifiedSourceInventory(test.qualification as never, test.ports as never),
    ).toEqual({ kind: 'Blocked', gate: 'Receipt' });
  });

  it('rejects a current Run projection whose owner has drifted', async () => {
    const test = fixture();
    const firstRunId = runIds[0];
    if (firstRunId === undefined) throw new Error('Run fixture');
    const firstRun = test.runs.get(firstRunId);
    if (firstRun === undefined) throw new Error('Run fixture');
    test.qualification.runs.inspect.mockResolvedValueOnce({
      kind: 'Found',
      run: { ...firstRun, ownerAid: said('x') },
    });
    expect(
      await prepareQualifiedSourceInventory(test.qualification as never, test.ports as never),
    ).toEqual({ kind: 'Blocked', gate: 'Timeline' });
  });
});
