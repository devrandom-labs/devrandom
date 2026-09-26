export type RegistrationQuotaAdmission =
  | { readonly kind: 'registration-request-admitted' }
  | { readonly kind: 'registration-request-limited'; readonly retryAfterSeconds: number };

interface RegistrationQuotaWindow {
  requests: number;
  resetAt: number;
}

export class RegistrationRequestQuota {
  readonly #maximumRequests: number;
  readonly #windowMilliseconds: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, RegistrationQuotaWindow>();

  constructor(maximumRequests: number, windowMilliseconds: number, now: () => number) {
    if (
      !Number.isSafeInteger(maximumRequests) ||
      maximumRequests < 1 ||
      !Number.isSafeInteger(windowMilliseconds) ||
      windowMilliseconds < 1
    ) {
      throw new Error('registration request quota requires positive integer policy values');
    }
    this.#maximumRequests = maximumRequests;
    this.#windowMilliseconds = windowMilliseconds;
    this.#now = now;
  }

  admit(key: string): RegistrationQuotaAdmission {
    const observedAt = this.#now();
    const existing = this.#windows.get(key);
    if (existing === undefined || observedAt >= existing.resetAt) {
      this.#windows.set(key, {
        requests: 1,
        resetAt: observedAt + this.#windowMilliseconds,
      });
      return { kind: 'registration-request-admitted' };
    }
    if (existing.requests >= this.#maximumRequests) {
      return {
        kind: 'registration-request-limited',
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - observedAt) / 1_000)),
      };
    }
    existing.requests += 1;
    return { kind: 'registration-request-admitted' };
  }
}
