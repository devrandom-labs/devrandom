import { ProtectedCredentials } from '@devrandom/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  decodeRunProjection,
  prepareEvidenceArtifact,
  type RunProjection,
} from '@devrandom/protocol';
import type { RunPredecessorCustody } from '../application/run-predecessor-custody.js';
import type { HostedRunTimelines } from '../application/task-run-observation.js';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { TaskTerminalVerificationComposition } from './task-terminal-verification.js';
const said = (letter: string) => 'E' + letter.repeat(43);
function fixture() {
  const initial = runProjectionFixture();
  const runId = initial.runId;
  const receipt = {
    version: 1,
    kind: 'RunTerminalVerification',
    runId,
    taskRevisionSaid: initial.taskRevisionSaid,
    harnessRevisionSaid: said('h'),
    segmentSaid: said('s'),
    evaluationId: '10000000-0000-4000-8000-000000000002',
    manifestSaid: said('m'),
    submittedSourceSaid: said('a'),
    verificationSourceSaid: said('a'),
    executableSaid: said('e'),
    buildReceiptSaid: said('b'),
    buildCleanupReceiptSaid: said('c'),
    publicCases: [
      {
        conditionId: 'public-api',
        verdict: 'Pass',
        rawObservationSaid: said('r'),
        cleanupReceiptSaid: said('q'),
      },
    ],
    terminalCaseArtifactSaid: said('f'),
    encryptedObservationSaid: said('o'),
    terminalCleanupReceiptSaid: said('z'),
    terminalVerdict: 'Pass',
    verdict: 'Pass',
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('artifact');
  const run: RunProjection = {
    ...initial,
    runVersion: 5,
    lifecycle: { kind: 'Ended', outcome: { kind: 'Submitted', checkpointSaid: said('k') } },
    submissionVerification: { kind: 'Accepted' },
    currentExecution: {
      harnessRevisionSaid: said('h'),
      segmentSaid: said('s'),
      evidenceStreamId: '11111111-1111-4111-8111-111111111111',
    },
    lease: {
      kind: 'Held',
      incarnationId: '22222222-2222-4222-8222-222222222222',
      segmentSaid: said('s'),
      acquiredAt: '2026-09-24T20:01:00.000Z',
      expiresAt: '2026-09-24T20:01:45.000Z',
      lastChange: { kind: 'Replaced', fromRunVersion: 3, segmentSaid: said('s') },
    },
  };
  const custody = {
    stream: {
      runId,
      evidenceStreamId: run.currentExecution?.evidenceStreamId,
      seal: { kind: 'Sealed' },
      cursor: { kind: 'Accepted', acceptedThroughSequence: 1 },
    },
    checkpoint: {
      d: said('k'),
      runState: {
        kind: 'Ended',
        outcome: { kind: 'Submitted' },
        verification: { kind: 'Accepted' },
      },
      outputArtifactSaids: [artifact.artifact.d],
    },
    artifacts: [{ artifact: artifact.artifact, bytes }],
    events: [
      {
        sequence: 0,
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'ResultSubmitted', artifactSaids: [said('a')] },
      },
      {
        sequence: 1,
        producer: { kind: 'ProtectedTaskVerifier' },
        event: { kind: 'Observation', artifactSaid: artifact.artifact.d },
      },
    ],
  } as unknown as RunPredecessorCustody;
  return { run, custody };
}

afterEach(() => vi.restoreAllMocks());
it('fresh verification reads the submitted successor stream and never falls back to the original incarnation', async () => {
  const { run, custody } = fixture();
  expect(decodeRunProjection(run).kind).toBe('Accepted');
  const read = vi
    .spyOn(SqliteEvidenceOutboxes.prototype, 'readSubmission')
    .mockReturnValue({ kind: 'Read', custody });
  const inspect = vi.fn<HostedRunTimelines['inspect']>().mockImplementation((_id, query) =>
    Promise.resolve(
      query.evidenceStreamId === run.currentExecution?.evidenceStreamId
        ? ({
            kind: 'Found',
            page: {
              stream: custody.stream,
              events: custody.events.map((event) => ({ event })),
              nextCursor: null,
            },
          } as Awaited<ReturnType<HostedRunTimelines['inspect']>>)
        : { kind: 'ServerUnavailable' },
    ),
  );
  const task = { ...taskProjectionFixture(), lifecycle: { kind: 'Completed' as const } };
  const result = await new TaskTerminalVerificationComposition('/unused').verify(
    {
      ownerAid: task.ownerAid,
      task,
      runId: run.runId,
      runs: { inspect: () => Promise.resolve({ kind: 'Found', run }) },
      evidence: { inspect },
      protectedCredentials: new ProtectedCredentials(),
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ kind: 'Verified', runId: run.runId });
  expect(inspect).toHaveBeenCalledWith(run.runId, {
    limit: 100,
    evidenceStreamId: run.currentExecution?.evidenceStreamId,
  });
  expect(read).toHaveBeenCalledOnce();
});

it.each(['original', 'foreign'] as const)(
  'rejects a %s stream before reading terminal custody',
  async (substitution) => {
    const { run, custody } = fixture();
    const read = vi
      .spyOn(SqliteEvidenceOutboxes.prototype, 'readSubmission')
      .mockReturnValue({ kind: 'Read', custody });
    const inspect = vi.fn<HostedRunTimelines['inspect']>().mockResolvedValue({
      kind: 'Found',
      page: {
        stream: {
          ...custody.stream,
          evidenceStreamId:
            substitution === 'original'
              ? run.evidenceStreamId
              : '33333333-3333-4333-8333-333333333333',
        },
        events: custody.events.map((event) => ({ event })),
        nextCursor: null,
      },
    } as Awaited<ReturnType<HostedRunTimelines['inspect']>>);
    const task = { ...taskProjectionFixture(), lifecycle: { kind: 'Completed' as const } };
    expect(
      await new TaskTerminalVerificationComposition('/unused').verify(
        {
          ownerAid: task.ownerAid,
          task,
          runId: run.runId,
          runs: { inspect: () => Promise.resolve({ kind: 'Found', run }) },
          evidence: { inspect },
          protectedCredentials: new ProtectedCredentials(),
        },
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'Rejected' });
    expect(read).not.toHaveBeenCalled();
  },
);
