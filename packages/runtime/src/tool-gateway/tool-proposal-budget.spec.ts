import { describe, expect, it } from 'vitest';

import { createRun, taskBudgetCeilings } from '@devrandom/domain';
import { prepareEvidenceEvent } from '@devrandom/protocol';

import type {
  EvidenceBudgetDebit,
  EvidenceObservation,
  EvidenceRecording,
} from '../evidence/evidence-recorder.js';
import { RunResourceBudget } from '../run/run-resource-budget.js';
import type { ToolProposalBudget } from './tool-gateway.js';
import { ToolProposalBudgetLedger } from './tool-proposal-budget.js';

function run(toolProposals: number) {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: `E${'o'.repeat(43)}`,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: `E${'t'.repeat(43)}`,
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: `E${'a'.repeat(43)}`,
    taskMandateSaid: `E${'m'.repeat(43)}`,
    governorAid: `E${'g'.repeat(43)}`,
    promotionMandateSaid: `E${'p'.repeat(43)}`,
    initialHarnessRevisionSaid: `E${'h'.repeat(43)}`,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: `E${'h'.repeat(43)}`,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
    },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: `E${'x'.repeat(43)}`,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: { ...taskBudgetCeilings, toolProposals },
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error('Run fixture must be created');
  return created.run;
}

function evidence(runFixture: ReturnType<typeof run>, events: EvidenceObservation[]) {
  let sequence = 0;
  let previousEventSaid: string | undefined;
  return {
    recordBudgetDebit(input: EvidenceBudgetDebit): EvidenceRecording {
      let recorded: EvidenceRecording = { kind: 'ObservationRejected' };
      for (const event of input.debits) {
        recorded = this.record({ occurredAt: input.occurredAt, producer: input.producer, event });
        if (recorded.kind !== 'Recorded') return recorded;
      }
      return recorded;
    },
    record(observation: EvidenceObservation): EvidenceRecording {
      events.push(observation);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          previousEventSaid === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previousEventSaid },
        taskId: runFixture.binding.taskId,
        taskRevisionSaid: runFixture.binding.taskRevisionSaid,
        runId: runFixture.binding.runId,
        incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
        harnessRevisionSaid: runFixture.binding.initialHarnessRevisionSaid,
        personalAgentAid: runFixture.binding.personalAgentAid,
        taskMandateSaid: runFixture.binding.taskMandateSaid,
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      if (prepared.kind !== 'Prepared') return { kind: 'ObservationRejected' };
      sequence += 1;
      previousEventSaid = prepared.event.d;
      return { kind: 'Recorded', event: prepared.event };
    },
  };
}

const reservation: Parameters<ToolProposalBudget['reserve']>[0] = {
  runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
  tool: 'read_file',
  requiredCapability: 'ReadRepository',
};

describe('Tool proposal budget ledger', () => {
  it('durably debits one exact proposal and never reserves beyond the Run ceiling', async () => {
    const runFixture = run(1);
    const events: EvidenceObservation[] = [];
    const account = new RunResourceBudget({
      run: runFixture,
      evidence: evidence(runFixture, events),
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const budget = new ToolProposalBudgetLedger(account);

    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'Reserved' });
    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'Exhausted' });
    expect(events).toEqual([
      {
        occurredAt: '2026-09-24T20:00:02.000Z',
        producer: { kind: 'ToolGateway' },
        event: { kind: 'BudgetDebited', budget: 'toolProposals', amount: 1, consumed: 1 },
      },
    ]);
    expect(account.snapshot().toolProposals).toBe(1);
  });

  it('does not debit when the evidence outbox cannot retain the reservation', async () => {
    const runFixture = run(2);
    let recording: EvidenceRecording = { kind: 'OutboxBackpressure' };
    const events: EvidenceObservation[] = [];
    const account = new RunResourceBudget({
      run: runFixture,
      evidence: {
        recordBudgetDebit(input) {
          events.push(
            ...input.debits.map((event) => ({
              occurredAt: input.occurredAt,
              producer: input.producer,
              event,
            })),
          );
          return recording;
        },
      },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const budget = new ToolProposalBudgetLedger(account);

    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'OutboxBackpressure' });
    const retainedObservation = events[0];
    if (retainedObservation === undefined) {
      throw new Error('The attempted debit observation must be retained by the test recorder');
    }
    recording = evidence(runFixture, []).record(retainedObservation);
    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'Reserved' });
    expect(events.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'toolProposals', amount: 1, consumed: 1 },
      { kind: 'BudgetDebited', budget: 'toolProposals', amount: 1, consumed: 1 },
    ]);
  });

  it('continues monotonically from the Run consumed budget', async () => {
    const created = run(2);
    const runFixture = {
      ...created,
      consumedBudget: { ...created.consumedBudget, toolProposals: 1 },
    };
    const events: EvidenceObservation[] = [];
    const account = new RunResourceBudget({
      run: runFixture,
      evidence: evidence(runFixture, events),
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const budget = new ToolProposalBudgetLedger(account);

    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'Reserved' });
    await expect(budget.reserve(reservation)).resolves.toEqual({ kind: 'Exhausted' });
    expect(events.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'toolProposals', amount: 1, consumed: 2 },
    ]);
  });
});
