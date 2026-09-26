import { describe, expect, it } from 'vitest';

import { inspectConcentrateProviderReport } from './concentrate-provider-report.js';

const message = {
  provider: 'concentrate',
  model: 'deepinfra/deepseek-v4-flash-0731',
  responseId: 'response-1',
  usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 },
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
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('exact Concentrate provider report', () => {
  it('derives the charge from a matching terminal response frame', () => {
    expect(inspectConcentrateProviderReport(bytes(frame), message)).toEqual({
      kind: 'Verified',
      responseId: 'response-1',
      inputTokens: 14,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 16,
      spendMicroUsd: 7,
    });
  });

  it('rejects a substituted response, charge, or malformed frame', () => {
    expect(inspectConcentrateProviderReport(bytes(frame), { ...message, responseId: 'other' })).toEqual({
      kind: 'Rejected',
    });
    expect(
      inspectConcentrateProviderReport(
        bytes({ ...frame, response: { ...frame.response, cost: { total: -1 } } }),
        message,
      ),
    ).toEqual({ kind: 'Rejected' });
    expect(inspectConcentrateProviderReport(bytes({ ...frame, type: 'response.created' }), message)).toEqual({
      kind: 'Rejected',
    });
  });
});
