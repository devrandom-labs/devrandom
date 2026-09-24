import { describe, expect, it } from 'vitest';

import { credentialSchema } from '@devrandom/protocol';

import { IssuerFailure } from '../domain/issuer-error.js';
import {
  loadIssuerBootstrapConfiguration,
  loadIssuerRegistrationConfiguration,
  loadIssuerServerAddress,
} from './environment-issuer-configuration.js';

const validEnvironment = {
  DEVRANDOM_ISSUER_BRAN: '0123456789abcdefghijk',
  DEVRANDOM_ISSUER_PROFILE_PATH: '/var/lib/devrandom/issuer-profile.json',
  DEVRANDOM_ISSUER_REGISTRY_POLICY: 'backerless',
  DEVRANDOM_ISSUER_WITNESS_POLICY: 'unwitnessed',
  DEVRANDOM_KERIA_ADMIN_URL: 'http://keria:3901',
  DEVRANDOM_KERIA_BOOT_URL: 'http://keria:3903',
  DEVRANDOM_SIGNIFY_TIER: 'low',
  DEVRANDOM_MONGODB_URI: 'mongodb://mongodb:27017/devrandom',
  DEVRANDOM_REGISTRATION_SITE_URL: 'http://127.0.0.1:3210',
  DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: `http://issuer:3211/oobi/${credentialSchema.$id}`,
} as const;

function configurationFailure(environment: Parameters<typeof loadIssuerBootstrapConfiguration>[0]) {
  try {
    loadIssuerBootstrapConfiguration(environment);
  } catch (cause) {
    expect(cause).toBeInstanceOf(IssuerFailure);
    if (cause instanceof IssuerFailure) {
      return cause.detail;
    }
    throw cause;
  }
  throw new Error('configuration was unexpectedly accepted');
}

describe('issuer bootstrap configuration', () => {
  it('decodes the explicit hackathon identity policy', () => {
    expect(loadIssuerBootstrapConfiguration(validEnvironment)).toMatchObject({
      bran: validEnvironment.DEVRANDOM_ISSUER_BRAN,
      keriaAdminUrl: validEnvironment.DEVRANDOM_KERIA_ADMIN_URL,
      keriaBootUrl: validEnvironment.DEVRANDOM_KERIA_BOOT_URL,
      profilePath: validEnvironment.DEVRANDOM_ISSUER_PROFILE_PATH,
      securityTier: 'low',
      witnessPolicy: { kind: 'unwitnessed' },
      registryPolicy: { kind: 'backerless' },
    });
  });

  it('rejects a missing issuer secret without generating one', () => {
    expect(
      configurationFailure({
        ...validEnvironment,
        DEVRANDOM_ISSUER_BRAN: undefined,
      }),
    ).toEqual({
      field: 'DEVRANDOM_ISSUER_BRAN',
      kind: 'issuer-configuration-invalid',
      reason: 'missing',
    });
  });

  it('rejects implicit witness and registry policies', () => {
    expect(
      configurationFailure({
        ...validEnvironment,
        DEVRANDOM_ISSUER_WITNESS_POLICY: undefined,
      }),
    ).toEqual({
      field: 'DEVRANDOM_ISSUER_WITNESS_POLICY',
      kind: 'issuer-configuration-invalid',
      reason: 'missing',
    });
    expect(
      configurationFailure({
        ...validEnvironment,
        DEVRANDOM_ISSUER_REGISTRY_POLICY: undefined,
      }),
    ).toEqual({
      field: 'DEVRANDOM_ISSUER_REGISTRY_POLICY',
      kind: 'issuer-configuration-invalid',
      reason: 'missing',
    });
  });

  it('rejects credential-bearing KERIA URLs', () => {
    expect(
      configurationFailure({
        ...validEnvironment,
        DEVRANDOM_KERIA_ADMIN_URL: 'http://user:password@keria:3901',
      }),
    ).toEqual({
      field: 'DEVRANDOM_KERIA_ADMIN_URL',
      kind: 'issuer-configuration-invalid',
      reason: 'invalid',
    });
  });

  it('rejects KERIA endpoints with hidden query configuration', () => {
    expect(
      configurationFailure({
        ...validEnvironment,
        DEVRANDOM_KERIA_ADMIN_URL: 'http://keria:3901?token=hidden',
      }),
    ).toEqual({
      field: 'DEVRANDOM_KERIA_ADMIN_URL',
      kind: 'issuer-configuration-invalid',
      reason: 'invalid',
    });
  });
});

describe('issuer server address', () => {
  it('uses the local defaults when no override is present', () => {
    expect(loadIssuerServerAddress(validEnvironment)).toEqual({
      host: '127.0.0.1',
      port: 3211,
    });
  });

  it('decodes an explicit listener override', () => {
    expect(loadIssuerServerAddress({ ...validEnvironment, HOST: '0.0.0.0', PORT: '0' })).toEqual({
      host: '0.0.0.0',
      port: 0,
    });
  });

  it('rejects a port outside the TCP range', () => {
    expect(() => loadIssuerServerAddress({ ...validEnvironment, PORT: '70000' })).toThrow(
      IssuerFailure,
    );
  });
});

describe('issuer registration configuration', () => {
  it('requires an explicit MongoDB endpoint and browser origin', () => {
    expect(loadIssuerRegistrationConfiguration(validEnvironment)).toEqual({
      mongodbUri: validEnvironment.DEVRANDOM_MONGODB_URI,
      registrationSiteUrl: validEnvironment.DEVRANDOM_REGISTRATION_SITE_URL,
      credentialSchemaOobiUrl: validEnvironment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL,
      lifetimeMs: 300_000,
      pollIntervalMs: 1_000,
      replayRetentionMs: 300_000,
      maximumRequestsPerMinute: 120,
    });
    expect(() =>
      loadIssuerRegistrationConfiguration({
        ...validEnvironment,
        DEVRANDOM_MONGODB_URI: undefined,
      }),
    ).toThrow(IssuerFailure);
  });

  it('rejects MongoDB credentials and a site URL with a path', () => {
    expect(() =>
      loadIssuerRegistrationConfiguration({
        ...validEnvironment,
        DEVRANDOM_MONGODB_URI: 'mongodb://user:secret@mongodb:27017/devrandom',
      }),
    ).toThrow(IssuerFailure);
    expect(() =>
      loadIssuerRegistrationConfiguration({
        ...validEnvironment,
        DEVRANDOM_REGISTRATION_SITE_URL: 'http://127.0.0.1:3210/registration',
      }),
    ).toThrow(IssuerFailure);
  });

  it('rejects a schema OOBI that does not name the exact pinned schema', () => {
    expect(() =>
      loadIssuerRegistrationConfiguration({
        ...validEnvironment,
        DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: 'http://issuer:3211/oobi/EOtherSchema',
      }),
    ).toThrow(IssuerFailure);
  });
});
