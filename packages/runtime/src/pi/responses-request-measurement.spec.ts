import { fauxAssistantMessage, type Model } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import Type from 'typebox';
import { expect, it, vi } from 'vitest';
import { responsesRequestBytes } from './responses-request-measurement.js';
import { ParentRunModelInference } from '../run/parent-run-model-inference.js';

const model: Model<'openai-responses'> = {
  id: 'deepinfra/deepseek-v4-flash-0731',
  name: 'Pinned DeepSeek',
  api: 'openai-responses',
  provider: 'concentrate',
  baseUrl: 'https://api.concentrate.ai/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
};
function fixture() {
  const thinking = 'reasoning '.repeat(6500);
  const message = {
    ...fauxAssistantMessage(''),
    api: 'openai-responses' as const,
    provider: model.provider,
    model: model.id,
    content: [
      {
        type: 'thinking' as const,
        thinking,
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          id: 'rs_fixture',
          summary: [{ type: 'summary_text', text: thinking }],
        }),
      },
    ],
  };
  return normalizeContext({
    systemPrompt: 'Exact original system instructions.',
    tools: [
      {
        name: 'read_file',
        description: 'Read exact repository bytes.',
        parameters: Type.Object({ path: Type.String() }),
      },
    ],
    messages: [{ role: 'user', content: 'Original task contract.', timestamp: 0 }, message],
  });
}
it('measures the actual pinned serializer including system/tools, without network or transcript loss', async () => {
  const context = fixture();
  const before = JSON.stringify(context);
  let payload: unknown;
  const fetch = vi.fn(() => Promise.reject(Error('Network forbidden')));
  await streamSimple(model, context, {
    apiKey: 'offline-only',
    maxTokens: 8192,
    reasoning: 'low',
    fetch,
    onPayload: (value) => {
      payload = value;
      throw Error('captured');
    },
  }).result();
  const bytes = await responsesRequestBytes(model, context, { maxTokens: 8192, reasoning: 'low' });
  expect(bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
  expect(bytes).toBeLessThan(122880);
  expect(Buffer.byteLength(JSON.stringify(context.messages))).toBeGreaterThan(122880);
  expect(JSON.stringify(payload)).toContain('Exact original system instructions.');
  expect(JSON.stringify(payload)).toContain('Read exact repository bytes.');
  expect(payload).toMatchObject({ max_output_tokens: 8192 });
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(context)).toBe(before);
});
it('reaches the ordinary budget gate for a fitting signed-reasoning request instead of a false context stop', async () => {
  const reserve = vi.fn(() => ({
    kind: 'Exhausted' as const,
    budget: 'providerRequests' as const,
  }));
  const complete = vi.fn(() => Promise.reject(Error('Budget must prevent provider')));
  const inference = new ParentRunModelInference({
    model,
    compatibility: {
      provider: model.provider,
      model: model.id,
      thinkingLevel: 'low',
      contextWindowTokens: 131072,
      maximumOutputTokens: 8192,
    },
    sessionId: 'session',
    budget: {
      reserve,
      commit: () => ({ kind: 'ReservationRejected' }),
      release: () => ({ kind: 'ReservationRejected' }),
    },
    evidence: {
      record: () => ({ kind: 'Unavailable' }),
      storeArtifact: () => ({ kind: 'Unavailable' }),
    },
    complete,
    consumeUsage: () => ({ kind: 'Unavailable' }),
    now: () => new Date(0).toISOString(),
  });
  expect(await inference.complete(fixture(), 0, new AbortController().signal)).toMatchObject({
    kind: 'Stopped',
    disposition: { kind: 'BudgetExhausted' },
  });
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(complete).not.toHaveBeenCalled();
});
