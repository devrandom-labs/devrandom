import {
  credentialRegistryId,
  credentialSchemaId,
  issuerAid,
  issuerOobi,
} from '@devrandom/identity';
import type { IssuerHealth } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { type DemoIssuerIdentity, verifyDemoIssuer } from './demo-issuer-compatibility.js';

const issuer: IssuerHealth = {
  service: 'issuer',
  status: 'ready',
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  issuerOobi:
    'http://keria:3902/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  registryId: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
  schemaId: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
};

const expected: DemoIssuerIdentity = {
  issuerAid: issuerAid(issuer.issuerAid),
  issuerOobi: issuerOobi(issuer.issuerOobi),
  registryId: credentialRegistryId(issuer.registryId),
  schemaId: credentialSchemaId(issuer.schemaId),
};

describe('demo issuer compatibility', () => {
  it('accepts the exact public issuer deployment expected by the CLI', async () => {
    await expect(verifyDemoIssuer(expected, () => Promise.resolve(issuer))).resolves.toEqual({
      kind: 'IssuerCompatible',
      issuer,
    });
  });

  it.each(['issuerAid', 'issuerOobi', 'registryId', 'schemaId'] as const)(
    'rejects a mismatched %s',
    async (field) => {
      const incompatible = { ...issuer, [field]: `wrong-${issuer[field]}` };

      await expect(
        verifyDemoIssuer(expected, () => Promise.resolve(incompatible)),
      ).resolves.toEqual({
        kind: 'IssuerIncompatible',
        field,
        expected: expected[field],
        actual: incompatible[field],
      });
    },
  );

  it('reports unavailable health without claiming compatibility', async () => {
    await expect(
      verifyDemoIssuer(expected, () => Promise.reject(new Error('connection refused'))),
    ).resolves.toEqual({ kind: 'IssuerUnavailable' });
  });
});
