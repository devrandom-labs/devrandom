import { describe, expect, it, vi } from 'vitest';

import { IssuerReadiness } from './issuer-readiness.js';

describe('issuer readiness', () => {
  it('requires current issuer, credential schema, and Registration Session evidence', async () => {
    const verifyIssuer = vi.fn(() => Promise.resolve());
    const verifyCredentialSchema = vi.fn(() => Promise.resolve());
    const verifyRegistrations = vi.fn(() => Promise.resolve());
    const readiness = new IssuerReadiness(
      { verify: verifyIssuer },
      { verify: verifyCredentialSchema },
      { verify: verifyRegistrations },
    );

    await expect(readiness.verify()).resolves.toBeUndefined();
    expect(verifyIssuer).toHaveBeenCalledOnce();
    expect(verifyCredentialSchema).toHaveBeenCalledOnce();
    expect(verifyRegistrations).toHaveBeenCalledOnce();
  });

  it('rejects readiness when MongoDB is unavailable', async () => {
    const readiness = new IssuerReadiness(
      { verify: () => Promise.resolve() },
      { verify: () => Promise.resolve() },
      { verify: () => Promise.reject(new Error('MongoDB unavailable')) },
    );

    await expect(readiness.verify()).rejects.toThrow('MongoDB unavailable');
  });
});
