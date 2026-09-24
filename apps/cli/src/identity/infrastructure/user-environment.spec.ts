import { describe, expect, it } from 'vitest';

import { credentialSchema } from '@devrandom/protocol';

import { loadUserIdentityConfiguration, type UserIdentityEnvironment } from './user-environment.js';

const environment = {
  DEVRANDOM_USER_STATE_DIR: '/tmp/devrandom-user',
  DEVRANDOM_KERIA_ADMIN_URL: 'http://127.0.0.1:3901',
  DEVRANDOM_KERIA_BOOT_URL: 'http://127.0.0.1:3903',
  DEVRANDOM_ISSUER_URL: 'http://127.0.0.1:3211',
  DEVRANDOM_REGISTRATION_SITE_URL: 'http://127.0.0.1:3210',
  DEVRANDOM_ISSUER_AID: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  DEVRANDOM_ISSUER_OOBI:
    'http://keria:3902/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  DEVRANDOM_CREDENTIAL_REGISTRY_ID: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
  DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: `http://issuer:3211/oobi/${credentialSchema.$id}`,
  DEVRANDOM_WITNESS_AID: 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
  DEVRANDOM_WITNESS_OOBI: 'http://witnesses:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
} satisfies UserIdentityEnvironment;

describe('user identity environment', () => {
  it('supplies the pinned local demonstration without requiring a configuration file', () => {
    expect(
      loadUserIdentityConfiguration({
        DEVRANDOM_USER_STATE_DIR: '/tmp/devrandom-user',
      }),
    ).toMatchObject({
      stateDirectory: '/tmp/devrandom-user',
      keriaAdminUrl: 'http://127.0.0.1:3901',
      keriaBootUrl: 'http://127.0.0.1:3903',
      issuerUrl: 'http://127.0.0.1:3211',
      registrationSiteUrl: 'http://127.0.0.1:3210',
      issuerAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
      issuerOobi:
        'http://keria:3902/oobi/EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh/agent/EMFsHxucSvnjgKdeXgmPgrskqHqH3H42Ka5XP_HznK99',
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaId: credentialSchema.$id,
      schemaOobi: `http://issuer:3211/oobi/${credentialSchema.$id}`,
      witnessAid: 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
      witnessOobi: 'http://witnesses:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
    });
  });

  it('decodes exact live identity expectations', () => {
    expect(loadUserIdentityConfiguration(environment)).toMatchObject({
      stateDirectory: '/tmp/devrandom-user',
      issuerAid: environment.DEVRANDOM_ISSUER_AID,
      registryId: environment.DEVRANDOM_CREDENTIAL_REGISTRY_ID,
      schemaId: credentialSchema.$id,
      schemaOobi: environment.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL,
      witnessAid: environment.DEVRANDOM_WITNESS_AID,
    });
  });

  it('rejects an invalid issuer override instead of falling back to the pinned issuer', () => {
    expect(() =>
      loadUserIdentityConfiguration({ ...environment, DEVRANDOM_ISSUER_AID: 'not-an-aid' }),
    ).toThrow('DEVRANDOM_ISSUER_AID is invalid');
  });

  it('rejects a schema OOBI that does not bind the pinned schema SAID', () => {
    expect(() =>
      loadUserIdentityConfiguration({
        ...environment,
        DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: 'http://issuer:3211/oobi/EDifferentSchema',
      }),
    ).toThrow('DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL is invalid');
  });
});
