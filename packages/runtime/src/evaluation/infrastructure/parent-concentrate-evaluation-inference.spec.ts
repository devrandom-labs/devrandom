import {
  fauxAssistantMessage,
  type Api,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';

import type { EvaluationExecutionBinding } from '@devrandom/domain';
import { prepareEvidenceArtifact } from '@devrandom/protocol';

import { ParentConcentrateEvaluationInference } from './parent-concentrate-evaluation-inference.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const binding: EvaluationExecutionBinding = {
  kind: 'Evaluation',
  evaluationId: id('1'),
  evidenceStreamId: id('2'),
  originRunId: id('3'),
  taskId: id('4'),
  taskRevisionSaid: said('t'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  harnessRevisionSaid: said('h'),
  evaluationLeaseId: id('5'),
  phase: { kind: 'Trial', manifestSaid: said('v'), arm: 'H1', repetition: 1, attempt: 1 },
};
const frame = {
  type: 'response.completed',
  response: {
    id: 'response-1',
    cost: { total: 0.000007 },
    usage: {
      input_tokens: 14,
      output_tokens: 2,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
    },
  },
};
const bytes = new TextEncoder().encode(JSON.stringify(frame));
const message = {
  ...fauxAssistantMessage('Public observation.'),
  provider: 'concentrate',
  model: 'deepinfra/deepseek-v4-flash-0731',
  responseId: 'response-1',
  stopReason: 'stop' as const,
  usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 },
};

function fixture() {
  const calls: string[] = [];
  const completeSimple = vi.fn().mockImplementation(() => {
    calls.push('provider');
    return Promise.resolve(message);
  });
  const reserve = vi.fn().mockImplementation(() => {
    calls.push('reserve');
    return Promise.resolve({ kind: 'Reserved', reservationId: 'reservation-1' });
  });
  const record = vi.fn().mockImplementation(() => {
    calls.push('record');
    return Promise.resolve({ kind: 'Recorded' });
  });
  const lease = vi.fn().mockImplementation(() => {
    calls.push('lease');
    return Promise.resolve({ kind: 'Held', expiresAt: '2026-09-26T17:00:00.000Z' });
  });
  const consumeProviderReport = vi.fn().mockReturnValue({
    kind: 'Verified',
    spendMicroUsd: 7,
    providerReportBytes: bytes,
  });
  const model = {
    provider: 'concentrate',
    id: 'deepinfra/deepseek-v4-flash-0731',
    contextWindow: 131_072,
    maxTokens: 8192,
    cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
  } as Model<Api>;
  const inference = new ParentConcentrateEvaluationInference({
    profile: {
      d: said('p'),
      modelProvider: model.provider,
      modelId: model.id,
      maximumOutputTokens: 8192,
      thinkingLevel: 'low',
    },
    opened: {
      kind: 'Opened',
      model,
      runtime: { completeSimple } as never,
      consumeUsage: () => ({ kind: 'Unavailable' }),
      consumeProviderReport,
    },
    lease: { inspect: lease },
    allowance: { reserve, record },
  });
  return { inference, calls, completeSimple, reserve, record, lease, consumeProviderReport };
}

const request = {
  binding,
  requestOrdinal: 0,
  modelProfileSaid: said('p'),
  context: {
    messages: [{ role: 'user' as const, content: 'Read public evidence.', timestamp: 0 }],
  } as TranscriptContext,
  maximumOutputTokens: 8192,
  signal: new AbortController().signal,
};

it('returns an exact parent-observed provider frame only after lease, reservation and usage settlement', async () => {
  const given = fixture();
  expect(await given.inference.complete(request)).toEqual({
    kind: 'Completed',
    message,
    verifiedSpendMicroUsd: 7,
    providerReportBytes: bytes,
  });
  expect(given.calls).toEqual(['lease', 'reserve', 'provider', 'record', 'lease']);
  expect(given.record).toHaveBeenCalledWith({
    reservationId: 'reservation-1',
    usage: {
      kind: 'Verified',
      providerRequests: 1,
      inputTokens: 14,
      outputTokens: 2,
      spendMicroUsd: 7,
      responseId: 'response-1',
      providerReportArtifactSaid: (() => {
        const prepared = prepareEvidenceArtifact(bytes, 'application/json');
        if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
        return prepared.artifact.d;
      })(),
    },
  });
});

it('does not call the provider without a current Evaluation lease or reserved capacity', async () => {
  const lost = fixture();
  lost.lease.mockImplementation(() => {
    lost.calls.push('lease');
    return Promise.resolve({ kind: 'Lost' });
  });
  expect(await lost.inference.complete(request)).toEqual({ kind: 'LeaseLost' });
  expect(lost.calls).toEqual(['lease']);

  const exhausted = fixture();
  exhausted.reserve.mockImplementation(() => {
    exhausted.calls.push('reserve');
    return Promise.resolve({ kind: 'Exhausted' });
  });
  expect(await exhausted.inference.complete(request)).toEqual({ kind: 'BudgetExhausted' });
  expect(exhausted.calls).toEqual(['lease', 'reserve']);
});

it('records unresolved spend and refuses substituted raw provider data', async () => {
  const given = fixture();
  given.consumeProviderReport.mockReturnValue({
    kind: 'Verified',
    spendMicroUsd: 7,
    providerReportBytes: new TextEncoder().encode(
      JSON.stringify({ ...frame, response: { ...frame.response, id: 'substituted' } }),
    ),
  });
  expect(await given.inference.complete(request)).toEqual({ kind: 'UnknownUsage' });
  expect(given.record).toHaveBeenCalledWith({
    reservationId: 'reservation-1',
    usage: { kind: 'Unresolved' },
  });
});

it('does not overlap two provider turns on one raw usage observer', async () => {
  const given = fixture();
  let release: ((value: typeof message) => void) | undefined;
  given.completeSimple.mockImplementation(
    () =>
      new Promise<typeof message>((resolve) => {
        given.calls.push('provider');
        release = resolve;
      }),
  );
  const first = given.inference.complete(request);
  await vi.waitFor(() => {
    expect(given.calls).toContain('provider');
  });
  expect(await given.inference.complete({ ...request, requestOrdinal: 1 })).toEqual({
    kind: 'Unavailable',
  });
  expect(given.reserve).toHaveBeenCalledTimes(1);
  if (release === undefined) throw new Error('provider request did not begin');
  release(message);
  expect((await first).kind).toBe('Completed');
});
