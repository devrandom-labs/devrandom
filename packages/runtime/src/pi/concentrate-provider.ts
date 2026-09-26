import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createProvider, type Provider } from '@earendil-works/pi-ai';
import type { ConcentrateUsage } from './concentrate-usage.js';

export const concentrateProviderId = 'concentrate';

export function createConcentrateProvider(usage: ConcentrateUsage): Provider<'openai-responses'> {
  const api = openAIResponsesApi();
  return createProvider({
    id: concentrateProviderId,
    name: 'Concentrate AI',
    baseUrl: 'https://api.concentrate.ai/v1',
    auth: {
      apiKey: {
        name: 'Concentrate AI API key',
        resolve: ({ credential }) =>
          Promise.resolve(
            credential?.key === undefined
              ? undefined
              : { auth: { apiKey: credential.key }, source: 'runtime credential' },
          ),
      },
    },
    models: [
      {
        id: 'deepinfra/gemma-4-e4b',
        name: 'Gemma 4 E4B on DeepInfra',
        api: 'openai-responses',
        provider: concentrateProviderId,
        baseUrl: 'https://api.concentrate.ai/v1',
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
        input: ['text'],
        cost: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 32_768,
        samplingParams: {
          routing: {
            provider: { fallbacks: ['deepinfra'], sort: 'cost' },
            model: { fallbacks: [] },
          },
        },
        compat: {
          supportsLongCacheRetention: false,
          supportsStrictMode: false,
          supportsOpenAIGrammarTools: false,
          supportsAdditionalTools: false,
          supportsToolSearch: false,
          supportsExplicitPromptCacheMode: false,
          supportsMaxOutputTokens: true,
        },
      },
      {
        id: 'deepinfra/deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731 on DeepInfra',
        api: 'openai-responses',
        provider: concentrateProviderId,
        baseUrl: 'https://api.concentrate.ai/v1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 32_768,
        samplingParams: {
          routing: {
            provider: { fallbacks: ['deepinfra'], sort: 'cost' },
            model: { fallbacks: [] },
          },
        },
        compat: {
          supportsLongCacheRetention: false,
          supportsStrictMode: false,
          supportsOpenAIGrammarTools: false,
          supportsAdditionalTools: false,
          supportsToolSearch: false,
          supportsExplicitPromptCacheMode: false,
          supportsMaxOutputTokens: true,
        },
      },
    ],
    api: {
      ...api,
      stream: (model, context, options) =>
        api.stream(model, context, {
          ...options,
          fetch: (input, init) => usage.fetch(options?.fetch ?? globalThis.fetch, input, init),
        }),
      streamSimple: (model, context, options) =>
        api.streamSimple(model, context, {
          ...options,
          fetch: (input, init) => usage.fetch(options?.fetch ?? globalThis.fetch, input, init),
        }),
    },
  });
}
