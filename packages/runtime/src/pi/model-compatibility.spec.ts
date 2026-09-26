import { describe, expect, it } from 'vitest';

import { inspectPiModelCompatibility } from './model-compatibility.js';

describe('Pi model compatibility inspection', () => {
  it('rejects a catalogue model whose raw accounting transport is not implemented', async () => {
    await expect(
      inspectPiModelCompatibility({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        thinkingLevel: 'high',
        maximumOutputTokens: 512,
        credentialSource: 'DEEPSEEK_API_KEY',
      }),
    ).resolves.toEqual({ kind: 'UsageAccountingUnsupported' });
  });
  it('reads a pinned static model without creating a session or contacting a provider', async () => {
    await expect(
      inspectPiModelCompatibility({
        provider: 'concentrate',
        model: 'deepinfra/gemma-4-e4b',
        thinkingLevel: 'low',
        maximumOutputTokens: 32_768,
        credentialSource: 'CONCENTRATE_API_KEY',
      }),
    ).resolves.toEqual({
      kind: 'Compatible',
      compatibility: {
        provider: 'concentrate',
        model: 'deepinfra/gemma-4-e4b',
        contextWindowTokens: 131_072,
        maximumOutputTokens: 32_768,
        thinkingLevel: 'low',
        credentialSource: 'CONCENTRATE_API_KEY',
        toolCalls: 'Supported',
        usageAccounting: 'Required',
      },
    });
  });

  it('admits the paid DeepSeek Flash route with the same accounted Pi boundary', async () => {
    await expect(
      inspectPiModelCompatibility({
        provider: 'concentrate',
        model: 'deepinfra/deepseek-v4-flash-0731',
        thinkingLevel: 'low',
        maximumOutputTokens: 8_192,
        credentialSource: 'CONCENTRATE_API_KEY',
      }),
    ).resolves.toEqual({
      kind: 'Compatible',
      compatibility: {
        provider: 'concentrate',
        model: 'deepinfra/deepseek-v4-flash-0731',
        contextWindowTokens: 131_072,
        maximumOutputTokens: 8_192,
        thinkingLevel: 'low',
        credentialSource: 'CONCENTRATE_API_KEY',
        toolCalls: 'Supported',
        usageAccounting: 'Required',
      },
    });
  });

  it('rejects an unknown model', async () => {
    await expect(
      inspectPiModelCompatibility({
        provider: 'concentrate',
        model: 'absent',
        thinkingLevel: 'low',
        maximumOutputTokens: 8_192,
        credentialSource: 'CONCENTRATE_API_KEY',
      }),
    ).resolves.toEqual({ kind: 'ModelUnknown' });
  });

  it('rejects an output reservation above the pinned model maximum', async () => {
    await expect(
      inspectPiModelCompatibility({
        provider: 'concentrate',
        model: 'deepinfra/gemma-4-e4b',
        thinkingLevel: 'low',
        maximumOutputTokens: 32_769,
        credentialSource: 'CONCENTRATE_API_KEY',
      }),
    ).resolves.toEqual({ kind: 'MaximumOutputTokensUnsupported' });
  });
});
