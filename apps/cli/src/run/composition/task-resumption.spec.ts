import { expect, it, vi } from 'vitest';
import { decodeRunProjection } from '@devrandom/protocol';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { RunContinuationFile } from '../infrastructure/run-continuation-file.js';
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
