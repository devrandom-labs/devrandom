import { describe, expect, it } from 'vitest';

import { acquireFirstRunLease, createEvidenceStream } from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  prepareVerifiedCheckpoint,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';

import { runFixture } from '../test/run-fixture.js';
import { verifyContinuationPredecessor } from './verify-continuation-predecessor.js';

const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const at = '2026-09-24T20:00:01.000Z';

function fixture(extraBeforeCheckpoint: readonly EvidenceEventDetail[] = []) {
  const initial = runFixture();
  const leased = acquireFirstRunLease(initial, {
    incarnationId,
    expectedRunVersion: initial.version,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('lease fixture');
  const events: EvidenceEvent[] = [];
  function add(detail: EvidenceEventDetail) {
    const sequence = events.length;
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence,
      predecessor:
        sequence === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: events[sequence - 1]?.d ?? '' },
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      personalAgentAid: initial.binding.personalAgentAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      occurredAt: at,
      recordedAt: at,
      producer: { kind: 'RunSupervisor' },
      event: detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('event fixture');
    events.push(prepared.event);
  }
  add({ kind: 'RunStarted', fromRunVersion: leased.run.version });
  add({ kind: 'IncarnationStarted' });
  for (const detail of extraBeforeCheckpoint) add(detail);
  const head = events.at(-1);
  if (head === undefined) throw new Error('head fixture');
  const preparedCheckpoint = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      harnessLineageId: initial.binding.harnessLineageId,
      personalAgentAid: initial.binding.personalAgentAid,
      governorAid: initial.binding.governorAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      promotionMandateSaid: initial.binding.promotionMandateSaid,
      purpose: initial.binding.purpose,
      repository: {
        objectFormat: 'sha1',
        baseCommit: initial.binding.repository.commit,
        baseTree: initial.binding.repository.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [],
      evidence: {
        eventCount: events.length,
        finalSequence: head.sequence,
        chainHeadSaid: head.d,
      },
      budget: { consumed: leased.run.consumedBudget, remaining: initial.binding.budget },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'CheckpointPause' },
        verification: { kind: 'NotSubmitted' },
      },
      continuation: { kind: 'LaterRuntimeRecoveryRequired' },
    },
    [],
  );
  if (preparedCheckpoint.kind !== 'Prepared') throw new Error('checkpoint fixture');
  const checkpoint = preparedCheckpoint.checkpoint;
  add({ kind: 'RunBlocked', reason: 'CheckpointPause', checkpointSaid: checkpoint.d });
  const last = events.at(-1);
  if (last === undefined) throw new Error('last fixture');
  const run = {
    ...leased.run,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason: 'CheckpointPause' as const,
        checkpointSaid: checkpoint.d,
      },
    },
  };
  const createdStream = createEvidenceStream({
    streamId: initial.binding.evidenceStreamId,
    runId: initial.binding.runId,
    ownerAid: initial.binding.ownerAid,
    taskId: initial.binding.taskId,
    taskRevisionSaid: initial.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
    personalAgentAid: initial.binding.personalAgentAid,
    taskMandateSaid: initial.binding.taskMandateSaid,
    combinedByteCeiling: initial.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (createdStream.kind !== 'Created') throw new Error('stream fixture');
  const stream = {
    ...createdStream.stream,
    cursor: { kind: 'Continued' as const, acceptedThrough: last.sequence, chainHeadSaid: last.d },
    provisional: {
      kind: 'Checkpointed' as const,
      checkpointSaid: checkpoint.d,
      lifecycle: run.lifecycle,
      submissionVerification: run.submissionVerification,
    },
    seal: { kind: 'Sealed' as const, exchangeSaid: `E${'s'.repeat(43)}`, sealedAt: at },
  };
  return {
    run,
    stream,
    checkpoint,
    events,
    sealExchangeSaid: stream.seal.exchangeSaid,
    chainHeadSaid: last.d,
    completionConditionIds: [],
  };
}

describe('sealed predecessor replay for same-Run continuation', () => {
  it('requires exact sealed checkpoint/head and rejects a pending authorized effect', () => {
    const intact = fixture();
    expect(verifyContinuationPredecessor(intact)).toBe('Verified');
    expect(verifyContinuationPredecessor({ ...intact, chainHeadSaid: `E${'x'.repeat(43)}` })).toBe(
      'Rejected',
    );
    expect(
      verifyContinuationPredecessor({
        ...intact,
        stream: { ...intact.stream, seal: { kind: 'Open' } },
      }),
    ).toBe('Rejected');
    const pending = fixture([
      {
        kind: 'ToolAuthorized',
        piSessionId: incarnationId,
        modelTurnId: 'turn-1',
        toolCallId: 'tool-1',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'cargo test',
        mandateSaid: runFixture().binding.taskMandateSaid,
      },
    ]);
    expect(verifyContinuationPredecessor(pending)).toBe('Rejected');
  });
});
