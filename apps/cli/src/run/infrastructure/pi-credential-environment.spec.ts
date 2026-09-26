import { describe, expect, it } from 'vitest';

import { EnvironmentPiCredential } from './pi-credential-environment.js';

describe('Pi credential environment', () => {
  it('releases only the exact reviewed provider credential source', async () => {
    const environment = {
      CONCENTRATE_API_KEY: 'provider-secret',
      DEEPSEEK_API_KEY: 'must-never-become-a-model-credential',
      DEVRANDOM_ATLAS_URI: 'must-never-become-a-model-credential',
      DEVRANDOM_WORK_ACCESS_SECRET: 'must-never-enter-pi',
    };
    const credentials = new EnvironmentPiCredential(environment);

    await expect(
      credentials.acquire({ provider: 'concentrate', credentialSource: 'CONCENTRATE_API_KEY' }),
    ).resolves.toEqual({ kind: 'Available', secret: 'provider-secret' });
    await expect(
      credentials.acquire({ provider: 'concentrate', credentialSource: 'DEVRANDOM_ATLAS_URI' }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    await expect(
      credentials.acquire({
        provider: 'concentrate',
        credentialSource: 'DEVRANDOM_WORK_ACCESS_SECRET',
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    await expect(
      credentials.acquire({ provider: 'deepseek', credentialSource: 'DEEPSEEK_API_KEY' }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    await expect(
      credentials.acquire({ provider: 'anthropic', credentialSource: 'CONCENTRATE_API_KEY' }),
    ).resolves.toEqual({ kind: 'Unavailable' });
  });
});
