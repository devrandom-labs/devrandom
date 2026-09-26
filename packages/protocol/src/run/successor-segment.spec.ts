import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '@devrandom/domain';

import { decodeRunSuccessorSegment, prepareRunSuccessorSegment } from './successor-segment.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function input() {
  return {
    version: 1 as const,
    kind: 'RunSuccessorSegment' as const,
    runId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    fromRunVersion: 3,
    predecessor: {
      incarnationId: '33333333-3333-4333-8333-333333333333',
      evidenceStreamId: '44444444-4444-4444-8444-444444444444',
      checkpointSaid: said('c'),
      sealExchangeSaid: said('s'),
      finalSequence: 12,
      chainHeadSaid: said('h'),
    },
    successor: {
      incarnationId: '55555555-5555-4555-8555-555555555555',
      evidenceStreamId: '66666666-6666-4666-8666-666666666666',
      harnessRevisionSaid: said('r'),
    },
    activation: { pointerVersion: 2, decisionReceiptSaid: said('p') },
    consumedBudget: taskBudgetCeilings,
    admittedAt: '2026-09-26T13:30:00.000Z',
  };
}

describe('immutable same-Run successor segment', () => {
  it('binds predecessor seal, activation, new incarnation and carried budget by SAID', () => {
    const prepared = prepareRunSuccessorSegment(input());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeRunSuccessorSegment(prepared.segment)).toEqual({
      kind: 'Accepted',
      segment: prepared.segment,
    });
    expect(
      decodeRunSuccessorSegment({
        ...prepared.segment,
        predecessor: { ...prepared.segment.predecessor, checkpointSaid: said('x') },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeRunSuccessorSegment({
        ...prepared.segment,
        activation: { ...prepared.segment.activation, pointerVersion: 3 },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      prepareRunSuccessorSegment({
        ...input(),
        successor: { ...input().successor, incarnationId: input().predecessor.incarnationId },
      }),
    ).toEqual({ kind: 'Rejected' });
  });
});
