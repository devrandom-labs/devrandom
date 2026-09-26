import { describe, expect, it, vi } from 'vitest';

import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  issuerAid,
  issuerOobi,
  type IssuerIdentityBootstrapOutcome,
} from '@devrandom/identity';

import { issuerProfileFixture } from '../../test/issuer-profile-fixture.js';
import type { IssuerBootstrapConfiguration } from '../domain/issuer-configuration.js';
import { issuerBran, issuerProfilePath, keriaUrl } from '../domain/issuer-configuration.js';
import type { IssuerProfileWriteOutcome } from '../infrastructure/issuer-profile-file.js';
import { bootstrapDevrandomIssuer } from './issuer-bootstrap.js';

const configuration: IssuerBootstrapConfiguration = {
  bran: issuerBran('0123456789abcdefghijk'),
  keriaAdminUrl: keriaUrl('http://keria:3901'),
  keriaBootUrl: keriaUrl('http://keria:3903'),
  profilePath: issuerProfilePath('/var/lib/devrandom/issuer-profile.json'),
  securityTier: 'low',
  witnessPolicy: { kind: 'unwitnessed' },
  registryPolicy: { kind: 'backerless' },
  operationTimeoutMs: 30_000,
  oobiAvailabilityTimeoutMs: 10_000,
};

const identity = {
  controllerAid: controllerAid('EIFG_uqfr1yN560LoHYHfvPAhxQ5sN6xZZT_E3h7d2tL'),
  agentAid: agentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz'),
  issuerAid: issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk'),
  issuerOobi: issuerOobi(
    'http://keria:3902/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  ),
  registryId: credentialRegistryId('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao'),
};

function identityOutcome(
  kind: IssuerIdentityBootstrapOutcome['kind'],
): IssuerIdentityBootstrapOutcome {
  return { kind, identity };
}

describe('issuer bootstrap application', () => {
  it('records a complete profile only after identity provisioning succeeds', async () => {
    const recordIssuerProfile = vi.fn(() =>
      Promise.resolve<IssuerProfileWriteOutcome>({ kind: 'issuer-profile-recorded' }),
    );
    const result = await bootstrapDevrandomIssuer(configuration, {
      provisionIssuerIdentity: vi.fn(() =>
        Promise.resolve(identityOutcome('issuer-identity-provisioned')),
      ),
      verifyMandateSchemas: () => ({ kind: 'Verified' }),
      readIssuerProfile: vi.fn(() => Promise.resolve(undefined)),
      recordIssuerProfile,
    });

    expect(result).toEqual({
      kind: 'issuer-provisioned',
      profile: issuerProfileFixture(),
    });
    expect(recordIssuerProfile).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(configuration.bran);
  });

  it('returns the existing outcome when every durable identity is unchanged', async () => {
    const profile = issuerProfileFixture();
    const result = await bootstrapDevrandomIssuer(configuration, {
      provisionIssuerIdentity: vi.fn(() =>
        Promise.resolve(identityOutcome('existing-issuer-identity-verified')),
      ),
      verifyMandateSchemas: () => ({ kind: 'Verified' }),
      readIssuerProfile: vi.fn(() => Promise.resolve(profile)),
      recordIssuerProfile: vi.fn(() =>
        Promise.resolve<IssuerProfileWriteOutcome>({ kind: 'existing-issuer-profile' }),
      ),
    });

    expect(result).toEqual({ kind: 'existing-issuer-verified', profile });
  });

  it('fails closed when the recorded profile identifies another issuer', async () => {
    const existing = issuerProfileFixture();
    const result = await bootstrapDevrandomIssuer(configuration, {
      provisionIssuerIdentity: vi.fn(() =>
        Promise.resolve(identityOutcome('issuer-identity-provisioned')),
      ),
      verifyMandateSchemas: () => ({ kind: 'Verified' }),
      readIssuerProfile: vi.fn(() => Promise.resolve(undefined)),
      recordIssuerProfile: vi.fn(() =>
        Promise.resolve<IssuerProfileWriteOutcome>({
          kind: 'conflicting-issuer-profile',
          existing,
        }),
      ),
    });

    expect(result).toEqual({
      kind: 'issuer-bootstrap-rejected',
      error: {
        kind: 'issuer-profile-conflict',
        existingIssuerAid: existing.issuerAid,
        actualIssuerAid: identity.issuerAid,
      },
    });
  });

  it('rejects a recorded policy mismatch before provisioning', async () => {
    const profile = issuerProfileFixture();
    const provisionIssuerIdentity = vi.fn(() =>
      Promise.resolve(identityOutcome('existing-issuer-identity-verified')),
    );
    const result = await bootstrapDevrandomIssuer(
      { ...configuration, securityTier: 'high' },
      {
        provisionIssuerIdentity,
        verifyMandateSchemas: () => ({ kind: 'Verified' }),
        readIssuerProfile: vi.fn(() => Promise.resolve(profile)),
        recordIssuerProfile: vi.fn(() =>
          Promise.resolve<IssuerProfileWriteOutcome>({ kind: 'existing-issuer-profile' }),
        ),
      },
    );

    expect(result).toEqual({
      kind: 'issuer-bootstrap-rejected',
      error: {
        kind: 'issuer-profile-policy-conflict',
        field: 'securityTier',
      },
    });
    expect(provisionIssuerIdentity).not.toHaveBeenCalled();
  });

  it('rejects deterministic mandate schema drift before touching issuer custody', async () => {
    const provisionIssuerIdentity = vi.fn(() =>
      Promise.resolve(identityOutcome('existing-issuer-identity-verified')),
    );

    const result = await bootstrapDevrandomIssuer(configuration, {
      provisionIssuerIdentity,
      verifyMandateSchemas: () => ({
        kind: 'Mismatch',
        schema: 'TaskMandate',
        expectedSaid: 'ENHDTz_UNj2tXW4iukYWDtQoXEmP2P9slWH6wXKH-CY7',
      }),
      readIssuerProfile: vi.fn(() => Promise.resolve(undefined)),
      recordIssuerProfile: vi.fn(() =>
        Promise.resolve<IssuerProfileWriteOutcome>({ kind: 'issuer-profile-recorded' }),
      ),
    });

    expect(result).toEqual({
      kind: 'issuer-bootstrap-rejected',
      error: {
        kind: 'mandate-schema-catalog-invalid',
        schema: 'TaskMandate',
        expectedSaid: 'ENHDTz_UNj2tXW4iukYWDtQoXEmP2P9slWH6wXKH-CY7',
      },
    });
    expect(provisionIssuerIdentity).not.toHaveBeenCalled();
  });
});
