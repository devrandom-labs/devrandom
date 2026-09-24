import type { IssuerHealth } from '@devrandom/protocol';

import type { UserIdentityConfiguration } from '../domain/user-configuration.js';

export type DemoIssuerIdentity = Pick<
  UserIdentityConfiguration,
  'issuerAid' | 'issuerOobi' | 'registryId' | 'schemaId'
>;

export type DemoIssuerCompatibility =
  | { readonly kind: 'IssuerCompatible'; readonly issuer: IssuerHealth }
  | {
      readonly kind: 'IssuerIncompatible';
      readonly field: keyof DemoIssuerIdentity;
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly kind: 'IssuerUnavailable' };

export async function verifyDemoIssuer(
  expected: DemoIssuerIdentity,
  observe: () => Promise<IssuerHealth>,
): Promise<DemoIssuerCompatibility> {
  let actual: IssuerHealth;
  try {
    actual = await observe();
  } catch {
    return { kind: 'IssuerUnavailable' };
  }
  if (actual.issuerAid !== expected.issuerAid) {
    return mismatch('issuerAid', expected.issuerAid, actual.issuerAid);
  }
  if (actual.issuerOobi !== expected.issuerOobi) {
    return mismatch('issuerOobi', expected.issuerOobi, actual.issuerOobi);
  }
  if (actual.registryId !== expected.registryId) {
    return mismatch('registryId', expected.registryId, actual.registryId);
  }
  if (actual.schemaId !== expected.schemaId) {
    return mismatch('schemaId', expected.schemaId, actual.schemaId);
  }
  return { kind: 'IssuerCompatible', issuer: actual };
}

function mismatch(
  field: keyof DemoIssuerIdentity,
  expected: string,
  actual: string,
): DemoIssuerCompatibility {
  return { kind: 'IssuerIncompatible', field, expected, actual };
}
