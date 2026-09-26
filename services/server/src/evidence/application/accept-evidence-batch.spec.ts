import { acquireFirstRunLease } from '@devrandom/domain';
import {
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  type EvidenceEvent,
  type EvidenceEventDraft,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { runFixture } from '../../run/test/run-fixture.js';
import { acceptEvidenceBatch } from './accept-evidence-batch.js';
import type { EvidenceBatches } from './evidence-batches.js';
import type { EvidenceRunContexts } from './evidence-run-contexts.js';

const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';
const recordedAt = '2026-09-24T20:00:20.000Z';
const receivedAt = '2026-09-24T20:01:01.000Z';

function eventDraft(
  event: EvidenceEventDraft['event'],
  sequence = 0,
  predecessor: EvidenceEventDraft['predecessor'] = { kind: 'Genesis' },
): EvidenceEventDraft {
  const run = runFixture();
  return {
    version: 1,
    sequence,
    predecessor,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    runId: run.binding.runId,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    occurredAt: recordedAt,
    recordedAt,
    producer: { kind: 'RunSupervisor' },
    event,
  };
}

function command() {
  const first = prepareEvidenceEvent(
    eventDraft({
      kind: 'ModelRequest',
      piSessionId: '26e450d5-245f-4a48-ae74-fc27f908a4d4',
      modelTurnId: 'turn-1',
      provider: 'deepseek',
      model: 'deepseek-flash',
      maximumOutputTokens: 1_024,
    }),
  );
  if (first.kind !== 'Prepared') {
    throw new Error('expected a valid first event');
  }
  const second = prepareEvidenceEvent(
    eventDraft(
      {
        kind: 'EffectCompleted',
        piSessionId: '26e450d5-245f-4a48-ae74-fc27f908a4d4',
        modelTurnId: 'turn-1',
        toolCallId: 'tool-1',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'just test',
        outputArtifactSaids: [],
      },
      1,
      { kind: 'Previous', eventSaid: first.event.d },
    ),
  );
  if (second.kind !== 'Prepared') {
    throw new Error('expected a valid second event');
  }
  const events: [EvidenceEvent, EvidenceEvent] = [first.event, second.event];
  const run = runFixture();
  const prepared = prepareEvidenceBatch({
    version: 1,
    runId: run.binding.runId,
    evidenceStreamId: run.binding.evidenceStreamId,
    events,
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('expected a valid batch');
  }
  return {
    ownerAid: run.binding.ownerAid,
    parameters: { runId: run.binding.runId, batchSaid: prepared.batch.d },
    body: { version: 1 as const, batch: prepared.batch, events },
    receivedAt,
  };
}

function contexts(): EvidenceRunContexts {
  const acquired = acquireFirstRunLease(runFixture(), {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('expected a held Run lease');
  }
  return {
    inspect: vi.fn().mockResolvedValue({
      kind: 'EvidenceRunContextFound',
      run: acquired.run,
      completionConditionIds: ['public-test'],
    }),
  };
}

function batches() {
  const accept = vi.fn<EvidenceBatches['accept']>().mockResolvedValue({
    kind: 'EvidenceBatchAccepted',
    acknowledgement: {
      version: 1,
      disposition: { kind: 'Accepted' },
      runId: runFixture().binding.runId,
      evidenceStreamId: runFixture().binding.evidenceStreamId,
      batchSaid: command().body.batch.d,
      acceptedThroughSequence: 1,
      chainHeadSaid: command().body.events[1].d,
      receivedAt,
    },
  });
  const storage: EvidenceBatches = { accept };
  return { storage, accept };
}

describe('accept evidence batch', () => {
  it('rechecks Task Mandate authority at each recorded effect time before durable acceptance', async () => {
    const input = command();
    const { storage, accept } = batches();
    const authorize = vi.fn().mockResolvedValue({ kind: 'CurrentTaskMandateAuthorized' });

    const outcome = await acceptEvidenceBatch(input, {
      contexts: contexts(),
      authority: { authorize },
      batches: storage,
    });

    expect(outcome.kind).toBe('EvidenceBatchAccepted');
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ownerAid: input.ownerAid,
        taskMandateSaid: runFixture().binding.taskMandateSaid,
        observedAt: input.body.events[0].recordedAt,
      }),
    );
    expect(authorize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ observedAt: input.body.events[1].recordedAt }),
    );
    expect(accept).toHaveBeenCalledOnce();
  });

  it('rejects a historically unauthorized effect before storage', async () => {
    const { storage, accept } = batches();
    const outcome = await acceptEvidenceBatch(command(), {
      contexts: contexts(),
      authority: {
        authorize: vi.fn().mockResolvedValue({ kind: 'TaskMandateExpired' }),
      },
      batches: storage,
    });

    expect(outcome).toEqual({
      kind: 'EvidenceBatchRejected',
      reason: 'EventBindingMismatch',
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it('rejects a cross-Run event before authority inspection or storage', async () => {
    const input = command();
    const crossRunEvent = {
      ...input.body.events[0],
      runId: 'b5969d21-ea62-4d7e-a875-ab996a01ec21',
    };
    const authority = { authorize: vi.fn() };
    const { storage, accept } = batches();

    const outcome = await acceptEvidenceBatch(
      { ...input, body: { ...input.body, events: [crossRunEvent, input.body.events[1]] } },
      { contexts: contexts(), authority, batches: storage },
    );

    expect(outcome).toEqual({ kind: 'EvidenceBatchRejected', reason: 'BatchSaidMismatch' });
    expect(authority.authorize).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
});
