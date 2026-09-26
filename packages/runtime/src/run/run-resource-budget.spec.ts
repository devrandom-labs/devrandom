import { createRun, taskBudgetCeilings, type Run } from '@devrandom/domain';
import { prepareEvidenceEvent } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import type { EvidenceObservation, EvidenceRecording } from '../evidence/evidence-recorder.js';
import { RunResourceBudget } from './run-resource-budget.js';

function runWithToolConsumption(consumedToolProposals: number): Run {
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
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: `E${'x'.repeat(43)}`,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: { ...taskBudgetCeilings, toolProposals: 2 },
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error('budget fixture Run must be created');
  return {
    ...created.run,
    consumedBudget: {
      ...created.run.consumedBudget,
      toolProposals: consumedToolProposals,
    },
  };
}

function recorded(run: Run, observation: EvidenceObservation, sequence: number): EvidenceRecording {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor:
      sequence === 0 ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: `E${'z'.repeat(43)}` },
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    runId: run.binding.runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    occurredAt: observation.occurredAt,
    recordedAt: observation.occurredAt,
    producer: observation.producer,
    event: observation.event,
  });
  return prepared.kind === 'Prepared'
    ? { kind: 'Recorded', event: prepared.event }
    : { kind: 'ObservationRejected' };
}

describe('monotonic Run resource budget', () => {
  it('closes an unchanged worktree without inventing a zero-usage evidence event', () => {
    const run = runWithToolConsumption(0);
    const budget = new RunResourceBudget({
      run,
      now: () => '2026-09-24T20:00:02.000Z',
      evidence: {
        recordBudgetDebit: () => {
          throw new Error('No debit is due');
        },
      },
    });
    expect(
      budget.settle({
        producer: { kind: 'EvidenceRecorder' },
        actual: [
          { budget: 'changedFiles', amount: 0 },
          { budget: 'changedWorktreeBytes', amount: 0 },
        ],
      }),
    ).toEqual({ kind: 'Settled' });
    expect(budget.snapshot()).toEqual(run.consumedBudget);
    expect(budget.reserve([{ budget: 'providerRequests', amount: 1 }])).toEqual({
      kind: 'ReservationInvalid',
    });
  });

  it('settles incurred excess atomically without granting new effect admission', () => {
    const base = runWithToolConsumption(0);
    const run = {
      ...base,
      binding: {
        ...base.binding,
        budget: { ...base.binding.budget, changedFiles: 0, changedWorktreeBytes: 0 },
      },
    };
    let recording: 'Unavailable' | 'Recordable' = 'Unavailable';
    let attempts = 0;
    const observations: EvidenceObservation[] = [];
    const budget = new RunResourceBudget({
      run,
      now: () => '2026-09-24T20:00:02.000Z',
      evidence: {
        recordBudgetDebit(input) {
          attempts += 1;
          expect(budget.snapshot().changedFiles).toBe(0);
          expect(budget.snapshot().changedWorktreeBytes).toBe(0);
          if (recording === 'Unavailable') return { kind: 'Unavailable' };
          const entries = input.debits.map((event) => ({
            occurredAt: input.occurredAt,
            producer: input.producer,
            event,
          }));
          observations.push(...entries);
          const last = entries.at(-1);
          if (last === undefined) throw new Error('expected both incurred dimensions');
          return recorded(run, last, entries.length - 1);
        },
      },
    });
    const input = {
      producer: { kind: 'EvidenceRecorder' as const },
      actual: [
        { budget: 'changedFiles' as const, amount: 1 },
        { budget: 'changedWorktreeBytes' as const, amount: 20 },
      ],
    };
    const held = budget.reserve([{ budget: 'providerRequests', amount: 1 }]);
    if (held.kind !== 'Reserved') throw new Error('provider reservation must fit');
    expect(budget.settle(input)).toEqual({ kind: 'SettlementRejected' });
    expect(attempts).toBe(0);
    expect(budget.release(held.reservation)).toEqual({ kind: 'Released' });
    expect(budget.settle(input)).toEqual({ kind: 'Unavailable' });
    expect(budget.snapshot()).toEqual(run.consumedBudget);
    recording = 'Recordable';
    expect(budget.settle(input)).toEqual({ kind: 'Exhausted', budget: 'changedFiles' });
    expect(budget.snapshot()).toEqual({
      ...run.consumedBudget,
      changedFiles: 1,
      changedWorktreeBytes: 20,
    });
    expect(run.binding.budget.changedFiles).toBe(0);
    expect(run.binding.budget.changedWorktreeBytes).toBe(0);
    expect(budget.reserve([{ budget: 'providerRequests', amount: 1 }])).toEqual({
      kind: 'ReservationInvalid',
    });
    expect(budget.settle(input)).toEqual({ kind: 'SettlementRejected' });
    expect(attempts).toBe(2);
    expect(observations.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'changedFiles', amount: 1, consumed: 1 },
      { kind: 'BudgetDebited', budget: 'changedWorktreeBytes', amount: 20, consumed: 20 },
    ]);
  });

  it('reserves against consumed plus held amounts and records before consuming', () => {
    const run = runWithToolConsumption(1);
    const observations: EvidenceObservation[] = [];
    const resourceBudget = new RunResourceBudget({
      run,
      evidence: {
        recordBudgetDebit(input) {
          const entries = input.debits.map((event) => ({
            occurredAt: input.occurredAt,
            producer: input.producer,
            event,
          }));
          observations.push(...entries);
          const observation = entries.at(-1);
          if (observation === undefined) return { kind: 'ObservationRejected' };
          expect(resourceBudget.snapshot().toolProposals).toBe(1);
          return recorded(run, observation, observations.length - 1);
        },
      },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const first = resourceBudget.reserve([{ budget: 'toolProposals', amount: 1 }]);
    expect(first.kind).toBe('Reserved');
    expect(resourceBudget.reserve([{ budget: 'toolProposals', amount: 1 }])).toEqual({
      kind: 'Exhausted',
      budget: 'toolProposals',
    });
    if (first.kind !== 'Reserved') throw new Error('first reservation must fit');
    expect(
      resourceBudget.commit(first.reservation, {
        producer: { kind: 'ToolGateway' },
        actual: [{ budget: 'toolProposals', amount: 1 }],
      }),
    ).toEqual({ kind: 'Committed' });

    const snapshot = resourceBudget.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.toolProposals).toBe(2);
    expect(observations.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'toolProposals', amount: 1, consumed: 2 },
    ]);
  });

  it('releases a reservation without consuming when evidence cannot retain the debit', () => {
    const run = runWithToolConsumption(0);
    let recording: EvidenceRecording = { kind: 'OutboxBackpressure' };
    const budget = new RunResourceBudget({
      run,
      evidence: { recordBudgetDebit: () => recording },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const reservation = budget.reserve([{ budget: 'providerRequests', amount: 1 }]);
    if (reservation.kind !== 'Reserved') throw new Error('provider reservation must fit');

    expect(
      budget.commit(reservation.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: [{ budget: 'providerRequests', amount: 1 }],
      }),
    ).toEqual({ kind: 'OutboxBackpressure' });
    expect(budget.snapshot().providerRequests).toBe(0);

    recording = recorded(
      run,
      {
        occurredAt: '2026-09-24T20:00:02.000Z',
        producer: { kind: 'PiExecutor' },
        event: { kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 },
      },
      0,
    );
    expect(budget.reserve([{ budget: 'providerRequests', amount: 1 }]).kind).toBe('Reserved');
  });

  it('retains actual usage above the Run ceiling and rejects further reservation', () => {
    const run = runWithToolConsumption(0);
    const observations: EvidenceObservation[] = [];
    const budget = new RunResourceBudget({
      run,
      evidence: {
        recordBudgetDebit(input) {
          const entries = input.debits.map((event) => ({
            occurredAt: input.occurredAt,
            producer: input.producer,
            event,
          }));
          observations.push(...entries);
          const observation = entries.at(-1);
          if (observation === undefined) return { kind: 'ObservationRejected' };
          return recorded(run, observation, observations.length - 1);
        },
      },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const reservation = budget.reserve([{ budget: 'providerOutputTokens', amount: 2_000 }]);
    if (reservation.kind !== 'Reserved') throw new Error('reservation must fit');
    const amount = run.binding.budget.providerOutputTokens + 1;
    expect(
      budget.commit(reservation.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: [{ budget: 'providerOutputTokens', amount }],
      }),
    ).toEqual({ kind: 'Exhausted', budget: 'providerOutputTokens' });
    expect(budget.snapshot()).toEqual({ ...run.consumedBudget, providerOutputTokens: amount });
    expect(observations.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'providerOutputTokens', amount, consumed: amount },
    ]);
    expect(budget.reserve([{ budget: 'providerOutputTokens', amount: 1 }])).toEqual({
      kind: 'Exhausted',
      budget: 'providerOutputTokens',
    });
  });

  it('records actual usage above its reservation before stopping further execution', () => {
    const run = runWithToolConsumption(0);
    const observations: EvidenceObservation[] = [];
    const budget = new RunResourceBudget({
      run,
      evidence: {
        recordBudgetDebit(input) {
          const entries = input.debits.map((event) => ({
            occurredAt: input.occurredAt,
            producer: input.producer,
            event,
          }));
          observations.push(...entries);
          const observation = entries.at(-1);
          if (observation === undefined) return { kind: 'ObservationRejected' };
          return recorded(run, observation, observations.length - 1);
        },
      },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const reservation = budget.reserve([
      { budget: 'providerInputTokens', amount: 10 },
      { budget: 'providerRequests', amount: 1 },
    ]);
    if (reservation.kind !== 'Reserved') throw new Error('input reservation must fit');

    expect(
      budget.commit(reservation.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: [
          { budget: 'providerInputTokens', amount: 11 },
          { budget: 'providerRequests', amount: 1 },
        ],
      }),
    ).toEqual({ kind: 'Exhausted', budget: 'providerInputTokens' });
    expect(budget.snapshot()).toEqual({
      ...run.consumedBudget,
      providerInputTokens: 11,
      providerRequests: 1,
    });
    expect(observations.map(({ event }) => event)).toEqual([
      { kind: 'BudgetDebited', budget: 'providerInputTokens', amount: 11, consumed: 11 },
      { kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 },
    ]);
  });
});
