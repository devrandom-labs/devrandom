import { isAbsolute, basename } from 'node:path';

import type {
  CredentialRegistryPolicy,
  IssuerWitnessPolicy,
  SignifySecurityTier,
} from '@devrandom/identity';

import { IssuerFailure } from './issuer-error.js';

declare const issuerConfigurationBrand: unique symbol;

type IssuerConfigurationValue<Name extends string> = string & {
  readonly [issuerConfigurationBrand]: Name;
};

export type IssuerBran = IssuerConfigurationValue<'IssuerBran'>;
export type KeriaUrl = IssuerConfigurationValue<'KeriaUrl'>;
export type IssuerProfilePath = IssuerConfigurationValue<'IssuerProfilePath'>;

export interface IssuerBootstrapConfiguration {
  readonly bran: IssuerBran;
  readonly keriaAdminUrl: KeriaUrl;
  readonly keriaBootUrl: KeriaUrl;
  readonly profilePath: IssuerProfilePath;
  readonly securityTier: SignifySecurityTier;
  readonly witnessPolicy: IssuerWitnessPolicy;
  readonly registryPolicy: CredentialRegistryPolicy;
  readonly operationTimeoutMs: number;
  readonly oobiAvailabilityTimeoutMs: number;
}

export interface IssuerServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface IssuerRegistrationConfiguration {
  readonly mongodbUri: string;
  readonly registrationSiteUrl: string;
  readonly credentialSchemaOobiUrl: string;
  readonly lifetimeMs: number;
  readonly pollIntervalMs: number;
  readonly replayRetentionMs: number;
  readonly maximumRequestsPerMinute: number;
}

export const devrandomIssuerAlias = 'devrandom-issuer' as const;
export const devrandomRegistryName = 'devrandom-credentials' as const;

export function issuerBran(value: string): IssuerBran {
  if (!/^[A-Za-z0-9_-]{21}$/u.test(value)) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_ISSUER_BRAN',
      reason: value.length === 0 ? 'missing' : 'invalid',
    });
  }
  return value as IssuerBran;
}

export function keriaUrl(
  value: string,
  field: 'DEVRANDOM_KERIA_ADMIN_URL' | 'DEVRANDOM_KERIA_BOOT_URL' = 'DEVRANDOM_KERIA_ADMIN_URL',
): KeriaUrl {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('KERIA endpoint must be an HTTP origin without credentials');
    }
    return parsed.origin as KeriaUrl;
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      throw cause;
    }
    throw new IssuerFailure(
      { kind: 'issuer-configuration-invalid', field, reason: 'invalid' },
      cause,
    );
  }
}

export function issuerProfilePath(value: string): IssuerProfilePath {
  if (!isAbsolute(value) || basename(value) !== 'issuer-profile.json') {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'DEVRANDOM_ISSUER_PROFILE_PATH',
      reason: value.length === 0 ? 'missing' : 'invalid',
    });
  }
  return value as IssuerProfilePath;
}

export function issuerServerAddress(host: string, port: number): IssuerServerAddress {
  if (host.length === 0 || /\s/u.test(host)) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'HOST',
      reason: host.length === 0 ? 'missing' : 'invalid',
    });
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new IssuerFailure({
      kind: 'issuer-configuration-invalid',
      field: 'PORT',
      reason: 'invalid',
    });
  }
  return { host, port };
}
