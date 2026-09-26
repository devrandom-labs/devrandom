import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { governorAid, personalAgentAid } from '@devrandom/identity';
import { prepareEvidenceEvent, prepareRunSuccessorSegment } from '@devrandom/protocol';
import type { EvidenceTimelinePage, RunProjection } from '@devrandom/protocol';

import {
  runAdmissionExchangeSaid,
  runCommandId,
  runIncarnationId,
  runProjectionFixture,
} from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvidenceHttp } from '../infrastructure/server-evidence-http.js';
import { ServerRunHttp } from '../infrastructure/server-run-http.js';
import type { StableBaselineRunAdmission } from './baseline-run-admission.js';
import {
  TaskRunObservations,
  type AcceptedRunAdmissions,
  type TaskRunObservationAuthority,
} from './task-run-observation.js';

const checkpointSaid = `E${'q'.repeat(43)}`;
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');

function heldRun(phase: Extract<RunProjection['lifecycle'], { readonly kind: 'Active' }>['phase']) {
  const run = runProjectionFixture();
  return {
    ...run,
    runVersion: phase.kind === 'Blocked' ? 3 : 2,
    lifecycle: { kind: 'Active' as const, phase },
    submissionVerification:
      phase.kind === 'Blocked' ? { kind: 'Rejected' as const } : run.submissionVerification,
    lease: {
      kind: 'Held' as const,
      incarnationId: runIncarnationId,
      acquiredAt: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
      lastChange: { kind: 'Acquired' as const, fromRunVersion: 0 },
    },
  };
}

function acceptedAdmission(): Extract<
  StableBaselineRunAdmission,
  { readonly kind: 'LeaseAccepted' }
> {
  const run = runProjectionFixture();
  return {
    version: 1,
    kind: 'LeaseAccepted',
    binding: {
      ownerAid: run.ownerAid,
      taskId: run.taskId,
      taskRevisionSaid: run.taskRevisionSaid,
      harnessLineageId: run.harnessLineageId,
      harnessRevisionSaid: run.harnessRevisionSaid,
      personalAgentAid: personalAgent,
      taskMandateSaid: run.taskMandateSaid,
      governorAid: governor,
      promotionMandateSaid: run.promotionMandateSaid,
      purpose: run.purpose,
      repository: run.repository,
    },
    commandId: runCommandId,
    incarnationId: runIncarnationId,
    preparedAt: Date.parse('2026-09-24T20:00:00.000Z'),
    exchangeSaid: runAdmissionExchangeSaid,
    runAdmission: 'Created',
    run,
    lease: {
      version: 1,
      disposition: 'Acquired',
      runId: run.runId,
      incarnationId: runIncarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    },
  };
}

function timeline(run: RunProjection, nextCursor: string | null): EvidenceTimelinePage {
  return {
    version: 1,
    stream: {
      version: 1,
      runId: run.runId,
      evidenceStreamId: run.evidenceStreamId,
      cursor: { kind: 'Empty' },
      checkpoint: { kind: 'Absent' },
      seal: { kind: 'Unsealed' },
    },
    events: [],
    nextCursor,
  };
}

function authority(input: {
  readonly runs: readonly RunProjection[];
  readonly pages: readonly EvidenceTimelinePage[];
  readonly timelineQueries: Array<string | undefined>;
}): TaskRunObservationAuthority {
  const task = taskProjectionFixture();
  let runIndex = 0;
  let pageIndex = 0;
  return {
    acquireHostedWork: () =>
      Promise.resolve({
        kind: 'Authorized',
        tasks: { inspect: () => Promise.resolve({ kind: 'Inspected', task }) },
        runs: {
          inspect: () => {
            const run = input.runs[Math.min(runIndex, input.runs.length - 1)];
            runIndex += 1;
            return Promise.resolve(
              run === undefined ? { kind: 'ResponseInvalid' } : { kind: 'Found', run },
            );
          },
        },
        evidence: {
          inspect: (_runId, query) => {
            input.timelineQueries.push(query.cursor);
            const page = input.pages[Math.min(pageIndex, input.pages.length - 1)];
            pageIndex += 1;
            return Promise.resolve(
              page === undefined ? { kind: 'ResponseInvalid' } : { kind: 'Found', page },
            );
          },
        },
        grantExpiresAt: '2026-09-24T20:30:00.000Z',
      }),
  };
}

function admissions(): AcceptedRunAdmissions {
  return {
    locateAcceptedRun: () => Promise.resolve({ kind: 'Located', admission: acceptedAdmission() }),
  };
}

describe('Task Run observation', () => {
  it('returns one exact durable Task, Run, lease, verification, cursor, checkpoint, and seal view', async () => {
    const run = heldRun({ kind: 'Running' });
    const page = timeline(run, null);
    const observations = new TaskRunObservations({
      authority: authority({ runs: [run], pages: [page], timelineQueries: [] }),
      admissions: admissions(),
      now: () => Date.parse('2026-09-24T20:01:00.000Z'),
      wait: vi.fn(),
    });

    await expect(observations.status('repair-parser')).resolves.toEqual({
      kind: 'Observed',
      status: { task: taskProjectionFixture(), run, stream: page.stream },
    });
  });

  it('polls opaque bounded pages no faster than once per second and stops on a blocked Run', async () => {
    const running = heldRun({ kind: 'Running' });
    const blocked = heldRun({
      kind: 'Blocked',
      reason: 'HarnessCompatibilityFailure',
      checkpointSaid,
    });
    const timelineQueries: Array<string | undefined> = [];
    const wait = vi.fn(() => Promise.resolve({ kind: 'Elapsed' as const }));
    const observations = new TaskRunObservations({
      authority: authority({
        runs: [running, blocked],
        pages: [timeline(running, 'opaque-tail'), timeline(blocked, null)],
        timelineQueries,
      }),
      admissions: admissions(),
      now: () => Date.parse('2026-09-24T20:01:00.000Z'),
      wait,
    });
    const received = [];

    for await (const observation of observations.watch(
      'repair-parser',
      new AbortController().signal,
    )) {
      received.push(observation);
    }

    expect(received).toHaveLength(2);
    expect(received.map(({ kind }) => kind)).toEqual(['Observed', 'Observed']);
    expect(received[1]).toMatchObject({
      kind: 'Observed',
      status: {
        run: {
          lifecycle: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure', checkpointSaid },
          },
          submissionVerification: { kind: 'Rejected' },
        },
      },
    });
    expect(timelineQueries).toEqual([undefined, 'opaque-tail']);
    expect(wait).toHaveBeenCalledExactlyOnceWith(1_000, expect.any(AbortSignal));
  });

  it('keeps polling an active Run before its first evidence event creates a cursor', async () => {
    const running = heldRun({ kind: 'Running' });
    const timelineQueries: Array<string | undefined> = [];
    const wait = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'Elapsed' as const })
      .mockResolvedValueOnce({ kind: 'Interrupted' as const });
    const observations = new TaskRunObservations({
      authority: authority({
        runs: [running],
        pages: [timeline(running, null)],
        timelineQueries,
      }),
      admissions: admissions(),
      now: () => Date.parse('2026-09-24T20:01:00.000Z'),
      wait,
    });
    const received = [];

    for await (const observation of observations.watch(
      'repair-parser',
      new AbortController().signal,
    )) {
      received.push(observation);
    }

    expect(received.map(({ kind }) => kind)).toEqual(['Observed', 'Observed', 'WatchInterrupted']);
    expect(timelineQueries).toEqual([undefined, undefined]);
    expect(wait).toHaveBeenCalledTimes(2);
    for (const call of wait.mock.calls) expect(call).toEqual([1_000, expect.any(AbortSignal)]);
  });

  it('watches empty, advancing, and sealed pages through real HTTP and status agrees with the final view', async () => {
    const running = heldRun({ kind: 'Running' });
    const blocked = heldRun({
      kind: 'Blocked',
      reason: 'HarnessCompatibilityFailure',
      checkpointSaid,
    });
    const drafts = [
      { kind: 'RunStarted' as const, fromRunVersion: 1 },
      { kind: 'CheckpointVerified' as const, checkpointSaid },
      {
        kind: 'RunBlocked' as const,
        reason: 'HarnessCompatibilityFailure' as const,
        checkpointSaid,
      },
      { kind: 'CheckpointAccepted' as const, checkpointSaid },
    ];
    const events = [];
    for (const [sequence, event] of drafts.entries()) {
      const previous = events.at(-1);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
        taskId: running.taskId,
        taskRevisionSaid: running.taskRevisionSaid,
        runId: running.runId,
        incarnationId: runIncarnationId,
        harnessRevisionSaid: running.harnessRevisionSaid,
        personalAgentAid: running.personalAgentAid,
        taskMandateSaid: running.taskMandateSaid,
        occurredAt: '2026-09-24T20:00:01.000Z',
        recordedAt: '2026-09-24T20:00:01.000Z',
        producer: { kind: sequence === 0 || sequence === 2 ? 'RunSupervisor' : 'EvidenceRecorder' },
        event,
      });
      if (prepared.kind !== 'Prepared') throw new Error('fixture event must prepare');
      events.push(prepared.event);
    }
    const first = events[0];
    const final = events[3];
    if (first === undefined || final === undefined) throw new Error('fixture events missing');
    const receivedAt = '2026-09-24T20:00:02.000Z';
    const progressing: EvidenceTimelinePage = {
      ...timeline(running, 'opaque-tail'),
      stream: {
        version: 1,
        runId: running.runId,
        evidenceStreamId: running.evidenceStreamId,
        cursor: {
          kind: 'Accepted',
          eventCount: 1,
          acceptedThroughSequence: 0,
          chainHeadSaid: first.d,
        },
        checkpoint: { kind: 'Absent' },
        seal: { kind: 'Unsealed' },
      },
      events: [{ version: 1, event: first, receivedAt }],
    };
    const completed: EvidenceTimelinePage = {
      version: 1,
      stream: {
        version: 1,
        runId: blocked.runId,
        evidenceStreamId: blocked.evidenceStreamId,
        cursor: {
          kind: 'Accepted',
          eventCount: 4,
          acceptedThroughSequence: 3,
          chainHeadSaid: final.d,
        },
        checkpoint: { kind: 'Accepted', checkpointSaid },
        seal: {
          kind: 'Sealed',
          sealExchangeSaid: `E${'s'.repeat(43)}`,
          eventCount: 4,
          finalSequence: 3,
          chainHeadSaid: final.d,
          sealedAt: '2026-09-24T20:00:04.000Z',
        },
      },
      events: events.slice(1).map((event) => ({ version: 1, event, receivedAt })),
      nextCursor: null,
    };
    const pages: EvidenceTimelinePage[] = [timeline(running, null), progressing, completed];
    const runs = [running, running, blocked, blocked] as const;
    const queries: Array<string | undefined> = [];
    let runIndex = 0;
    let pageIndex = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.headers.authorization !== `Bearer ${'a'.repeat(43)}`) {
        response.writeHead(403, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        });
        response.end('{}');
        return;
      }
      if (path.pathname === `/api/runs/${running.runId}`) {
        const run = runs[Math.min(runIndex++, runs.length - 1)];
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(run));
        return;
      }
      if (path.pathname === `/api/runs/${running.runId}/timeline`) {
        queries.push(path.searchParams.get('cursor') ?? undefined);
        const page = pages[Math.min(pageIndex++, pages.length - 1)];
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(page));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
      const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
      if (decoded.kind !== 'Accepted') throw new Error('invalid loopback origin');
      const bearer = 'a'.repeat(43);
      const runs = new ServerRunHttp(decoded.origin, bearer, fetch);
      const evidence = new ServerEvidenceHttp(decoded.origin, bearer, fetch);
      const observations = new TaskRunObservations({
        authority: {
          acquireHostedWork: () =>
            Promise.resolve({
              kind: 'Authorized',
              tasks: {
                inspect: () =>
                  Promise.resolve({ kind: 'Inspected', task: taskProjectionFixture() }),
              },
              runs,
              evidence,
              grantExpiresAt: '2026-09-24T20:30:00.000Z',
            }),
        },
        admissions: admissions(),
        now: () => Date.parse('2026-09-24T20:01:00.000Z'),
        wait: () => Promise.resolve({ kind: 'Elapsed' }),
      });
      const watched = [];
      for await (const observation of observations.watch(
        'repair-parser',
        new AbortController().signal,
      )) {
        watched.push(observation);
      }
      expect(watched.map(({ kind }) => kind)).toEqual(['Observed', 'Observed', 'Observed']);
      expect(
        watched.map((observation) =>
          observation.kind === 'Observed'
            ? observation.events.map(({ event }) => event.sequence)
            : [],
        ),
      ).toEqual([[], [0], [1, 2, 3]]);
      expect(queries).toEqual([undefined, undefined, 'opaque-tail']);
      expect(watched[2]).toMatchObject({
        kind: 'Observed',
        status: { run: blocked, stream: completed.stream },
      });
      await expect(observations.status('repair-parser')).resolves.toEqual({
        kind: 'Observed',
        status: { task: taskProjectionFixture(), run: blocked, stream: completed.stream },
      });

      // A fresh observer starts at sequence zero even when the Run has already stopped.
      runIndex = 2;
      pageIndex = 0;
      queries.length = 0;
      pages.splice(
        0,
        pages.length,
        { ...completed, events: progressing.events, nextCursor: 'opaque-tail' },
        completed,
      );
      const backlog = [];
      for await (const observation of observations.watch(
        'repair-parser',
        new AbortController().signal,
      )) {
        backlog.push(observation);
      }
      expect(
        backlog.flatMap((observation) =>
          observation.kind === 'Observed'
            ? observation.events.map(({ event }) => event.sequence)
            : [],
        ),
      ).toEqual([0, 1, 2, 3]);
      expect(queries).toEqual([undefined, 'opaque-tail']);

      runIndex = 0;
      pageIndex = 0;
      queries.length = 0;
      pages.splice(0, pages.length, timeline(running, null), progressing, completed);
      const interruption = new AbortController();
      const waitIntervals: number[] = [];
      const interruptedObservations = new TaskRunObservations({
        authority: {
          acquireHostedWork: () =>
            Promise.resolve({
              kind: 'Authorized',
              tasks: {
                inspect: () =>
                  Promise.resolve({ kind: 'Inspected', task: taskProjectionFixture() }),
              },
              runs,
              evidence,
              grantExpiresAt: '2026-09-24T20:30:00.000Z',
            }),
        },
        admissions: admissions(),
        now: () => Date.parse('2026-09-24T20:01:00.000Z'),
        wait: (milliseconds, signal) => {
          waitIntervals.push(milliseconds);
          expect(signal).toBe(interruption.signal);
          return new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve({ kind: 'Interrupted' });
              },
              { once: true },
            );
            queueMicrotask(() => {
              interruption.abort();
            });
          });
        },
      });
      const interrupted = [];
      for await (const observation of interruptedObservations.watch(
        'repair-parser',
        interruption.signal,
      )) {
        interrupted.push(observation);
      }
      expect(interrupted.map(({ kind }) => kind)).toEqual(['Observed', 'WatchInterrupted']);
      expect(interrupted[0]).toMatchObject({
        kind: 'Observed',
        status: { run: running },
        events: [],
      });
      expect(waitIntervals).toEqual([1_000]);
      expect(queries).toEqual([undefined]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });
});
it.each([1, 2] as const)(
  'observes the exact v%s successor and requests its stream rather than the original stream',
  async (version) => {
    const baseRun = heldRun({ kind: 'Running' });
    const original = {
      ...baseRun,
      ...(version === 2
        ? {
            purpose: {
              kind: 'PreparedCompatibilityCalibration' as const,
              campaignId: baseRun.runId,
              ordinal: 1 as const,
            },
          }
        : {}),
    };
    const successor = {
      incarnationId: '10000000-0000-4000-8000-000000000001',
      evidenceStreamId: '10000000-0000-4000-8000-000000000002',
      harnessRevisionSaid: version === 1 ? `E${'z'.repeat(43)}` : original.harnessRevisionSaid,
    };
    const prepared = prepareRunSuccessorSegment({
      ...(version === 1
        ? {
            version: 1 as const,
            kind: 'RunSuccessorSegment' as const,
            activation: { pointerVersion: 2, decisionReceiptSaid: checkpointSaid },
          }
        : {
            version: 2 as const,
            kind: 'CalibrationContinuationSegment' as const,
            baseline: {
              pointerVersion: 1 as const,
              harnessRevisionSaid: original.harnessRevisionSaid,
            },
          }),
      runId: original.runId,
      taskId: original.taskId,
      taskRevisionSaid: original.taskRevisionSaid,
      ownerAid: original.ownerAid,
      personalAgentAid: original.personalAgentAid,
      taskMandateSaid: original.taskMandateSaid,
      fromRunVersion: 3,
      predecessor: {
        incarnationId: runIncarnationId,
        evidenceStreamId: original.evidenceStreamId,
        checkpointSaid,
        sealExchangeSaid: checkpointSaid,
        finalSequence: 2,
        chainHeadSaid: checkpointSaid,
      },
      successor,
      consumedBudget: original.budget.consumed,
      admittedAt: '2026-09-24T20:01:00.000Z',
    });
    if (prepared.kind !== 'Prepared') throw Error('segment');
    const run: RunProjection = {
      ...original,
      runVersion: 5,
      currentExecution: {
        segmentSaid: prepared.segment.d,
        evidenceStreamId: successor.evidenceStreamId,
        harnessRevisionSaid: successor.harnessRevisionSaid,
      },
      lease: {
        ...original.lease,
        incarnationId: successor.incarnationId,
        segmentSaid: prepared.segment.d,
        lastChange: {
          kind: 'Replaced',
          fromRunVersion: 3,
          segmentSaid: prepared.segment.d,
        },
      },
    };
    const page = timeline(run, null);
    page.stream.evidenceStreamId = successor.evidenceStreamId;
    const readSegment = vi.fn(() =>
      Promise.resolve({ kind: 'Found' as const, segment: prepared.segment }),
    );
    const inspect = vi.fn(() => Promise.resolve({ kind: 'Found' as const, page }));
    const base = await authority({
      runs: [run],
      pages: [page],
      timelineQueries: [],
    }).acquireHostedWork();
    if (base.kind !== 'Authorized') throw Error('authority');
    const observations = new TaskRunObservations({
      authority: {
        acquireHostedWork: () =>
          Promise.resolve({
            ...base,
            runs: { ...base.runs, readSuccessorSegment: readSegment },
            evidence: { inspect },
          }),
      },
      admissions: {
        locateAcceptedRun: () => {
          const accepted = acceptedAdmission();
          return Promise.resolve({
            kind: 'Located',
            admission: {
              ...accepted,
              binding: { ...accepted.binding, purpose: original.purpose },
              run: { ...accepted.run, purpose: original.purpose },
            },
          });
        },
      },
      now: () => Date.parse('2026-09-24T20:02:00.000Z'),
      wait: vi.fn(),
    });
    expect((await observations.status('cesr-compat')).kind).toBe('Observed');
    expect(readSegment).toHaveBeenCalledWith(run.runId, prepared.segment.d);
    expect(inspect).toHaveBeenCalledWith(run.runId, {
      evidenceStreamId: successor.evidenceStreamId,
    });
    readSegment.mockResolvedValueOnce({
      kind: 'Found',
      segment: { ...prepared.segment, ownerAid: `E${'x'.repeat(43)}` },
    });
    expect((await observations.status('cesr-compat')).kind).toBe('RunBindingRejected');
  },
);
