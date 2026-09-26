import {
  decodeRunProjection,
  prepareEvidenceEvent,
  type EvidenceEvent,
  type RunProjection,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { VerifiedFailureCampaign } from './verified-failure-campaign.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (character: string): string =>
  `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;
const task = taskProjectionFixture();
const base = runProjectionFixture();
const runIds = ['1', '2', '3', '4', '5', '6'].map(id);

function event(
  run: RunProjection,
  sequence: number,
  previous: string | undefined,
  detail: EvidenceEvent['event'],
): EvidenceEvent {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor:
      previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous },
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    runId: run.runId,
    incarnationId: id(run.runId[0] ?? '1'),
    harnessRevisionSaid: base.harnessRevisionSaid,
    personalAgentAid: base.personalAgentAid,
    taskMandateSaid: base.taskMandateSaid,
    occurredAt: '2026-09-26T05:00:00.000Z',
    recordedAt: '2026-09-26T05:00:00.000Z',
    producer: { kind: 'RunSupervisor' },
    event: detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(`event rejected: ${prepared.reason}`);
  return prepared.event;
}

function run(index: number): RunProjection {
  const runId = runIds[index];
  if (runId === undefined) throw new Error('run ID missing');
  const checkpointSaid = said('c');
  return {
    ...base,
    runId,
    evidenceStreamId: id(String(index + 1)),
    activation: { ...base.activation, runId: runIds[0] ?? '' },
    purpose:
      index === 5
        ? { kind: 'Retained' }
        : {
            kind: 'PreparedCompatibilityCalibration',
            campaignId: id('9'),
            ordinal: (index + 1) as 1 | 2 | 3 | 4 | 5,
          },
    lifecycle:
      index === 5
        ? {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure', checkpointSaid },
          }
        : {
            kind: 'Ended',
            outcome: {
              kind: 'CalibrationConfirmed',
              checkpointSaid,
              category: {
                version: 1,
                taskId: task.taskId,
                taskRevisionSaid: task.revisionSaid,
                harnessRevisionSaid: base.harnessRevisionSaid,
                currentCommandSaid: said('d'),
                tamperCommandSaid: said('e'),
                legacyCommandSaid: said('f'),
                legacyObservedExitCode: 101,
              },
            },
          },
    submissionVerification: { kind: 'Rejected' },
  };
}

function timeline(run: RunProjection) {
  const observation = event(run, 0, undefined, {
    kind: 'Observation',
    source: 'Repository',
    artifactSaid: said('a'),
  });
  const profile = event(run, 1, observation.d, {
    kind: 'RunExecutionProfileBound',
    executionProfileSaid: said('p'),
    profileArtifactSaid: said('q'),
    worktreeBranch: `devrandom/run/${run.runId}`,
  });
  const checkpoint = event(run, 2, profile.d, {
    kind: 'CheckpointAccepted',
    checkpointSaid: said('c'),
  });
  const events =
    run.purpose.kind === 'Retained'
      ? [
          observation,
          profile,
          checkpoint,
          event(run, 3, checkpoint.d, {
            kind: 'FailureObserved',
            failure: 'HarnessCompatibilityFailure',
            receiptSaid: said('r'),
          }),
        ]
      : [observation, profile, checkpoint];
  const head = events.at(-1)?.d;
  if (head === undefined) throw new Error('missing head');
  return {
    version: 1 as const,
    stream: {
      version: 1 as const,
      runId: run.runId,
      evidenceStreamId: run.evidenceStreamId,
      cursor: {
        kind: 'Accepted' as const,
        eventCount: events.length,
        acceptedThroughSequence: events.length - 1,
        chainHeadSaid: head,
      },
      checkpoint: { kind: 'Accepted' as const, checkpointSaid: said('c') },
      seal: {
        kind: 'Sealed' as const,
        sealExchangeSaid: said('s'),
        eventCount: events.length,
        finalSequence: events.length - 1,
        chainHeadSaid: head,
        sealedAt: '2026-09-26T05:00:00.000Z',
      },
    },
    events: events.map((e) => ({
      version: 1 as const,
      event: e,
      receivedAt: '2026-09-26T05:00:00.000Z',
    })),
    nextCursor: null,
  };
}

it('exact-reads all six hosted Run and sealed timeline chains, then blocks missing profile custody', async () => {
  const inspected: string[] = [];
  const timelines: string[] = [];
  const runs = runIds.map((_, index) => run(index));
  expect(decodeRunProjection(runs[0])).toMatchObject({ kind: 'Accepted' });
  const qualification = new VerifiedFailureCampaign({
    read: () => Promise.resolve({ kind: 'Found', runIds: runIds.slice(0, 5) }),
  });
  const result = await qualification.inspect({
    task,
    originRunId: runIds[5] ?? '',
    executionProfileSaid: said('p'),
    expectedActiveRevisionSaid: base.harnessRevisionSaid,
    runs: {
      inspect: (runId) => {
        inspected.push(runId);
        const found = runs.find((item) => item.runId === runId);
        return Promise.resolve(
          found === undefined
            ? { kind: 'InputInvalid' as const }
            : { kind: 'Found' as const, run: found },
        );
      },
    },
    evidence: {
      inspect: (runId) => {
        timelines.push(runId);
        const found = runs.find((item) => item.runId === runId);
        return Promise.resolve(
          found === undefined
            ? { kind: 'InputInvalid' as const }
            : { kind: 'Found' as const, page: timeline(found) },
        );
      },
    },
    signal: new AbortController().signal,
  });
  expect(result).toEqual({ kind: 'Blocked' });
  expect(inspected).toEqual(runIds);
  expect(timelines).toEqual(runIds);
});

it('rejects a sealed cursor whose claimed head differs from the exact final event', async () => {
  const inspected: string[] = [];
  const first = run(0);
  const page = timeline(first);
  const forged = {
    ...page,
    stream: {
      ...page.stream,
      cursor: { ...page.stream.cursor, chainHeadSaid: said('z') },
      seal: { ...page.stream.seal, chainHeadSaid: said('z') },
    },
  };
  const qualification = new VerifiedFailureCampaign({
    read: () => Promise.resolve({ kind: 'Found', runIds: runIds.slice(0, 5) }),
  });
  expect(
    await qualification.inspect({
      task,
      originRunId: runIds[5] ?? '',
      executionProfileSaid: said('p'),
      expectedActiveRevisionSaid: base.harnessRevisionSaid,
      runs: {
        inspect: (runId) => {
          inspected.push(runId);
          return Promise.resolve({ kind: 'Found', run: first });
        },
      },
      evidence: { inspect: () => Promise.resolve({ kind: 'Found', page: forged }) },
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: 'Blocked' });
  expect(inspected).toEqual([runIds[0]]);
});
