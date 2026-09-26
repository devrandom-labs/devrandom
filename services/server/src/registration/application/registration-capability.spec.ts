import { describe, expect, it } from 'vitest';

import {
  issueRegistrationCapabilities,
  registrationCapabilityDerivation,
  registrationCreationKeyHash,
  verifyBrowserCapability,
  verifyCliCapability,
} from './registration-capability.js';

describe('Registration Session bearer capabilities', () => {
  it('derives stable separated capabilities for an equivalent creation retry', () => {
    const creationKey = `registration_${'r'.repeat(43)}`;
    const derivation = registrationCapabilityDerivation('0123456789abcdefghijk');

    const first = derivation.issue(creationKey);
    const retry = derivation.issue(creationKey);
    const other = derivation.issue(`registration_${'s'.repeat(43)}`);

    expect(retry).toEqual(first);
    expect(first.cli.value).not.toBe(first.browser.value);
    expect(other).not.toEqual(first);
    expect(first.cli.hash).not.toContain(creationKey);
    expect(registrationCreationKeyHash(creationKey)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('creates unrelated purpose-specific capabilities and stores only their hashes', () => {
    const issued = issueRegistrationCapabilities();

    expect(issued.cli.value).toMatch(/^cli_[A-Za-z0-9_-]{43}$/u);
    expect(issued.browser.value).toMatch(/^browser_[A-Za-z0-9_-]{43}$/u);
    expect(issued.cli.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(issued.browser.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(issued.cli.hash).not.toBe(issued.browser.hash);
    expect(issued.cli.hash).not.toContain(issued.cli.value);
    expect(issued.browser.hash).not.toContain(issued.browser.value);
  });

  it('accepts each capability only for its own purpose and exact stored hash', () => {
    const issued = issueRegistrationCapabilities();

    expect(verifyCliCapability(issued.cli.value, issued.cli.hash)).toEqual({
      kind: 'cli-capability-verified',
    });
    expect(verifyBrowserCapability(issued.browser.value, issued.browser.hash)).toEqual({
      kind: 'browser-capability-verified',
    });
    expect(verifyCliCapability(issued.browser.value, issued.cli.hash)).toEqual({
      kind: 'capability-rejected',
    });
    expect(verifyBrowserCapability(issued.cli.value, issued.browser.hash)).toEqual({
      kind: 'capability-rejected',
    });
    expect(verifyCliCapability(issued.cli.value, issued.browser.hash)).toEqual({
      kind: 'capability-rejected',
    });
  });
});
