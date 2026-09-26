import type { PiCredentialAcquisition, PiCredentialSource } from '@devrandom/runtime';

export interface PiCredentialEnvironment {
  readonly CONCENTRATE_API_KEY: string | undefined;
}

export class EnvironmentPiCredential implements PiCredentialSource {
  readonly #environment: PiCredentialEnvironment;

  constructor(environment: PiCredentialEnvironment) {
    this.#environment = environment;
  }

  acquire(input: {
    readonly provider: string;
    readonly credentialSource: string;
  }): Promise<PiCredentialAcquisition> {
    if (input.provider !== 'concentrate' || input.credentialSource !== 'CONCENTRATE_API_KEY') {
      return Promise.resolve({ kind: 'Unavailable' });
    }
    const secret = this.#environment.CONCENTRATE_API_KEY;
    return Promise.resolve(
      secret !== undefined && secret.length > 0 && secret.length <= 16 * 1_024
        ? { kind: 'Available', secret }
        : { kind: 'Unavailable' },
    );
  }
}
