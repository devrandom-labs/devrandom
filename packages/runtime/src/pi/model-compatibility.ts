import type { HarnessModelCompatibility } from '@devrandom/domain';
import { getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { concentrateProviderId, createConcentrateProvider } from './concentrate-provider.js';
import { ConcentrateUsage } from './concentrate-usage.js';

export interface PiModelProfile {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: HarnessModelCompatibility['thinkingLevel'];
  readonly maximumOutputTokens: number;
  readonly credentialSource: string;
}

export type PiModelCompatibilityInspection =
  | { readonly kind: 'Compatible'; readonly compatibility: HarnessModelCompatibility }
  | {
      readonly kind:
        | 'ProviderUnknown'
        | 'ModelUnknown'
        | 'TextInputUnsupported'
        | 'ThinkingLevelUnsupported'
        | 'MaximumOutputTokensUnsupported'
        | 'ToolProtocolUnsupported'
        | 'UsageAccountingUnsupported'
        | 'InvalidModelMetadata'
        | 'PiCatalogueUnavailable';
    };

function hasReviewedToolProtocol(api: string): boolean {
  switch (api) {
    case 'openai-completions':
    case 'mistral-conversations':
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
    case 'anthropic-messages':
    case 'bedrock-converse-stream':
    case 'google-generative-ai':
    case 'google-vertex':
    case 'pi-messages':
      return true;
    default:
      return false;
  }
}

export async function inspectPiModelCompatibility(
  profile: PiModelProfile,
): Promise<PiModelCompatibilityInspection> {
  let runtime: ModelRuntime;
  try {
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  } catch {
    return { kind: 'PiCatalogueUnavailable' };
  }
  runtime.registerNativeProvider(createConcentrateProvider(new ConcentrateUsage()));
  if (runtime.getProvider(profile.provider) === undefined) {
    return { kind: 'ProviderUnknown' };
  }
  const model = runtime.getModel(profile.provider, profile.model);
  if (model === undefined) {
    return { kind: 'ModelUnknown' };
  }
  if (
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens < 1
  ) {
    return { kind: 'InvalidModelMetadata' };
  }
  if (!model.input.includes('text')) {
    return { kind: 'TextInputUnsupported' };
  }
  if (!getSupportedThinkingLevels(model).includes(profile.thinkingLevel)) {
    return { kind: 'ThinkingLevelUnsupported' };
  }
  if (
    !Number.isSafeInteger(profile.maximumOutputTokens) ||
    profile.maximumOutputTokens < 1 ||
    profile.maximumOutputTokens > model.maxTokens ||
    profile.maximumOutputTokens >= model.contextWindow
  ) {
    return { kind: 'MaximumOutputTokensUnsupported' };
  }
  if (!hasReviewedToolProtocol(model.api)) {
    return { kind: 'ToolProtocolUnsupported' };
  }
  if (model.provider !== concentrateProviderId) return { kind: 'UsageAccountingUnsupported' };
  return {
    kind: 'Compatible',
    compatibility: {
      provider: model.provider,
      model: model.id,
      contextWindowTokens: model.contextWindow,
      maximumOutputTokens: profile.maximumOutputTokens,
      thinkingLevel: profile.thinkingLevel,
      credentialSource: profile.credentialSource,
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
  };
}
