import { acquireFirstRunLease, createEvidenceStream, createRun } from '@devrandom/domain';
import {
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  prepareVerifiedCheckpoint,
  preparePublicVerifierReceipt,
  taskBudgetCeilings,
  type AppendEvidenceBatchBody,
  type EvidenceEventDetail,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { assessTerminalCalibrationBatch } from './terminal-calibration-reconciliation.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';
const recordedAt = '2026-09-24T20:01:00.000Z';

function fixture() {
  const created = createRun({
    runId,
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('d'),
    harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
    personalAgentAid: said('e'),
    taskMandateSaid: said('f'),
    governorAid: said('g'),
    promotionMandateSaid: said('h'),
    initialHarnessRevisionSaid: said('b'),
    purpose: {
      kind: 'PreparedCompatibilityCalibration',
      campaignId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
      ordinal: 2,
    },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
      harnessRevisionSaid: said('b'),
      runId: 'ff6774df-9797-4295-8e74-a974819babec',
      acceptedAt: '2026-09-24T19:55:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    admissionExchangeSaid: said('i'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error(`Run fixture failed: ${created.kind}`);
  const leased = acquireFirstRunLease(created.run, {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (leased.kind !== 'Acquired' || leased.run.lease.kind !== 'Held')
    throw new Error('Lease fixture failed');
  const run = leased.run;
  const stream = createEvidenceStream({
    streamId: run.binding.evidenceStreamId,
    runId,
    ownerAid: run.binding.ownerAid,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    combinedByteCeiling: run.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (stream.kind !== 'Created') throw new Error('Stream fixture failed');
  const started = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    runId,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    occurredAt: '2026-09-24T20:00:10.000Z',
    recordedAt: '2026-09-24T20:00:10.000Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: run.version },
  });
  if (started.kind !== 'Prepared') throw new Error('RunStarted fixture failed');
  const checkpointSaid = said('p');
  const current = {
    ...stream.stream,
    cursor: { kind: 'Continued' as const, acceptedThrough: 3, chainHeadSaid: said('x') },
    provisional: {
      kind: 'Checkpointed' as const,
      checkpointSaid,
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationExcluded' as const,
          reason: 'BudgetExhausted' as const,
          checkpointSaid,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' as const },
    },
  };
  function body(detail: EvidenceEventDetail): AppendEvidenceBatchBody {
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence: 4,
      predecessor: { kind: 'Previous', eventSaid: current.cursor.chainHeadSaid },
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      occurredAt: recordedAt,
      recordedAt,
      producer: { kind: 'EvidenceRecorder' },
      event: detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('Event fixture failed');
    const batch = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: run.binding.evidenceStreamId,
      events: [prepared.event],
    });
    if (batch.kind !== 'Prepared') throw new Error('Batch fixture failed');
    return { version: 1, batch: batch.batch, events: [prepared.event] };
  }
  return { run: run, stream: current, started: started.event, checkpointSaid, body };
}

describe('terminal calibration evidence reconciliation', () => {
  it('accepts only expired-task cancellation bookkeeping without inventing calibration failure', () => {
    const { run, stream, started, body } = fixture();
    const unresolved = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: 'public-test',
      commandSaid: said('c'),
      recordedAt,
      outcome: { kind: 'Unresolved', reason: 'NotAttempted' },
    });
    if (unresolved.kind !== 'Prepared') throw new Error('receipt fixture');
    const checkpoint = prepareVerifiedCheckpoint(
      {
        version: 1,
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId,
        incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        harnessLineageId: run.binding.harnessLineageId,
        personalAgentAid: run.binding.personalAgentAid,
        governorAid: run.binding.governorAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        promotionMandateSaid: run.binding.promotionMandateSaid,
        purpose: run.binding.purpose,
        repository: {
          objectFormat: 'sha1',
          baseCommit: run.binding.repository.commit,
          baseTree: run.binding.repository.tree,
          changedFiles: [],
        },
        outputArtifactSaids: [],
        verifierReceipts: [unresolved.receipt],
        evidence: { eventCount: 4, finalSequence: 3, chainHeadSaid: stream.cursor.chainHeadSaid },
        budget: { consumed: run.consumedBudget, remaining: run.binding.budget },
        runState: {
          kind: 'Ended',
          outcome: { kind: 'Cancelled' },
          verification: { kind: 'NotSubmitted' },
        },
        continuation: { kind: 'NoContinuation' },
      },
      ['public-test'],
    );
    if (checkpoint.kind !== 'Prepared')
      throw new Error(`cancelled checkpoint fixture: ${checkpoint.reason}`);
    const input = {
      run,
      stream: { ...stream, provisional: { kind: 'None' as const } },
      runStarted: started,
      acceptedBudget: run.consumedBudget,
      completionConditionIds: ['public-test'],
      expected: {
        incarnationId,
        runStartedSaid: started.d,
        acceptedThroughSequence: 3,
        chainHeadSaid: stream.cursor.chainHeadSaid,
      },
      taskExpiresAt: '2026-09-24T20:00:30.000Z',
      acceptedSubmission: false,
      body: {
        ...body({ kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d }),
        checkpoint: checkpoint.checkpoint,
      },
      receivedAt: '2026-09-24T20:01:01.000Z',
    };
    expect(assessTerminalCalibrationBatch(input)).toEqual({
      kind: 'Accepted',
      phase: 'Checkpoint',
    });
    expect(
      assessTerminalCalibrationBatch({ ...input, taskExpiresAt: '2026-09-24T21:00:00.000Z' }).kind,
    ).toBe('Rejected');
    expect(assessTerminalCalibrationBatch({ ...input, acceptedSubmission: true }).kind).toBe(
      'Rejected',
    );
    expect(
      assessTerminalCalibrationBatch({
        ...input,
        acceptedBudget: { ...run.consumedBudget, providerRequests: 1 },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'BudgetMismatch' });
    const ackStream = {
      ...stream,
      provisional: {
        kind: 'Checkpointed' as const,
        checkpointSaid: checkpoint.checkpoint.d,
        lifecycle: {
          kind: 'Ended' as const,
          outcome: { kind: 'Cancelled' as const, checkpointSaid: checkpoint.checkpoint.d },
        },
        submissionVerification: { kind: 'NotSubmitted' as const },
      },
    };
    expect(
      assessTerminalCalibrationBatch({
        ...input,
        stream: ackStream,
        body: body({ kind: 'CheckpointAccepted', checkpointSaid: checkpoint.checkpoint.d }),
      }),
    ).toEqual({ kind: 'Accepted', phase: 'Acknowledgement' });
  });

  it('binds a real over-ceiling checkpoint to only measured debit and terminal markers', () => {
    const { run, stream, started } = fixture();
    const checkpointStream = { ...stream, provisional: { kind: 'None' as const } };
    const overrun = run.binding.budget.changedWorktreeBytes + 1;
    const common = {
      version: 1 as const,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      occurredAt: recordedAt,
      recordedAt,
    };
    const debit = prepareEvidenceEvent({
      ...common,
      sequence: 4,
      predecessor: { kind: 'Previous', eventSaid: stream.cursor.chainHeadSaid },
      producer: { kind: 'EvidenceRecorder' },
      event: {
        kind: 'BudgetDebited',
        budget: 'changedWorktreeBytes',
        amount: overrun,
        consumed: overrun,
      },
    });
    if (debit.kind !== 'Prepared') throw new Error('Debit fixture failed');
    const debitEvent = debit.event;
    const checkpoint = prepareVerifiedCheckpoint(
      {
        version: 1,
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId,
        incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        harnessLineageId: run.binding.harnessLineageId,
        personalAgentAid: run.binding.personalAgentAid,
        governorAid: run.binding.governorAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        promotionMandateSaid: run.binding.promotionMandateSaid,
        purpose: run.binding.purpose,
        repository: {
          objectFormat: 'sha1',
          baseCommit: run.binding.repository.commit,
          baseTree: run.binding.repository.tree,
          changedFiles: [],
        },
        outputArtifactSaids: [],
        verifierReceipts: [],
        evidence: { eventCount: 5, finalSequence: 4, chainHeadSaid: debitEvent.d },
        budget: {
          consumed: { ...run.consumedBudget, changedWorktreeBytes: overrun },
          remaining: { ...run.binding.budget, changedWorktreeBytes: 0 },
        },
        runState: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationExcluded', reason: 'BudgetExhausted' },
          verification: { kind: 'NotSubmitted' },
        },
        continuation: { kind: 'NoContinuation' },
      },
      ['public-test'],
    );
    if (checkpoint.kind !== 'Prepared')
      throw new Error(`Checkpoint fixture failed: ${checkpoint.reason}`);
    if (checkpoint.checkpoint.version !== 1)
      throw new Error('Measured checkpoint fixture required');
    const verified = prepareEvidenceEvent({
      ...common,
      sequence: 5,
      predecessor: { kind: 'Previous', eventSaid: debitEvent.d },
      producer: { kind: 'EvidenceRecorder' },
      event: { kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d },
    });
    if (verified.kind !== 'Prepared') throw new Error('Verified fixture failed');
    const calibration = prepareEvidenceEvent({
      ...common,
      sequence: 6,
      predecessor: { kind: 'Previous', eventSaid: verified.event.d },
      producer: { kind: 'RunSupervisor' },
      event: {
        kind: 'RunCalibrationRecorded',
        checkpointSaid: checkpoint.checkpoint.d,
        disposition: { kind: 'Excluded', reason: 'BudgetExhausted' },
      },
    });
    if (calibration.kind !== 'Prepared') throw new Error('Calibration fixture failed');
    const events = [debitEvent, verified.event, calibration.event];
    const prepared = prepareEvidenceBatch({
      version: 1,
      runId,
      evidenceStreamId: run.binding.evidenceStreamId,
      events,
    });
    if (prepared.kind !== 'Prepared') throw new Error('Batch fixture failed');
    const input = {
      run,
      stream: checkpointStream,
      runStarted: started,
      acceptedBudget: run.consumedBudget,
      completionConditionIds: ['public-test'],
      expected: {
        incarnationId,
        runStartedSaid: started.d,
        acceptedThroughSequence: 3,
        chainHeadSaid: stream.cursor.chainHeadSaid,
      },
      body: {
        version: 1 as const,
        batch: prepared.batch,
        events,
        checkpoint: checkpoint.checkpoint,
      },
      receivedAt: '2026-09-24T20:01:01.000Z',
    };
    expect(assessTerminalCalibrationBatch(input)).toEqual({
      kind: 'Accepted',
      phase: 'Checkpoint',
    });
    // Rebuild every content address, so these fail on binding rather than invalid SAIDs.
    function reboundCheckpoint(draft: VerifiedCheckpoint) {
      const checkpointDraft = { ...draft };
      Reflect.deleteProperty(checkpointDraft, 'd');
      const rebound = prepareVerifiedCheckpoint(checkpointDraft, ['public-test']);
      if (rebound.kind !== 'Prepared') throw new Error('Rebound checkpoint fixture failed');
      const verifiedAgain = prepareEvidenceEvent({
        ...common,
        sequence: 5,
        predecessor: { kind: 'Previous', eventSaid: debitEvent.d },
        producer: { kind: 'EvidenceRecorder' },
        event: { kind: 'CheckpointVerified', checkpointSaid: rebound.checkpoint.d },
      });
      if (verifiedAgain.kind !== 'Prepared') throw new Error('Rebound marker fixture failed');
      const calibratedAgain = prepareEvidenceEvent({
        ...common,
        sequence: 6,
        producer: { kind: 'RunSupervisor' },
        predecessor: { kind: 'Previous', eventSaid: verifiedAgain.event.d },
        event: {
          kind: 'RunCalibrationRecorded',
          checkpointSaid: rebound.checkpoint.d,
          disposition: { kind: 'Excluded', reason: 'BudgetExhausted' },
        },
      });
      if (calibratedAgain.kind !== 'Prepared')
        throw new Error('Rebound disposition fixture failed');
      const reboundEvents = [debitEvent, verifiedAgain.event, calibratedAgain.event];
      const reboundBatch = prepareEvidenceBatch({
        version: 1,
        runId,
        evidenceStreamId: run.binding.evidenceStreamId,
        events: reboundEvents,
      });
      if (reboundBatch.kind !== 'Prepared') throw new Error('Rebound batch fixture failed');
      return {
        ...input,
        body: {
          version: 1 as const,
          batch: reboundBatch.batch,
          events: reboundEvents,
          checkpoint: rebound.checkpoint,
        },
      };
    }
    expect(
      assessTerminalCalibrationBatch(
        reboundCheckpoint({
          ...checkpoint.checkpoint,
          purpose: {
            kind: 'PreparedCompatibilityCalibration',
            campaignId: 'd2c9160a-58f8-4d43-ae67-22124c6e9113',
            ordinal: 2,
          },
        }),
      ),
    ).toEqual({ kind: 'Rejected', reason: 'CheckpointInvalid' });
    expect(
      assessTerminalCalibrationBatch(
        reboundCheckpoint({
          ...checkpoint.checkpoint,
          repository: { ...checkpoint.checkpoint.repository, baseCommit: '3'.repeat(40) },
        }),
      ),
    ).toEqual({ kind: 'Rejected', reason: 'CheckpointInvalid' });

    expect(
      assessTerminalCalibrationBatch({
        ...input,
        acceptedBudget: { ...run.consumedBudget, changedWorktreeBytes: 1 },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'BudgetMismatch' });
    expect(
      assessTerminalCalibrationBatch({
        ...input,
        expected: { ...input.expected, incarnationId: 'cf6774df-9797-4295-8e74-a974819babec' },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'CursorConflict' });
  });

  it('permits only the expired original incarnation to accept its checkpoint acknowledgement', () => {
    const { run, stream, started, checkpointSaid, body } = fixture();
    const input = {
      run,
      stream,
      runStarted: started,
      acceptedBudget: run.consumedBudget,
      completionConditionIds: ['public-test'],
      expected: {
        incarnationId,
        runStartedSaid: started.d,
        acceptedThroughSequence: 3,
        chainHeadSaid: stream.cursor.chainHeadSaid,
      },
      body: body({ kind: 'CheckpointAccepted', checkpointSaid }),
      receivedAt: '2026-09-24T20:01:01.000Z',
    };
    expect(assessTerminalCalibrationBatch(input)).toEqual({
      kind: 'Accepted',
      phase: 'Acknowledgement',
    });
    expect(
      assessTerminalCalibrationBatch({
        ...input,
        expected: { ...input.expected, chainHeadSaid: said('z') },
      }),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      assessTerminalCalibrationBatch({
        ...input,
        body: body({
          kind: 'ToolProposed',
          piSessionId: incarnationId,
          modelTurnId: 'turn-1',
          toolCallId: 'call-1',
          proposalIndex: 0,
          tool: 'run_tests',
          requiredCapability: 'RunTests',
          resource: 'cargo test',
        }),
      }),
    ).toMatchObject({ kind: 'Rejected' });
  });
});
