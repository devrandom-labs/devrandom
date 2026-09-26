import { inspectPiModelCompatibility, type PiModelProfile } from '@devrandom/runtime';

import type {
  BaselineHarnessModelInspection,
  BaselineHarnessModelInspectionOutcome,
} from '../application/baseline-harness-preparation.js';

type ThinkingLevel = PiModelProfile['thinkingLevel'];

export interface HarnessModelEnvironment {
  readonly DEVRANDOM_MODEL_PROVIDER: string | undefined;
  readonly DEVRANDOM_MODEL_ID: string | undefined;
  readonly DEVRANDOM_MODEL_THINKING_LEVEL: string | undefined;
  readonly DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS: string | undefined;
  readonly DEVRANDOM_MODEL_CREDENTIAL_SOURCE: string | undefined;
}

function thinkingLevel(source: string | undefined): ThinkingLevel | undefined {
  switch (source) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return source;
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function decodeProfile(environment: HarnessModelEnvironment): PiModelProfile | undefined {
  const provider = environment.DEVRANDOM_MODEL_PROVIDER;
  const model = environment.DEVRANDOM_MODEL_ID;
  const thinking = thinkingLevel(environment.DEVRANDOM_MODEL_THINKING_LEVEL);
  const maximumOutputSource = environment.DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS;
  const credentialSource = environment.DEVRANDOM_MODEL_CREDENTIAL_SOURCE;
  if (
    provider === undefined ||
    !/^[a-z][a-z0-9._-]{0,95}$/u.test(provider) ||
    model === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(model) ||
    thinking === undefined ||
    maximumOutputSource === undefined ||
    !/^[1-9][0-9]*$/u.test(maximumOutputSource) ||
    credentialSource === undefined ||
    !/^[A-Z][A-Z0-9_]{0,95}$/u.test(credentialSource)
  ) {
    return undefined;
  }
  const maximumOutputTokens = Number(maximumOutputSource);
  if (!Number.isSafeInteger(maximumOutputTokens)) {
    return undefined;
  }
  return { provider, model, thinkingLevel: thinking, maximumOutputTokens, credentialSource };
}

export class EnvironmentPiModelInspection implements BaselineHarnessModelInspection {
  readonly #profile: PiModelProfile | undefined;

  constructor(environment: HarnessModelEnvironment) {
    this.#profile = decodeProfile(environment);
  }

  async inspect(): Promise<BaselineHarnessModelInspectionOutcome> {
    return this.#profile === undefined
      ? { kind: 'ModelConfigurationRequired' }
      : inspectPiModelCompatibility(this.#profile);
  }
}
