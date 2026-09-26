import Type from 'typebox';
import Value from 'typebox/value';

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const frameSchema = Type.Object({
  type: Type.Literal('response.completed'),
  response: Type.Object({
    id: Type.String({ minLength: 1, maxLength: 256 }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    cost: Type.Object({ total: Type.Number({ minimum: 0 }) }),
    usage: Type.Object({
      input_tokens: count,
      output_tokens: count,
      total_tokens: count,
      input_tokens_details: Type.Optional(
        Type.Object({
          cached_tokens: Type.Optional(count),
          cache_write_tokens: Type.Optional(count),
        }),
      ),
    }),
  }),
});

interface ProviderMessage {
  readonly provider: string;
  readonly model: string;
  readonly responseId?: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
  };
}

export type ConcentrateProviderReportInspection =
  | {
      readonly kind: 'Verified';
      readonly responseId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly totalTokens: number;
      readonly spendMicroUsd: number;
    }
  | { readonly kind: 'Rejected' };

/** Replays exact parent-retained terminal response data, never a worker usage claim. */
export function inspectConcentrateProviderReport(
  bytes: Uint8Array,
  message: ProviderMessage,
): ConcentrateProviderReportInspection {
  if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1_024) return { kind: 'Rejected' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'Rejected' };
  }
  if (!Value.Check(frameSchema, parsed)) return { kind: 'Rejected' };
  const { response } = parsed;
  const usage = response.usage;
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const spendMicroUsd = Math.ceil(response.cost.total * 1_000_000);
  const cached = cacheReadTokens + cacheWriteTokens;
  if (
    message.provider !== 'concentrate' ||
    message.responseId === undefined ||
    response.id !== message.responseId ||
    (response.model !== undefined && response.model !== message.model) ||
    !Number.isSafeInteger(spendMicroUsd) ||
    !Number.isSafeInteger(cached) ||
    cached > usage.input_tokens ||
    !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
    usage.input_tokens + usage.output_tokens !== usage.total_tokens ||
    message.usage.input !== usage.input_tokens - cached ||
    message.usage.output !== usage.output_tokens ||
    message.usage.cacheRead !== cacheReadTokens ||
    message.usage.cacheWrite !== cacheWriteTokens ||
    message.usage.totalTokens !== usage.total_tokens
  )
    return { kind: 'Rejected' };
  return {
    kind: 'Verified',
    responseId: response.id,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.total_tokens,
    spendMicroUsd,
  };
}
