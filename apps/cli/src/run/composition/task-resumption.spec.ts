import { expect, it, vi } from 'vitest';
import { decodeRunProjection } from '@devrandom/protocol';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { RunContinuationFile } from '../infrastructure/run-continuation-file.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { TaskResumptionComposition, type TaskResumptionInput } from './task-resumption.js';
import type { LinuxRunSupervisorCompositionOptions } from './linux-run-supervisor.js';

it('retains the existing H2 pending-admission lookup without requiring the calibration reclaim capability', async () => {
  const initial = runProjectionFixture();
  const segmentSaid = `E${'s'.repeat(43)}`;
  const run = {
    ...initial,
    runVersion: 4,
    currentExecution: {
      segmentSaid,
      evidenceStreamId: '11111111-1111-4111-8111-111111111111',
      harnessRevisionSaid: `E${'h'.repeat(43)}`,
    },
    lease: {
      kind: 'Held' as const,
      incarnationId: '22222222-2222-4222-8222-222222222222',
      segmentSaid,
      acquiredAt: '2026-09-24T20:01:00.000Z',
      expiresAt: '2026-09-24T20:01:45.000Z',
      lastChange: { kind: 'Replaced' as const, fromRunVersion: 3, segmentSaid },
    },
  };
  expect(decodeRunProjection(run).kind).toBe('Accepted');
  const read = vi
    .spyOn(RunContinuationFile.prototype, 'readPredecessor')
    .mockResolvedValue(undefined);
  const readSuccessorSegment = vi.fn();
  try {
    const composition = new TaskResumptionComposition({
      stateRoot: '/unused',
    } as LinuxRunSupervisorCompositionOptions);
    await composition.resume(
      {
        runId: run.runId,
        runs: { inspect: () => Promise.resolve({ kind: 'Found', run }), readSuccessorSegment },
      } as unknown as TaskResumptionInput,
      new AbortController().signal,
    );
    expect(read).toHaveBeenCalledWith(run.runId, 3);
    expect(readSuccessorSegment).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it('requests the current successor stream when resuming a context-blocked calibration', async () => {
  const initial = runProjectionFixture();
  const task = taskProjectionFixture();
  const segmentSaid = `E${'s'.repeat(43)}`;
  const successorStreamId = '11111111-1111-4111-8111-111111111111';
  const run = {
    ...initial,
    purpose: {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: '33333333-3333-4333-8333-333333333333',
      ordinal: 1 as const,
    },
    activation: { ...initial.activation, runId: initial.runId, acceptedAt: initial.acceptedAt },
    runVersion: 4,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason: 'ContextLimitReached' as const,
        checkpointSaid: `E${'c'.repeat(43)}`,
      },
    },
    currentExecution: {
      segmentSaid,
      evidenceStreamId: successorStreamId,
      harnessRevisionSaid: initial.harnessRevisionSaid,
    },
    lease: {
      kind: 'Held' as const,
      incarnationId: '22222222-2222-4222-8222-222222222222',
      segmentSaid,
      acquiredAt: '2026-09-24T20:01:00.000Z',
      expiresAt: '2026-09-24T20:01:45.000Z',
      lastChange: { kind: 'Replaced' as const, fromRunVersion: 3, segmentSaid },
    },
  };
  expect(decodeRunProjection(run).kind).toBe('Accepted');
  const inspectEvidence = vi.fn(() =>
    Promise.resolve({
      kind: 'Found' as const,
      page: {
        stream: { cursor: { kind: 'Accepted', acceptedThroughSequence: 0 } },
        events: [{ event: { sequence: 0 } }],
        nextCursor: null,
      },
    }),
  );
  const retained = vi
    .spyOn(RunContinuationFile.prototype, 'retainPredecessor')
    .mockResolvedValue('Recorded');
  const local = vi
    .spyOn(SqliteEvidenceOutboxes.prototype, 'readPredecessor')
    .mockReturnValue({ kind: 'Rejected' });
  try {
    const composition = new TaskResumptionComposition({
      stateRoot: '/unused',
    } as LinuxRunSupervisorCompositionOptions);
    const result = await composition.resume(
      {
        runId: run.runId,
        runs: { inspect: () => Promise.resolve({ kind: 'Found', run }) },
        evidence: { inspect: inspectEvidence },
        preparation: {
          task,
          executionAuthority: { personalAgentAid: run.personalAgentAid },
          mandates: {
            taskMandate: { credentialSaid: run.taskMandateSaid },
            promotionMandate: { credentialSaid: run.promotionMandateSaid },
            governor: { aid: run.governorAid },
          },
          harness: { projection: { revision: { d: run.harnessRevisionSaid } } },
        },
      } as unknown as TaskResumptionInput,
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: 'PredecessorRejected' });
    expect(inspectEvidence).toHaveBeenCalledWith(run.runId, {
      limit: 100,
      evidenceStreamId: successorStreamId,
    });
  } finally {
    retained.mockRestore();
    local.mockRestore();
  }
});
