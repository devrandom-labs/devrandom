import type { AssistantMessage, FetchFunction } from '@earendil-works/pi-ai';
import Type from 'typebox';
import Value from 'typebox/value';

const tokenCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const responseUsageSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  cost: Type.Object({ total: Type.Number({ minimum: 0 }) }),
  usage: Type.Object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    total_tokens: tokenCount,
    input_tokens_details: Type.Optional(
      Type.Object({
        cached_tokens: Type.Optional(tokenCount),
        cache_write_tokens: Type.Optional(tokenCount),
      }),
    ),
  }),
});
const eventSchema = Type.Object({ type: Type.String(), response: Type.Optional(Type.Unknown()) });
type UsageReceipt =
  | { readonly kind: 'Missing' }
  | { readonly kind: 'Unavailable' }
  | {
      readonly kind: 'Reported';
      readonly responseId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly spendMicroUsd: number;
    };

/** Observes only bounded SSE frames and retains one request's reported usage. */
export class ConcentrateUsage {
  #current: { receipt: UsageReceipt } = { receipt: { kind: 'Missing' } };

  consume(
    message: AssistantMessage,
  ):
    | { readonly kind: 'Verified'; readonly spendMicroUsd: number }
    | { readonly kind: 'Unavailable' } {
    const receipt = this.#current.receipt;
    this.#current.receipt = { kind: 'Unavailable' };
    if (receipt.kind !== 'Reported' || receipt.responseId !== message.responseId) {
      return { kind: 'Unavailable' };
    }
    return message.usage.input === receipt.inputTokens - receipt.cacheRead - receipt.cacheWrite &&
      message.usage.output === receipt.outputTokens &&
      message.usage.cacheRead === receipt.cacheRead &&
      message.usage.cacheWrite === receipt.cacheWrite &&
      message.usage.totalTokens === receipt.totalTokens
      ? { kind: 'Verified', spendMicroUsd: receipt.spendMicroUsd }
      : { kind: 'Unavailable' };
  }

  async fetch(
    source: FetchFunction,
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ): Promise<Response> {
    const current: { receipt: UsageReceipt } = { receipt: { kind: 'Missing' } };
    this.#current = current;
    const response = await source(input, init);
    if (
      !response.ok ||
      response.body === null ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream'
    ) {
      return response;
    }
    const decoder = new TextDecoder();
    let line = '';
    let data = '';
    let eventBytes = 0;
    let lineEnding: 'Ordinary' | 'AfterCarriageReturn' = 'Ordinary';
    const observe = () => {
      if (data.length === 0 || data === '[DONE]\n') return;
      let event: unknown;
      try {
        event = JSON.parse(data.slice(0, -1));
      } catch {
        current.receipt = { kind: 'Unavailable' };
        return;
      }
      if (!Value.Check(eventSchema, event)) {
        current.receipt = { kind: 'Unavailable' };
        return;
      }
      if (!['response.completed', 'response.incomplete', 'response.failed'].includes(event.type))
        return;
      if (current.receipt.kind !== 'Missing' || !Value.Check(responseUsageSchema, event.response)) {
        current.receipt = { kind: 'Unavailable' };
        return;
      }
      const usage = event.response.usage;
      // Pinned Concentrate dollar pricing and the live receipt establish this mapping.
      // Pi's catalogue tariff is only an estimate; it is never the actual charge.
      const spendMicroUsd = Math.ceil(event.response.cost.total * 1_000_000);
      const cached =
        (usage.input_tokens_details?.cached_tokens ?? 0) +
        (usage.input_tokens_details?.cache_write_tokens ?? 0);
      current.receipt =
        Number.isSafeInteger(spendMicroUsd) &&
        cached <= usage.input_tokens &&
        usage.input_tokens + usage.output_tokens === usage.total_tokens
          ? {
              kind: 'Reported',
              responseId: event.response.id,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
              cacheWrite: usage.input_tokens_details?.cache_write_tokens ?? 0,
              spendMicroUsd,
            }
          : { kind: 'Unavailable' };
    };
    const endLine = () => {
      if (line.length === 0) {
        observe();
        data = '';
        eventBytes = 0;
      } else if (line === 'data') {
        data += '\n';
      } else if (line.startsWith('data:')) {
        const value = line.slice(5);
        data += `${value.startsWith(' ') ? value.slice(1) : value}\n`;
      }
      line = '';
    };
    const inspect = (text: string) => {
      for (const character of text) {
        if (character === '\n' && lineEnding === 'AfterCarriageReturn') {
          lineEnding = 'Ordinary';
          continue;
        }
        lineEnding = character === '\r' ? 'AfterCarriageReturn' : 'Ordinary';
        if (character === '\r' || character === '\n') {
          endLine();
          continue;
        }
        eventBytes += Buffer.byteLength(character, 'utf8');
        if (eventBytes > 512 * 1_024) {
          current.receipt = { kind: 'Unavailable' };
          throw new Error('Provider usage event exceeds the bounded observation limit.');
        }
        line += character;
      }
    };
    return new Response(
      response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            inspect(decoder.decode(chunk, { stream: true }));
            controller.enqueue(chunk);
          },
          flush() {
            inspect(decoder.decode());
          },
        }),
      ),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }
}
