import {
  fauxAssistantMessage,
  type Api,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { ParentRunModelInference } from './parent-run-model-inference.js';
import type { ParentRunModelInferenceDependencies } from './parent-run-model-inference.js';

it('refuses an oversized contained Pi context before provider spend or ModelRequest evidence', async () => {
  const calls: string[] = [];
  const inference = new ParentRunModelInference({
    model: {
      provider: 'concentrate',
      id: 'deepinfra/deepseek-v4-flash-0731',
      cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
    } as Model<Api>,
    compatibility: {
      provider: 'concentrate',
      model: 'deepinfra/deepseek-v4-flash-0731',
      contextWindowTokens: 100,
      maximumOutputTokens: 50,
      thinkingLevel: 'low',
    },
    sessionId: '11111111-1111-4111-8111-111111111111',
    budget: {
      reserve: () => {
        calls.push('reserve');
        return { kind: 'ReservationInvalid' };
      },
      commit: () => {
        calls.push('commit');
        return { kind: 'ReservationRejected' };
      },
      release: () => {
        calls.push('release');
        return { kind: 'ReservationRejected' };
      },
    },
    evidence: {
      record: () => {
        calls.push('record');
        return { kind: 'Unavailable' };
      },
      storeArtifact: () => {
        calls.push('artifact');
        return { kind: 'Unavailable' };
      },
    },
    complete: () => {
      calls.push('provider');
      return Promise.reject(new Error('Provider must not be called.'));
    },
    consumeUsage: () => ({ kind: 'Unavailable' }),
    now: () => '2026-09-26T05:00:00.000Z',
  });
  const context = {
    messages: [{ role: 'user', content: 'large'.repeat(100), timestamp: Date.now() }],
  } as TranscriptContext;
  expect(await inference.complete(context, 0, new AbortController().signal)).toMatchObject({
    kind: 'Stopped',
    disposition: { kind: 'ContextLimitReached' },
  });
  expect(calls).toEqual([]);
});

it('records the exact parent provider request, debit, raw message and completion before releasing it to Pi', async () => {
  const calls: string[] = [];
  const message = fauxAssistantMessage('Public observation.');
  const reserved = {
    kind: 'Reserved',
    reservation: { reservationId: 0 },
  } as ReturnType<ParentRunModelInferenceDependencies['budget']['reserve']>;
  const inference = new ParentRunModelInference({
    model: {
      provider: 'concentrate',
      id: 'deepinfra/deepseek-v4-flash-0731',
      cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
    } as Model<Api>,
    compatibility: {
      provider: 'concentrate',
      model: 'deepinfra/deepseek-v4-flash-0731',
      contextWindowTokens: 131_072,
      maximumOutputTokens: 8192,
      thinkingLevel: 'low',
    },
    sessionId: '11111111-1111-4111-8111-111111111111',
    budget: {
      reserve: () => {
        calls.push('reserve');
        return reserved;
      },
      commit: () => {
        calls.push('debit');
        return { kind: 'Committed' };
      },
      release: () => ({ kind: 'Released' }),
    },
    evidence: {
      record: (observation) => {
        calls.push(observation.event.kind);
        return { kind: 'Recorded', event: { d: `E${'z'.repeat(43)}` } } as ReturnType<
          ParentRunModelInferenceDependencies['evidence']['record']
        >;
      },
      storeArtifact: ({ bytes }) => {
        calls.push('artifact');
        const prepared = prepareEvidenceArtifact(bytes, 'application/json');
        if (prepared.kind !== 'Prepared') throw new Error('artifact fixture invalid');
        return { kind: 'Stored', artifact: prepared.artifact };
      },
    },
    complete: () => {
      calls.push('provider');
      return Promise.resolve(message);
    },
    consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 10 }),
    now: () => '2026-09-26T05:00:00.000Z',
  });
  const context = {
    messages: [{ role: 'user', content: 'Task', timestamp: Date.now() }],
  } as TranscriptContext;
  const outcome = await inference.complete(context, 0, new AbortController().signal);
  expect(outcome.kind).toBe('Completed');
  expect(calls).toEqual([
    'reserve',
    'ModelRequest',
    'provider',
    'debit',
    'artifact',
    'ModelMessageCompleted',
  ]);
});
