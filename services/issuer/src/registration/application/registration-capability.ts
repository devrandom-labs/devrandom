import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface IssuedRegistrationCapabilities {
  readonly cli: {
    readonly value: string;
    readonly hash: string;
  };
  readonly browser: {
    readonly value: string;
    readonly hash: string;
  };
}

export interface RegistrationCapabilityDerivation {
  issue(creationKey: string): IssuedRegistrationCapabilities;
}

export type CliCapabilityVerification =
  { readonly kind: 'cli-capability-verified' } | { readonly kind: 'capability-rejected' };

export type BrowserCapabilityVerification =
  { readonly kind: 'browser-capability-verified' } | { readonly kind: 'capability-rejected' };

function capabilityHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashesMatch(value: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(capabilityHash(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return timingSafeEqual(actual, expected);
}

export function issueRegistrationCapabilities(): IssuedRegistrationCapabilities {
  const cli = `cli_${randomBytes(32).toString('base64url')}`;
  const browser = `browser_${randomBytes(32).toString('base64url')}`;
  return {
    cli: { value: cli, hash: capabilityHash(cli) },
    browser: { value: browser, hash: capabilityHash(browser) },
  };
}

export function registrationCapabilityDerivation(secret: string): RegistrationCapabilityDerivation {
  if (secret.length < 21) {
    throw new Error('Registration capability derivation requires a secret with at least 21 bytes');
  }
  return {
    issue(creationKey) {
      if (!/^registration_[A-Za-z0-9_-]{43}$/u.test(creationKey)) {
        throw new Error('Registration creation key is invalid');
      }
      const cli = `cli_${derivedCapability(secret, 'cli', creationKey)}`;
      const browser = `browser_${derivedCapability(secret, 'browser', creationKey)}`;
      return {
        cli: { value: cli, hash: capabilityHash(cli) },
        browser: { value: browser, hash: capabilityHash(browser) },
      };
    },
  };
}

export function registrationCreationKeyHash(creationKey: string): string {
  return capabilityHash(creationKey);
}

function derivedCapability(
  secret: string,
  purpose: 'cli' | 'browser',
  creationKey: string,
): string {
  return createHmac('sha256', secret)
    .update('devrandom-registration-capability\0', 'utf8')
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(creationKey, 'utf8')
    .digest('base64url');
}

export function verifyCliCapability(
  value: string,
  expectedHash: string,
): CliCapabilityVerification {
  if (!/^cli_[A-Za-z0-9_-]{43}$/u.test(value) || !hashesMatch(value, expectedHash)) {
    return { kind: 'capability-rejected' };
  }
  return { kind: 'cli-capability-verified' };
}

export function verifyBrowserCapability(
  value: string,
  expectedHash: string,
): BrowserCapabilityVerification {
  if (!/^browser_[A-Za-z0-9_-]{43}$/u.test(value) || !hashesMatch(value, expectedHash)) {
    return { kind: 'capability-rejected' };
  }
  return { kind: 'browser-capability-verified' };
}
