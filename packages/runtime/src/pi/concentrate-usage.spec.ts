import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { PinnedPiModelAccess } from './baseline-pi-executor.js';

async function openModel() {
  const opened = await new PinnedPiModelAccess({
    acquire: () => Promise.resolve({ kind: 'Available', secret: 'synthetic-only-provider-key' }),
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
  if (opened.kind !== 'Opened') throw new Error('pinned model must open');
  return opened;
}

describe('Concentrate raw usage accountability', () => {
  it.each([
    { name: 'missing cost', cost: undefined, expected: { kind: 'Unavailable' } },
    { name: 'null cost', cost: null, expected: { kind: 'Unavailable' } },
    { name: 'negative cost', cost: { total: -1 }, expected: { kind: 'Unavailable' } },
    { name: 'string cost', cost: { total: '0.01' }, expected: { kind: 'Unavailable' } },
    {
      name: 'unsafe scaled cost',
      cost: { total: Number.MAX_SAFE_INTEGER },
      expected: { kind: 'Unavailable' },
    },
    {
      name: 'explicit zero cost',
      cost: { total: 0 },
      expected: { kind: 'Verified', spendMicroUsd: 0 },
    },
    {
      name: 'reported cost differing from the SDK estimate',
      cost: { total: 0.00000125 },
      expected: { kind: 'Verified', spendMicroUsd: 2 },
    },
  ])('requires $name to come from the raw response', async ({ cost, expected }) => {
    const opened = await openModel();
    const response = {
      id: 'resp_reported_cost',
      status: 'completed',
      output: [],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      ...(cost === undefined ? {} : { cost }),
    };
    const message = await opened.runtime.completeSimple(
      opened.model,
      {
        messages: [{ role: 'user', content: 'cost probe', timestamp: 0 }],
      },
      {
        maxRetries: 0,
        fetch: () =>
          Promise.resolve(
            new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      },
    );
    expect(message.stopReason).toBe('stop');
    expect(opened.consumeUsage(message)).toEqual(expected);
  });

  it.each([
    { name: 'missing usage', usage: undefined, expected: 'Unavailable' },
    {
      name: 'missing input',
      usage: { output_tokens: 2, total_tokens: 2 },
      expected: 'Unavailable',
    },
    {
      name: 'missing output',
      usage: { input_tokens: 2, total_tokens: 2 },
      expected: 'Unavailable',
    },
    {
      name: 'explicit zero',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      expected: 'Verified',
    },
    {
      name: 'complete usage',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      expected: 'Verified',
    },
    {
      name: 'contradictory total',
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 4 },
      expected: 'Unavailable',
    },
  ] as const)(
    'distinguishes $name before Pi normalizes missing fields',
    async ({ usage, expected }) => {
      const opened = await openModel();
      const response = {
        id: 'resp_usage_probe',
        status: 'completed',
        cost: { total: 0 },
        output: [],
        ...(usage === undefined ? {} : { usage }),
      };
      const message = await opened.runtime.completeSimple(
        opened.model,
        {
          messages: [{ role: 'user', content: 'usage probe', timestamp: 0 }],
        },
        {
          maxRetries: 0,
          fetch: () =>
            Promise.resolve(
              new Response(
                `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
                { headers: { 'content-type': 'text/event-stream' } },
              ),
            ),
        },
      );
      expect(message.stopReason).toBe('stop');
      expect(opened.consumeUsage(message)).toEqual(
        expected === 'Verified' ? { kind: expected, spendMicroUsd: 0 } : { kind: expected },
      );
      expect(opened.consumeUsage(message)).toEqual({ kind: 'Unavailable' });
    },
  );
  it.each(['\n', '\r\n', '\r'])(
    'observes byte-fragmented UTF-8 and multiline SSE with %j endings',
    async (ending) => {
      const opened = await openModel();
      const response = {
        id: 'resp_💡',
        status: 'completed',
        cost: { total: 0 },
        output: [],
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          total_tokens: 6,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        },
      };
      const bytes = new TextEncoder().encode(
        [
          '\ufeff: comment',
          'event: response.completed',
          'data: {"type":"response.completed",',
          `data: "response":${JSON.stringify(response)}}`,
          '',
          '',
        ].join(ending),
      );
      let offset = 0;
      const message = await opened.runtime.completeSimple(
        opened.model,
        { messages: [{ role: 'user', content: 'probe', timestamp: 0 }] },
        {
          maxRetries: 0,
          fetch: () =>
            Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  pull(controller) {
                    if (offset === bytes.length) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(bytes.slice(offset, offset + 1));
                    offset += 1;
                  },
                }),
                { headers: { 'content-type': 'text/event-stream' } },
              ),
            ),
        },
      );
      expect(message.stopReason).toBe('stop');
      expect(message.usage).toMatchObject({
        input: 2,
        output: 1,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 6,
      });
      expect(opened.consumeUsage(message)).toEqual({ kind: 'Verified', spendMicroUsd: 0 });
    },
  );

  it('does not reuse a prior request receipt and rejects mismatched response identities', async () => {
    const opened = await openModel();
    const response = {
      id: 'resp_first',
      status: 'completed',
      cost: { total: 0 },
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const context = { messages: [{ role: 'user' as const, content: 'probe', timestamp: 0 }] };
    const first = await opened.runtime.completeSimple(opened.model, context, {
      maxRetries: 0,
      fetch: () =>
        Promise.resolve(
          new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    });
    expect(opened.consumeUsage({ ...first, responseId: 'resp_unrelated' })).toEqual({
      kind: 'Unavailable',
    });
    expect(opened.consumeUsage(first)).toEqual({ kind: 'Unavailable' });
    const second = await opened.runtime.completeSimple(opened.model, context, {
      maxRetries: 0,
      fetch: () =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_second', status: 'completed', output: [] } })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    });
    expect(opened.consumeUsage(second)).toEqual({ kind: 'Unavailable' });
  });

  it('bounds raw SSE observations before an oversized frame reaches normalization', async () => {
    const opened = await openModel();
    const message = await opened.runtime.completeSimple(
      opened.model,
      { messages: [{ role: 'user', content: 'probe', timestamp: 0 }] },
      {
        maxRetries: 0,
        fetch: () =>
          Promise.resolve(
            new Response(`data: ${'x'.repeat(512 * 1_024)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      },
    );
    expect(message.stopReason).toBe('error');
    expect(opened.consumeUsage(message)).toEqual({ kind: 'Unavailable' });
  });

  it('withholds usage credit when the provider rejects an oversized context', async () => {
    const opened = await openModel();
    const message = await opened.runtime.completeSimple(
      opened.model,
      { messages: [{ role: 'user', content: 'probe', timestamp: 0 }] },
      {
        maxRetries: 0,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      },
    );
    expect(message.stopReason).toBe('error');
    expect(opened.consumeUsage(message)).toEqual({ kind: 'Unavailable' });
  });

  it('verifies terminal usage delivered over a real localhost HTTP response', async () => {
    const response = {
      id: 'resp_http',
      status: 'completed',
      cost: { total: 0 },
      output: [],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
    const server = createServer((request, reply) => {
      request.resume();
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server must listen');
      const opened = await openModel();
      const message = await opened.runtime.completeSimple(
        opened.model,
        { messages: [{ role: 'user', content: 'probe', timestamp: 0 }] },
        {
          maxRetries: 0,
          timeoutMs: 5_000,
          fetch: (_input, init) =>
            fetch(`http://127.0.0.1:${String(address.port)}/responses`, init),
        },
      );
      expect(message.stopReason).toBe('stop');
      expect(opened.consumeUsage(message)).toEqual({ kind: 'Verified', spendMicroUsd: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
