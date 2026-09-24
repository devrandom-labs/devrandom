import Type from 'typebox';
import Value from 'typebox/value';

import { credentialSchema } from '@devrandom/protocol';

import {
  issuerBran,
  issuerProfilePath,
  issuerServerAddress,
  keriaUrl,
  type IssuerBootstrapConfiguration,
  type IssuerRegistrationConfiguration,
  type IssuerServerAddress,
} from '../domain/issuer-configuration.js';
import { IssuerFailure, type IssuerConfigurationField } from '../domain/issuer-error.js';

export interface IssuerEnvironment {
  readonly DEVRANDOM_ISSUER_BRAN: string | undefined;
  readonly DEVRANDOM_ISSUER_PROFILE_PATH: string | undefined;
  readonly DEVRANDOM_ISSUER_REGISTRY_POLICY: string | undefined;
  readonly DEVRANDOM_ISSUER_WITNESS_POLICY: string | undefined;
  readonly DEVRANDOM_KERIA_ADMIN_URL: string | undefined;
  readonly DEVRANDOM_KERIA_BOOT_URL: string | undefined;
  readonly DEVRANDOM_SIGNIFY_TIER: string | undefined;
  readonly DEVRANDOM_MONGODB_URI?: string | undefined;
  readonly DEVRANDOM_REGISTRATION_SITE_URL?: string | undefined;
  readonly DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL?: string | undefined;
  readonly DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS?: string | undefined;
  readonly DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS?: string | undefined;
  readonly HOST?: string | undefined;
  readonly PORT?: string | undefined;
}

export function issuerEnvironment(environment: NodeJS.ProcessEnv): IssuerEnvironment {
  return {
    DEVRANDOM_ISSUER_BRAN: environment.DEVRANDOM_ISSUER_BRAN,
    DEVRANDOM_ISSUER_PROFILE_PATH: environment.DEVRANDOM_ISSUER_PROFILE_PATH,
    DEVRANDOM_ISSUER_REGISTRY_POLICY: environment.DEVRANDOM_ISSUER_REGISTRY_POLICY,
    DEVRANDOM_ISSUER_WITNESS_POLICY: environment.DEVRANDOM_ISSUER_WITNESS_POLICY,
    DEVRANDOM_KERIA_ADMIN_URL: environment.DEVRANDOM_KERIA_ADMIN_URL,
    DEVRANDOM_KERIA_BOOT_URL: environment.DEVRANDOM_KERIA_BOOT_URL,
    DEVRANDOM_SIGNIFY_TIER: environment.DEVRANDOM_SIGNIFY_TIER,
    DEVRANDOM_MONGODB_URI: environment.DEVRANDOM_MONGODB_URI,
    DEVRANDOM_REGISTRATION_SITE_URL: environment.DEVRANDOM_REGISTRATION_SITE_URL,
    DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL,
    DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS: environment.DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS,
    DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS: environment.DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS,
    HOST: environment.HOST,
    PORT: environment.PORT,
  };
}

const millisecondsSchema = Type.String({ pattern: '^[1-9][0-9]{2,5}$' });

const issuerEnvironmentSchema = Type.Object(
  {
    DEVRANDOM_ISSUER_BRAN: Type.String({ pattern: '^[A-Za-z0-9_-]{21}$' }),
    DEVRANDOM_ISSUER_PROFILE_PATH: Type.String({ minLength: 1 }),
    DEVRANDOM_ISSUER_REGISTRY_POLICY: Type.Literal('backerless'),
    DEVRANDOM_ISSUER_WITNESS_POLICY: Type.Literal('unwitnessed'),
    DEVRANDOM_KERIA_ADMIN_URL: Type.String({ minLength: 1 }),
    DEVRANDOM_KERIA_BOOT_URL: Type.String({ minLength: 1 }),
    DEVRANDOM_SIGNIFY_TIER: Type.Union([
      Type.Literal('low'),
      Type.Literal('med'),
      Type.Literal('high'),
    ]),
    DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS: Type.Optional(millisecondsSchema),
    DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS: Type.Optional(millisecondsSchema),
  },
  { additionalProperties: false },
);

const requiredFields = [
  'DEVRANDOM_ISSUER_BRAN',
  'DEVRANDOM_ISSUER_PROFILE_PATH',
  'DEVRANDOM_ISSUER_REGISTRY_POLICY',
  'DEVRANDOM_ISSUER_WITNESS_POLICY',
  'DEVRANDOM_KERIA_ADMIN_URL',
  'DEVRANDOM_KERIA_BOOT_URL',
  'DEVRANDOM_SIGNIFY_TIER',
] as const satisfies readonly IssuerConfigurationField[];

function environmentValue(environment: IssuerEnvironment, field: IssuerConfigurationField) {
  switch (field) {
    case 'DEVRANDOM_ISSUER_BRAN':
      return environment.DEVRANDOM_ISSUER_BRAN;
    case 'DEVRANDOM_ISSUER_PROFILE_PATH':
      return environment.DEVRANDOM_ISSUER_PROFILE_PATH;
    case 'DEVRANDOM_ISSUER_REGISTRY_POLICY':
      return environment.DEVRANDOM_ISSUER_REGISTRY_POLICY;
    case 'DEVRANDOM_ISSUER_WITNESS_POLICY':
      return environment.DEVRANDOM_ISSUER_WITNESS_POLICY;
    case 'DEVRANDOM_KERIA_ADMIN_URL':
      return environment.DEVRANDOM_KERIA_ADMIN_URL;
    case 'DEVRANDOM_KERIA_BOOT_URL':
      return environment.DEVRANDOM_KERIA_BOOT_URL;
    case 'DEVRANDOM_SIGNIFY_TIER':
      return environment.DEVRANDOM_SIGNIFY_TIER;
    case 'DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS':
      return environment.DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS;
    case 'DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS':
      return environment.DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS;
    case 'DEVRANDOM_MONGODB_URI':
      return environment.DEVRANDOM_MONGODB_URI;
    case 'DEVRANDOM_REGISTRATION_SITE_URL':
      return environment.DEVRANDOM_REGISTRATION_SITE_URL;
    case 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL':
      return environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL;
    case 'HOST':
      return environment.HOST;
    case 'PORT':
      return environment.PORT;
  }
}

function invalidField(instancePath: string): IssuerConfigurationField {
  switch (instancePath) {
    case '/DEVRANDOM_ISSUER_BRAN':
      return 'DEVRANDOM_ISSUER_BRAN';
    case '/DEVRANDOM_ISSUER_PROFILE_PATH':
      return 'DEVRANDOM_ISSUER_PROFILE_PATH';
    case '/DEVRANDOM_ISSUER_REGISTRY_POLICY':
      return 'DEVRANDOM_ISSUER_REGISTRY_POLICY';
    case '/DEVRANDOM_ISSUER_WITNESS_POLICY':
      return 'DEVRANDOM_ISSUER_WITNESS_POLICY';
    case '/DEVRANDOM_KERIA_ADMIN_URL':
      return 'DEVRANDOM_KERIA_ADMIN_URL';
    case '/DEVRANDOM_KERIA_BOOT_URL':
      return 'DEVRANDOM_KERIA_BOOT_URL';
    case '/DEVRANDOM_SIGNIFY_TIER':
      return 'DEVRANDOM_SIGNIFY_TIER';
    case '/DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS':
      return 'DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS';
    case '/DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS':
      return 'DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS';
    case '/DEVRANDOM_MONGODB_URI':
      return 'DEVRANDOM_MONGODB_URI';
    case '/DEVRANDOM_REGISTRATION_SITE_URL':
      return 'DEVRANDOM_REGISTRATION_SITE_URL';
    case '/DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL':
      return 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL';
    case '/HOST':
      return 'HOST';
    case '/PORT':
      return 'PORT';
    default:
      return 'DEVRANDOM_ISSUER_BRAN';
  }
}

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.parseInt(value, 10);
}

export function loadIssuerBootstrapConfiguration(
  environment: IssuerEnvironment,
): IssuerBootstrapConfiguration {
  for (const field of requiredFields) {
    const value = environmentValue(environment, field);
    if (value === undefined || value.length === 0) {
      throw new IssuerFailure({ kind: 'issuer-configuration-invalid', field, reason: 'missing' });
    }
  }

  const candidate = {
    DEVRANDOM_ISSUER_BRAN: environment.DEVRANDOM_ISSUER_BRAN,
    DEVRANDOM_ISSUER_PROFILE_PATH: environment.DEVRANDOM_ISSUER_PROFILE_PATH,
    DEVRANDOM_ISSUER_REGISTRY_POLICY: environment.DEVRANDOM_ISSUER_REGISTRY_POLICY,
    DEVRANDOM_ISSUER_WITNESS_POLICY: environment.DEVRANDOM_ISSUER_WITNESS_POLICY,
    DEVRANDOM_KERIA_ADMIN_URL: environment.DEVRANDOM_KERIA_ADMIN_URL,
    DEVRANDOM_KERIA_BOOT_URL: environment.DEVRANDOM_KERIA_BOOT_URL,
    DEVRANDOM_SIGNIFY_TIER: environment.DEVRANDOM_SIGNIFY_TIER,
    ...(environment.DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS === undefined
      ? {}
      : {
          DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS: environment.DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS,
        }),
    ...(environment.DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS === undefined
      ? {}
      : {
          DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS: environment.DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS,
        }),
  };

  if (!Value.Check(issuerEnvironmentSchema, candidate)) {
    const [firstError] = Value.Errors(issuerEnvironmentSchema, candidate);
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: invalidField(firstError?.instancePath ?? ''),
      reason: 'invalid',
    });
  }

  return {
    bran: issuerBran(candidate.DEVRANDOM_ISSUER_BRAN),
    profilePath: issuerProfilePath(candidate.DEVRANDOM_ISSUER_PROFILE_PATH),
    keriaAdminUrl: keriaUrl(candidate.DEVRANDOM_KERIA_ADMIN_URL),
    keriaBootUrl: keriaUrl(candidate.DEVRANDOM_KERIA_BOOT_URL, 'DEVRANDOM_KERIA_BOOT_URL'),
    securityTier: candidate.DEVRANDOM_SIGNIFY_TIER,
    witnessPolicy: { kind: 'unwitnessed' },
    registryPolicy: { kind: 'backerless' },
    operationTimeoutMs: positiveMilliseconds(
      candidate.DEVRANDOM_KERIA_OPERATION_TIMEOUT_MS,
      30_000,
    ),
    oobiAvailabilityTimeoutMs: positiveMilliseconds(
      candidate.DEVRANDOM_ISSUER_OOBI_TIMEOUT_MS,
      10_000,
    ),
  };
}

const issuerServerEnvironmentSchema = Type.Object(
  {
    HOST: Type.String({ minLength: 1, pattern: '^\\S+$' }),
    PORT: Type.String({ pattern: '^(0|[1-9][0-9]{0,4})$' }),
  },
  { additionalProperties: false },
);

export function loadIssuerServerAddress(environment: IssuerEnvironment): IssuerServerAddress {
  const candidate = {
    HOST: environment.HOST ?? '127.0.0.1',
    PORT: environment.PORT ?? '3211',
  };
  if (!Value.Check(issuerServerEnvironmentSchema, candidate)) {
    const [firstError] = Value.Errors(issuerServerEnvironmentSchema, candidate);
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: invalidField(firstError?.instancePath ?? ''),
      reason: 'invalid',
    });
  }
  return issuerServerAddress(candidate.HOST, Number.parseInt(candidate.PORT, 10));
}

export function loadIssuerRegistrationConfiguration(
  environment: IssuerEnvironment,
): IssuerRegistrationConfiguration {
  const mongodbUri = environment.DEVRANDOM_MONGODB_URI;
  if (mongodbUri === undefined || mongodbUri.length === 0) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_MONGODB_URI',
      reason: 'missing',
    });
  }
  const registrationSiteUrl = environment.DEVRANDOM_REGISTRATION_SITE_URL;
  if (registrationSiteUrl === undefined || registrationSiteUrl.length === 0) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_REGISTRATION_SITE_URL',
      reason: 'missing',
    });
  }
  const credentialSchemaOobiUrl = environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL;
  if (credentialSchemaOobiUrl === undefined || credentialSchemaOobiUrl.length === 0) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL',
      reason: 'missing',
    });
  }

  let parsedMongo: URL;
  let parsedSite: URL;
  let parsedSchemaOobi: URL;
  try {
    parsedMongo = new URL(mongodbUri);
  } catch (cause) {
    throw new IssuerFailure(
      {
        kind: 'issuer-configuration-invalid',
        field: 'DEVRANDOM_MONGODB_URI',
        reason: 'invalid',
      },
      cause,
    );
  }
  if (
    parsedMongo.protocol !== 'mongodb:' ||
    parsedMongo.username.length > 0 ||
    parsedMongo.password.length > 0 ||
    parsedMongo.hostname.length === 0 ||
    parsedMongo.pathname !== '/devrandom' ||
    parsedMongo.search.length > 0 ||
    parsedMongo.hash.length > 0
  ) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_MONGODB_URI',
      reason: 'invalid',
    });
  }
  try {
    parsedSite = new URL(registrationSiteUrl);
  } catch (cause) {
    throw new IssuerFailure(
      {
        kind: 'issuer-configuration-invalid',
        field: 'DEVRANDOM_REGISTRATION_SITE_URL',
        reason: 'invalid',
      },
      cause,
    );
  }
  if (
    (parsedSite.protocol !== 'http:' && parsedSite.protocol !== 'https:') ||
    parsedSite.username.length > 0 ||
    parsedSite.password.length > 0 ||
    parsedSite.pathname !== '/' ||
    parsedSite.search.length > 0 ||
    parsedSite.hash.length > 0
  ) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_REGISTRATION_SITE_URL',
      reason: 'invalid',
    });
  }
  try {
    parsedSchemaOobi = new URL(credentialSchemaOobiUrl);
  } catch (cause) {
    throw new IssuerFailure(
      {
        kind: 'issuer-configuration-invalid',
        field: 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL',
        reason: 'invalid',
      },
      cause,
    );
  }
  if (
    (parsedSchemaOobi.protocol !== 'http:' && parsedSchemaOobi.protocol !== 'https:') ||
    parsedSchemaOobi.username.length > 0 ||
    parsedSchemaOobi.password.length > 0 ||
    parsedSchemaOobi.pathname !== `/oobi/${credentialSchema.$id}` ||
    parsedSchemaOobi.search.length > 0 ||
    parsedSchemaOobi.hash.length > 0
  ) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL',
      reason: 'invalid',
    });
  }

  return {
    mongodbUri,
    registrationSiteUrl: parsedSite.origin,
    credentialSchemaOobiUrl: parsedSchemaOobi.href,
    lifetimeMs: 300_000,
    pollIntervalMs: 1_000,
    replayRetentionMs: 300_000,
    maximumRequestsPerMinute: 120,
  };
}
