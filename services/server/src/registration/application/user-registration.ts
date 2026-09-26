import type {
  BrowserApprovalRequest,
  CreateRegistrationRequest,
  SubmitAidProofRequest,
} from '@devrandom/protocol';

import type {
  RegistrationCreationOutcome,
  RegistrationEnrollment,
  RegistrationSnapshot,
} from './registration-enrollment.js';
import type { RegistrationIssuance } from './registration-issuance.js';

export interface UserRegistrationConversation {
  create(
    request: CreateRegistrationRequest,
    creationKey: string,
  ): Promise<RegistrationCreationOutcome>;
  cliSession(registrationId: string, capability: string): Promise<RegistrationSnapshot>;
  browserSession(registrationId: string, capability: string): Promise<RegistrationSnapshot>;
  submitAidProof(
    registrationId: string,
    capability: string,
    request: SubmitAidProofRequest,
  ): Promise<RegistrationSnapshot>;
  approve(
    registrationId: string,
    capability: string,
    request: BrowserApprovalRequest,
  ): Promise<RegistrationSnapshot>;
  reject(registrationId: string, capability: string): Promise<RegistrationSnapshot>;
}

export class UserRegistration implements UserRegistrationConversation {
  readonly #enrollment: RegistrationEnrollment;
  readonly #issuance: RegistrationIssuance;

  constructor(enrollment: RegistrationEnrollment, issuance: RegistrationIssuance) {
    this.#enrollment = enrollment;
    this.#issuance = issuance;
  }

  create(
    request: CreateRegistrationRequest,
    creationKey: string,
  ): Promise<RegistrationCreationOutcome> {
    return this.#enrollment.create(request, creationKey);
  }

  async cliSession(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    return this.#issuance.advance(await this.#enrollment.cliSession(registrationId, capability));
  }

  async browserSession(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    return this.#issuance.advance(
      await this.#enrollment.browserSession(registrationId, capability),
    );
  }

  async submitAidProof(
    registrationId: string,
    capability: string,
    request: SubmitAidProofRequest,
  ): Promise<RegistrationSnapshot> {
    return this.#issuance.advance(
      await this.#enrollment.submitAidProof(registrationId, capability, request),
    );
  }

  async approve(
    registrationId: string,
    capability: string,
    request: BrowserApprovalRequest,
  ): Promise<RegistrationSnapshot> {
    return this.#issuance.advance(
      await this.#enrollment.approve(registrationId, capability, request),
    );
  }

  reject(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    return this.#enrollment.reject(registrationId, capability);
  }
}
