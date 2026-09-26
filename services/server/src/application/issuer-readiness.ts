import type { VerifiedIssuerReadiness } from '@devrandom/identity';

export interface RegistrationSessionReadiness {
  verify(): Promise<void>;
}

export interface CredentialSchemaReadiness {
  verify(): Promise<void>;
}

export class IssuerReadiness {
  readonly #issuer: VerifiedIssuerReadiness;
  readonly #credentialSchema: CredentialSchemaReadiness;
  readonly #registrations: RegistrationSessionReadiness;

  constructor(
    issuer: VerifiedIssuerReadiness,
    credentialSchema: CredentialSchemaReadiness,
    registrations: RegistrationSessionReadiness,
  ) {
    this.#issuer = issuer;
    this.#credentialSchema = credentialSchema;
    this.#registrations = registrations;
  }

  async verify(): Promise<void> {
    await Promise.all([
      this.#issuer.verify(),
      this.#credentialSchema.verify(),
      this.#registrations.verify(),
    ]);
  }
}
