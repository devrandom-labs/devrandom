import type { DevrandomServerRegistration } from '../src/server.js';
import type { UserRegistrationConversation } from '../src/registration/application/user-registration.js';
import { RegistrationRequestQuota } from '../src/registration/route/registration-request-quota.js';

function unavailable(): Promise<never> {
  return Promise.reject(new Error('registration fixture is not configured for requests'));
}

const unavailableEnrollment: UserRegistrationConversation = {
  create() {
    return unavailable();
  },
  cliSession() {
    return unavailable();
  },
  browserSession() {
    return unavailable();
  },
  submitAidProof() {
    return unavailable();
  },
  approve() {
    return unavailable();
  },
  reject() {
    return unavailable();
  },
};

export function registrationRoutesFixture(): DevrandomServerRegistration {
  return {
    enrollment: unavailableEnrollment,
    browserOrigin: 'http://127.0.0.1:3210',
    quota: new RegistrationRequestQuota(100, 60_000, () => Date.now()),
  };
}
