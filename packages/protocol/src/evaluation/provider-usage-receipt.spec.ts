import { describe, expect, it } from 'vitest';

import {
  decodeEvaluationProviderUsageReceipt,
  prepareEvaluationProviderUsageReceipt,
} from './provider-usage-receipt.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const input = {
  evaluationId: '11111111-1111-4111-8111-111111111111',
  streamId: '22222222-2222-4222-8222-222222222222',
  harnessRevisionSaid: said('h'),
  phase: { kind: 'Trial', manifestSaid: said('m'), arm: 'H1', repetition: 1, attempt: 1 },
  modelExchangeEventSaid: said('e'),
  requestOrdinal: 0,
  provider: 'concentrate',
  model: 'deepinfra/deepseek-v4-flash-0731',
  responseId: 'response-1',
  inputTokens: 14,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  totalTokens: 16,
  spendMicroUsd: 7,
  providerReportArtifactSaid: said('r'),
} as const;

describe('Evaluation provider usage raw receipt', () => {
  it('binds exact versioned bytes, source event, and original provider report', () => {
    const prepared = prepareEvaluationProviderUsageReceipt(input);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvaluationProviderUsageReceipt(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      receipt: prepared.receipt,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    expect(
      decodeEvaluationProviderUsageReceipt(
        prepared.artifact,
        new TextEncoder().encode(JSON.stringify({ ...prepared.receipt, responseId: 'substituted' })),
      ),
    ).toMatchObject({ kind: 'Rejected' });
  });

  it('rejects invented token arithmetic and unlinked report bytes', () => {
    expect(prepareEvaluationProviderUsageReceipt({ ...input, totalTokens: 15 })).toMatchObject({
      kind: 'Rejected',
    });
    expect(
      prepareEvaluationProviderUsageReceipt({ ...input, providerReportArtifactSaid: 'missing' }),
    ).toMatchObject({ kind: 'Rejected' });
  });
});
