import {
  confirmCurrentUserCustody,
  decideUserAdmission,
  verifyDevrandomUserCredential,
} from '@devrandom/domain';
import { describe, expect, it, vi } from 'vitest';

import { loadUserIdentityConfiguration } from '../../identity/infrastructure/user-environment.js';
import { loadMandateConfiguration } from './mandate-environment.js';
import { SignifyLocalMandateAuthority } from './signify-local-mandate-authority.js';

const identityConfiguration = loadUserIdentityConfiguration({
  DEVRANDOM_USER_STATE_DIR: '/tmp/devrandom-test',
  DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL:
    'http://server:3211/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
});

const mandateConfiguration = loadMandateConfiguration({});

function admittedUser() {
  const custody = confirmCurrentUserCustody({
    user: { aid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4' },
    controllerAid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    kelSequence: 0,
    witnessAids: [identityConfiguration.witnessAid],
    witnessThreshold: 1,
    witnessReceiptIndexes: [0],
    verifiedAt: '2026-09-24T18:00:00.000Z',
  });
  if (custody.kind !== 'Current') {
    throw new Error('test custody must be current');
  }
  const credential = verifyDevrandomUserCredential(
    {
      issuerAid: identityConfiguration.issuerAid,
      issueeAid: custody.custody.user.aid,
      registryId: identityConfiguration.registryId,
      schemaSaid: identityConfiguration.schemaId,
    },
    {
      credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
      attributeSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      issuerAid: identityConfiguration.issuerAid,
      issueeAid: custody.custody.user.aid,
      registryId: identityConfiguration.registryId,
      schemaSaid: identityConfiguration.schemaId,
      issuedAt: '2026-09-24T17:00:00.000Z',
      verifiedAt: '2026-09-24T18:00:00.000Z',
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: { kind: 'Resolved', schemaSaid: identityConfiguration.schemaId },
      telState: { kind: 'Issued' },
      issuerAnchor: {
        kind: 'Anchored',
        eventSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      eligibilityClaims: [
        'CreateAgent',
        'CreateTask',
        'RunPrivateTask',
        'PublishHarness',
        'ReceiveTaskResults',
      ],
    },
  );
  if (credential.kind !== 'Current') {
    throw new Error('test credential must be current');
  }
  const admission = decideUserAdmission({
    kind: 'CurrentCustody',
    custody: custody.custody,
    credential: { kind: 'Current', credential: credential.credential },
  });
  if (admission.kind !== 'Ready') {
    throw new Error('test user must be admitted');
  }
  return admission.user;
}

describe('Signify local mandate authority', () => {
  it('fails closed before KERIA when the existing controller custody is absent', async () => {
    const connectPrincipals = vi.fn();
    const connectMandates = vi.fn();
    const connectRunAdmission = vi.fn();
    const connectEvidenceSeal = vi.fn();
    const authority = new SignifyLocalMandateAuthority(
      identityConfiguration,
      mandateConfiguration,
      { readCustody: () => Promise.resolve(undefined) },
      { read: () => Promise.resolve(undefined), commit: vi.fn() },
      { connectPrincipals, connectMandates, connectRunAdmission, connectEvidenceSeal },
    );

    await expect(authority.establish(admittedUser())).resolves.toEqual({
      kind: 'CustodyUnavailable',
    });
    expect(connectPrincipals).not.toHaveBeenCalled();
    expect(connectMandates).not.toHaveBeenCalled();
    expect(connectRunAdmission).not.toHaveBeenCalled();
    expect(connectEvidenceSeal).not.toHaveBeenCalled();
  });
});
