import { Type, type Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { PinnedPiModelAccess } from './baseline-pi-executor.js';

const integrationTest = process.env.DEVRANDOM_CONCENTRATE_INTEGRATION === '1' ? it : it.skip;

function hasPositiveUsage(message: {
  readonly usage: { readonly input: number; readonly output: number; readonly totalTokens: number };
}): boolean {
  return message.usage.input > 0 && message.usage.output > 0 && message.usage.totalTokens > 0;
}

describe('Concentrate Pi provider integration', () => {
  integrationTest('accounts for a paid DeepSeek Flash tool call', async () => {
    const secret = process.env.CONCENTRATE_API_KEY;
    if (secret === undefined || secret.length === 0) {
      throw new Error('CONCENTRATE_API_KEY is required');
    }
    const opened = await new PinnedPiModelAccess({
      acquire: () => Promise.resolve({ kind: 'Available', secret }),
    }).open({
      provider: 'concentrate',
      model: 'deepinfra/deepseek-v4-flash-0731',
      contextWindowTokens: 131_072,
      maximumOutputTokens: 512,
      thinkingLevel: 'low',
      credentialSource: 'CONCENTRATE_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    });
    expect(opened.kind).toBe('Opened');
    if (opened.kind !== 'Opened') return;
    const reply = await opened.runtime.completeSimple(
      opened.model,
      {
        systemPrompt: 'Call the offered tool exactly once.',
        tools: [
          {
            name: 'report_value',
            description: 'Report value seven.',
            parameters: Type.Object(
              { value: Type.Integer({ minimum: 7, maximum: 7 }) },
              { additionalProperties: false },
            ),
          },
        ],
        messages: [
          { role: 'user', content: 'Call report_value with value 7.', timestamp: Date.now() },
        ],
      },
      { reasoning: 'low', toolChoice: 'auto', timeoutMs: 30_000, maxRetries: 0 },
    );
    expect(reply.content).toContainEqual(
      expect.objectContaining({ type: 'toolCall', name: 'report_value' }),
    );
    expect(hasPositiveUsage(reply)).toBe(true);
    expect(opened.consumeUsage(reply)).toEqual({
      kind: 'Verified',
      spendMicroUsd: expect.any(Number) as unknown,
    });
  });

  integrationTest(
    'streams a pinned tool call, continues from its result, reports usage, and cancels in flight',
    async () => {
      const secret = process.env.CONCENTRATE_API_KEY;
      if (secret === undefined || secret.length === 0) {
        throw new Error('CONCENTRATE_API_KEY is required');
      }
      const opened = await new PinnedPiModelAccess({
        acquire: () => Promise.resolve({ kind: 'Available', secret }),
      }).open({
        provider: 'concentrate',
        model: 'deepinfra/gemma-4-e4b',
        contextWindowTokens: 131_072,
        maximumOutputTokens: 512,
        thinkingLevel: 'low',
        credentialSource: 'CONCENTRATE_API_KEY',
        toolCalls: 'Supported',
        usageAccounting: 'Required',
      });
      expect(opened.kind).toBe('Opened');
      if (opened.kind !== 'Opened') return;

      const payloads: unknown[] = [];
      const context: Context = {
        systemPrompt:
          'You are a provider compatibility probe. Follow the user instruction exactly.',
        tools: [
          {
            name: 'report_value',
            description: 'Report the exact integer requested by the user.',
            parameters: Type.Object(
              { value: Type.Integer({ minimum: 7, maximum: 7 }) },
              { additionalProperties: false },
            ),
          },
        ],
        messages: [
          {
            role: 'user',
            content:
              'First call report_value exactly once with value 7. After its result, reply with CONTINUATION_OK.',
            timestamp: Date.now(),
          },
        ],
      };
      const first = await opened.runtime.completeSimple(opened.model, context, {
        reasoning: 'low',
        toolChoice: 'auto',
        timeoutMs: 30_000,
        maxRetries: 0,
        onPayload: (payload) => {
          payloads.push(payload);
        },
      });
      const toolCall = first.content.find(
        (content) => content.type === 'toolCall' && content.name === 'report_value',
      );
      expect(first.stopReason).toBe('toolUse');
      expect(first.provider).toBe('concentrate');
      expect(first.model).toBe('deepinfra/gemma-4-e4b');
      expect(first.usage.input).toBeGreaterThan(0);
      expect(first.usage.output).toBeGreaterThan(0);
      expect(first.usage.totalTokens).toBeGreaterThan(0);
      expect(opened.consumeUsage(first)).toEqual({
        kind: 'Verified',
        spendMicroUsd: expect.any(Number) as unknown,
      });
      expect(toolCall).toMatchObject({ arguments: { value: 7 } });
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        model: 'deepinfra/gemma-4-e4b',
        stream: true,
        routing: {
          provider: { fallbacks: ['deepinfra'], sort: 'cost' },
          model: { fallbacks: [] },
        },
      });
      if (toolCall === undefined || toolCall.type !== 'toolCall') return;

      context.messages.push(first, {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: 'The tool confirmed value 7.' }],
        isError: false,
        timestamp: Date.now(),
      });
      const continuation = await opened.runtime.completeSimple(opened.model, context, {
        reasoning: 'low',
        toolChoice: 'none',
        timeoutMs: 30_000,
        maxRetries: 0,
      });
      expect(continuation.stopReason).toBe('stop');
      expect(hasPositiveUsage(continuation)).toBe(true);
      expect(opened.consumeUsage(continuation)).toEqual({
        kind: 'Verified',
        spendMicroUsd: expect.any(Number) as unknown,
      });
      expect(
        continuation.content.some(
          (content) => content.type === 'text' && content.text.includes('CONTINUATION_OK'),
        ),
      ).toBe(true);

      const cancellation = new AbortController();
      const cancellationStream = opened.runtime.streamSimple(
        opened.model,
        {
          messages: [
            {
              role: 'user',
              content: 'Write a detailed ten-part explanation of deterministic finite automata.',
              timestamp: Date.now(),
            },
          ],
        },
        {
          reasoning: 'low',
          signal: cancellation.signal,
          timeoutMs: 30_000,
          maxRetries: 0,
        },
      );
      let cancellationObserved = false;
      for await (const event of cancellationStream) {
        if (event.type === 'start') {
          cancellation.abort();
        }
        if (event.type === 'error' && event.error.stopReason === 'aborted') {
          cancellationObserved = true;
        }
      }
      expect(cancellation.signal.aborted).toBe(true);
      expect(cancellationObserved).toBe(true);
    },
    90_000,
  );
});
