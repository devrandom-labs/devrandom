import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  decodeEvaluationEvidenceEvent,
  prepareEvaluationEvidenceEvent,
  type EvaluationEvidenceEvent,
} from './evidence-event.js';

it('exposes trial arms and charged budget dimensions to typed evidence callers', () => {
  type Trial = Extract<EvaluationEvidenceEvent['phase'], { kind: 'Trial' }>;
  type Debit = Extract<EvaluationEvidenceEvent['detail'], { kind: 'EvaluationBudgetDebited' }>;
  expectTypeOf<Trial['arm']>().toEqualTypeOf<'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch'>();
  expectTypeOf<Debit['budget']>().toEqualTypeOf<
    | 'providerRequests'
    | 'providerInputTokens'
    | 'providerOutputTokens'
    | 'providerSpendMicroUsd'
    | 'runWallTimeSeconds'
    | 'toolProposals'
    | 'aggregateChildCommandTimeSeconds'
    | 'changedFiles'
    | 'changedWorktreeBytes'
  >();
});

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

const trial = {
  kind: 'Trial',
  manifestSaid: said('m'),
  arm: 'C2',
  repetition: 1,
  attempt: 1,
};
const event = {
  evaluationId: id('1'),
  streamId: id('2'),
  originRunId: id('3'),
  taskId: id('4'),
  taskRevisionSaid: said('t'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('q'),
  harnessRevisionSaid: said('h'),
  phase: trial,
  sequence: 0,
  previous: { kind: 'Genesis' },
  occurredAt: '2026-09-26T03:00:00.000Z',
  detail: { kind: 'ArtifactCaptured', artifactSaid: said('c'), custody: 'Public' },
};

describe('native evaluation evidence stream', () => {
  it('binds each non-byte budget debit and the final coverage cursor to the native chain', () => {
    const debit = prepareEvaluationEvidenceEvent({
      ...event,
      detail: {
        kind: 'EvaluationBudgetDebited',
        budget: 'providerRequests',
        amount: 1,
        consumed: 1,
        receiptArtifactSaid: said('r'),
        sourceEventSaid: said('u'),
      },
    });
    expect(debit.kind).toBe('Prepared');
    if (debit.kind !== 'Prepared') return;
    expect(decodeEvaluationEvidenceEvent(debit.event)).toEqual({
      kind: 'Accepted',
      event: debit.event,
    });
    expect(
      prepareEvaluationEvidenceEvent({
        ...event,
        detail: { ...debit.event.detail, budget: 'evidencePlusArtifactsPerRunBytes' },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
    const coverageDetail = {
      kind: 'EvaluationBudgetCovered',
      throughSequence: 0,
      throughHeadSaid: debit.event.d,
      totals: {
        providerRequests: 1,
        providerInputTokens: 12,
        providerOutputTokens: 4,
        providerSpendMicroUsd: 5,
        runWallTimeSeconds: 1,
        toolProposals: 0,
        aggregateChildCommandTimeSeconds: 0,
        changedFiles: 0,
        changedWorktreeBytes: 0,
      },
      providerUsageEventSaids: [said('u')],
    } as const;
    const coverage = prepareEvaluationEvidenceEvent({
      ...event,
      sequence: 1,
      previous: { kind: 'Previous', eventSaid: debit.event.d },
      detail: coverageDetail,
    });
    expect(coverage.kind).toBe('Prepared');
    if (coverage.kind !== 'Prepared') return;
    expect(decodeEvaluationEvidenceEvent(coverage.event)).toEqual({
      kind: 'Accepted',
      event: coverage.event,
    });
    expect(
      decodeEvaluationEvidenceEvent({
        ...coverage.event,
        detail: { ...coverage.event.detail, throughHeadSaid: said('z') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'ChainInvalid' });
    expect(
      decodeEvaluationEvidenceEvent({
        ...coverage.event,
        detail: {
          ...coverage.event.detail,
          totals: { ...coverageDetail.totals, providerRequests: 2 },
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });

  it('binds an immutable event to a distinct evaluation and exact trial slot', () => {
    const prepared = prepareEvaluationEvidenceEvent(event);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvaluationEvidenceEvent(prepared.event)).toEqual({
      kind: 'Accepted',
      event: prepared.event,
    });
  });

  it('accepts only a source-bound provider verification event in a trial phase', () => {
    const verified = prepareEvaluationEvidenceEvent({
      ...event,
      sequence: 1,
      previous: { kind: 'Previous', eventSaid: said('p') },
      detail: {
        kind: 'ProviderUsageVerified',
        modelExchangeEventSaid: said('e'),
        receiptArtifactSaid: said('r'),
        providerReportArtifactSaid: said('s'),
        requestOrdinal: 0,
      },
    });
    expect(verified.kind).toBe('Prepared');
    expect(
      prepareEvaluationEvidenceEvent({
        ...event,
        phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
        sequence: 1,
        previous: { kind: 'Previous', eventSaid: said('p') },
        detail: {
          kind: 'ProviderUsageVerified',
          modelExchangeEventSaid: said('e'),
          receiptArtifactSaid: said('r'),
          providerReportArtifactSaid: said('s'),
          requestOrdinal: 0,
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('rejects a Run-shaped alias and a hidden answer in an event', () => {
    expect(prepareEvaluationEvidenceEvent({ ...event, runId: id('4') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(
      prepareEvaluationEvidenceEvent({ ...event, detail: { ...event.detail, answer: 'secret' } }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('rejects a broken chain and a slot not in the frozen schedule', () => {
    expect(prepareEvaluationEvidenceEvent({ ...event, sequence: 1 })).toEqual({
      kind: 'Rejected',
      reason: 'ChainInvalid',
    });
    expect(
      prepareEvaluationEvidenceEvent({ ...event, phase: { ...trial, arm: 'C2', attempt: 2 } }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SlotInvalid',
    });
  });

  it('rejects substitution after SAID creation', () => {
    const prepared = prepareEvaluationEvidenceEvent(event);
    if (prepared.kind !== 'Prepared') throw new Error('event rejected');
    expect(
      decodeEvaluationEvidenceEvent({ ...prepared.event, harnessRevisionSaid: said('z') }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SaidMismatch',
    });
  });
});
