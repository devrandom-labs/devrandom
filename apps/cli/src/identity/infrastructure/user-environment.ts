import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  credentialRegistryId,
  credentialSchemaId,
  issuerAid,
  issuerOobi,
  witnessAid,
} from '@devrandom/identity';
import { credentialSchema } from '@devrandom/protocol';

import type { UserIdentityConfiguration } from '../domain/user-configuration.js';

const localDemonstration = {
  keriaAdminUrl: 'http://127.0.0.1:3901',
  keriaBootUrl: 'http://127.0.0.1:3903',
  issuerUrl: 'http://127.0.0.1:3211',
  registrationSiteUrl: 'http://127.0.0.1:3210',
  issuerAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
  issuerOobi:
    'http://keria:3902/oobi/EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh/agent/EMFsHxucSvnjgKdeXgmPgrskqHqH3H42Ka5XP_HznK99',
  registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
  schemaOobi: `http://issuer:3211/oobi/${credentialSchema.$id}`,
  witnessAid: 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
  witnessOobi: 'http://witnesses:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
} as const;

export interface UserIdentityEnvironment {
  readonly DEVRANDOM_USER_STATE_DIR?: string | undefined;
  readonly DEVRANDOM_KERIA_ADMIN_URL?: string | undefined;
  readonly DEVRANDOM_KERIA_BOOT_URL?: string | undefined;
  readonly DEVRANDOM_ISSUER_URL?: string | undefined;
  readonly DEVRANDOM_REGISTRATION_SITE_URL?: string | undefined;
  readonly DEVRANDOM_ISSUER_AID?: string | undefined;
  readonly DEVRANDOM_ISSUER_OOBI?: string | undefined;
  readonly DEVRANDOM_CREDENTIAL_REGISTRY_ID?: string | undefined;
  readonly DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL?: string | undefined;
  readonly DEVRANDOM_WITNESS_AID?: string | undefined;
  readonly DEVRANDOM_WITNESS_OOBI?: string | undefined;
}

export type UserConfigurationField = Exclude<keyof UserIdentityEnvironment, symbol | number>;

export class UserConfigurationFailure extends Error {
  readonly field: UserConfigurationField;

  constructor(field: UserConfigurationField, reason: 'missing' | 'invalid', cause?: unknown) {
    super(`${field} is ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'UserConfigurationFailure';
    this.field = field;
  }
}

export function userIdentityEnvironment(environment: NodeJS.ProcessEnv): UserIdentityEnvironment {
  return {
    DEVRANDOM_USER_STATE_DIR: environment.DEVRANDOM_USER_STATE_DIR,
    DEVRANDOM_KERIA_ADMIN_URL: environment.DEVRANDOM_KERIA_ADMIN_URL,
    DEVRANDOM_KERIA_BOOT_URL: environment.DEVRANDOM_KERIA_BOOT_URL,
    DEVRANDOM_ISSUER_URL: environment.DEVRANDOM_ISSUER_URL,
    DEVRANDOM_REGISTRATION_SITE_URL: environment.DEVRANDOM_REGISTRATION_SITE_URL,
    DEVRANDOM_ISSUER_AID: environment.DEVRANDOM_ISSUER_AID,
    DEVRANDOM_ISSUER_OOBI: environment.DEVRANDOM_ISSUER_OOBI,
    DEVRANDOM_CREDENTIAL_REGISTRY_ID: environment.DEVRANDOM_CREDENTIAL_REGISTRY_ID,
    DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL,
    DEVRANDOM_WITNESS_AID: environment.DEVRANDOM_WITNESS_AID,
    DEVRANDOM_WITNESS_OOBI: environment.DEVRANDOM_WITNESS_OOBI,
  };
}

export function loadUserIdentityConfiguration(
  environment: UserIdentityEnvironment,
): UserIdentityConfiguration {
  const stateDirectory = environment.DEVRANDOM_USER_STATE_DIR ?? join(homedir(), '.devrandom');
  if (!isAbsolute(stateDirectory)) {
    throw new UserConfigurationFailure('DEVRANDOM_USER_STATE_DIR', 'invalid');
  }

  const keriaAdminUrl = requiredOrigin(
    environment.DEVRANDOM_KERIA_ADMIN_URL ?? localDemonstration.keriaAdminUrl,
    'DEVRANDOM_KERIA_ADMIN_URL',
  );
  const keriaBootUrl = requiredOrigin(
    environment.DEVRANDOM_KERIA_BOOT_URL ?? localDemonstration.keriaBootUrl,
    'DEVRANDOM_KERIA_BOOT_URL',
  );
  const issuerUrl = requiredOrigin(
    environment.DEVRANDOM_ISSUER_URL ?? localDemonstration.issuerUrl,
    'DEVRANDOM_ISSUER_URL',
  );
  const registrationSiteUrl = requiredOrigin(
    environment.DEVRANDOM_REGISTRATION_SITE_URL ?? localDemonstration.registrationSiteUrl,
    'DEVRANDOM_REGISTRATION_SITE_URL',
  );
  const expectedIssuerAid = required(
    environment.DEVRANDOM_ISSUER_AID ?? localDemonstration.issuerAid,
    'DEVRANDOM_ISSUER_AID',
  );
  const expectedIssuerOobi = required(
    environment.DEVRANDOM_ISSUER_OOBI ?? localDemonstration.issuerOobi,
    'DEVRANDOM_ISSUER_OOBI',
  );
  const expectedRegistryId = required(
    environment.DEVRANDOM_CREDENTIAL_REGISTRY_ID ?? localDemonstration.registryId,
    'DEVRANDOM_CREDENTIAL_REGISTRY_ID',
  );
  const expectedWitnessAid = required(
    environment.DEVRANDOM_WITNESS_AID ?? localDemonstration.witnessAid,
    'DEVRANDOM_WITNESS_AID',
  );
  const witnessOobi = required(
    environment.DEVRANDOM_WITNESS_OOBI ?? localDemonstration.witnessOobi,
    'DEVRANDOM_WITNESS_OOBI',
  );

  const configuredIssuerAid = decodeIdentity('DEVRANDOM_ISSUER_AID', expectedIssuerAid, issuerAid);
  const configuredIssuerOobi = decodeIdentity(
    'DEVRANDOM_ISSUER_OOBI',
    expectedIssuerOobi,
    issuerOobi,
  );
  const configuredRegistryId = decodeIdentity(
    'DEVRANDOM_CREDENTIAL_REGISTRY_ID',
    expectedRegistryId,
    credentialRegistryId,
  );
  const configuredSchemaId = credentialSchemaId(credentialSchema.$id);
  const schemaOobi = required(
    environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL ?? localDemonstration.schemaOobi,
    'DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL',
  );
  let parsedSchemaOobi: URL;
  try {
    parsedSchemaOobi = new URL(schemaOobi);
  } catch (cause) {
    throw new UserConfigurationFailure('DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL', 'invalid', cause);
  }
  if (
    (parsedSchemaOobi.protocol !== 'http:' && parsedSchemaOobi.protocol !== 'https:') ||
    parsedSchemaOobi.username.length > 0 ||
    parsedSchemaOobi.password.length > 0 ||
    parsedSchemaOobi.search.length > 0 ||
    parsedSchemaOobi.hash.length > 0 ||
    !parsedSchemaOobi.pathname.split('/').includes(configuredSchemaId)
  ) {
    throw new UserConfigurationFailure('DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL', 'invalid');
  }
  const configuredWitnessAid = decodeIdentity(
    'DEVRANDOM_WITNESS_AID',
    expectedWitnessAid,
    witnessAid,
  );
  let parsedWitnessOobi: URL;
  try {
    parsedWitnessOobi = new URL(witnessOobi);
  } catch (cause) {
    throw new UserConfigurationFailure('DEVRANDOM_WITNESS_OOBI', 'invalid', cause);
  }
  if (
    (parsedWitnessOobi.protocol !== 'http:' && parsedWitnessOobi.protocol !== 'https:') ||
    parsedWitnessOobi.username.length > 0 ||
    parsedWitnessOobi.password.length > 0 ||
    parsedWitnessOobi.search.length > 0 ||
    parsedWitnessOobi.hash.length > 0 ||
    !parsedWitnessOobi.pathname.split('/').includes(configuredWitnessAid)
  ) {
    throw new UserConfigurationFailure('DEVRANDOM_WITNESS_OOBI', 'invalid');
  }

  return {
    stateDirectory,
    keriaAdminUrl,
    keriaBootUrl,
    issuerUrl,
    registrationSiteUrl,
    issuerAid: configuredIssuerAid,
    issuerOobi: configuredIssuerOobi,
    registryId: configuredRegistryId,
    schemaId: configuredSchemaId,
    schemaOobi,
    witnessAid: configuredWitnessAid,
    witnessOobi,
    operationTimeoutMs: 30_000,
    registrationTimeoutMs: 360_000,
  };
}

function required(value: string | undefined, field: UserConfigurationField): string {
  if (value === undefined || value.length === 0) {
    throw new UserConfigurationFailure(field, 'missing');
  }
  return value;
}

function requiredOrigin(value: string | undefined, field: UserConfigurationField): string {
  const source = required(value, field);
  try {
    const parsed = new URL(source);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('value is not an HTTP origin');
    }
    return parsed.origin;
  } catch (cause) {
    throw new UserConfigurationFailure(field, 'invalid', cause);
  }
}

function decodeIdentity<Value>(
  field: UserConfigurationField,
  source: string,
  decode: (value: string) => Value,
): Value {
  try {
    return decode(source);
  } catch (cause) {
    throw new UserConfigurationFailure(field, 'invalid', cause);
  }
}
