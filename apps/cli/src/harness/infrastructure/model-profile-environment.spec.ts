import { describe, expect, it } from 'vitest';

import { EnvironmentPiModelInspection } from './model-profile-environment.js';

describe('H1 model profile environment', () => {
  it('requires the complete non-secret model profile', async () => {
    await expect(
      new EnvironmentPiModelInspection({
        DEVRANDOM_MODEL_PROVIDER: undefined,
        DEVRANDOM_MODEL_ID: undefined,
        DEVRANDOM_MODEL_THINKING_LEVEL: undefined,
        DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS: undefined,
        DEVRANDOM_MODEL_CREDENTIAL_SOURCE: undefined,
      }).inspect(),
    ).resolves.toEqual({ kind: 'ModelConfigurationRequired' });
  });

  it('decodes the profile once and inspects the pinned Pi catalogue without reading the secret', async () => {
    const environment = {
      DEVRANDOM_MODEL_PROVIDER: 'concentrate',
      DEVRANDOM_MODEL_ID: 'deepinfra/gemma-4-e4b',
      DEVRANDOM_MODEL_THINKING_LEVEL: 'low',
      DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS: '32768',
      DEVRANDOM_MODEL_CREDENTIAL_SOURCE: 'CONCENTRATE_API_KEY',
      CONCENTRATE_API_KEY: 'must-not-be-read-during-h1',
    };
    await expect(new EnvironmentPiModelInspection(environment).inspect()).resolves.toMatchObject({
      kind: 'Compatible',
      compatibility: {
        provider: 'concentrate',
        model: 'deepinfra/gemma-4-e4b',
        credentialSource: 'CONCENTRATE_API_KEY',
      },
    });
  });

  it('rejects an invalid profile as missing configuration', async () => {
    await expect(
      new EnvironmentPiModelInspection({
        DEVRANDOM_MODEL_PROVIDER: 'Concentrate',
        DEVRANDOM_MODEL_ID: 'deepinfra/gemma-4-e4b',
        DEVRANDOM_MODEL_THINKING_LEVEL: 'sometimes',
        DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS: '-1',
        DEVRANDOM_MODEL_CREDENTIAL_SOURCE: 'deepseek-key',
      }).inspect(),
    ).resolves.toEqual({ kind: 'ModelConfigurationRequired' });
  });
});
