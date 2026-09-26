import { describe, expect, it } from 'vitest';

import {
  decodeRegistrationSessionDocument,
  RegistrationSessionDocumentFailure,
} from './registration-session-document.js';

const binding = {
  registrationId: 'a'.repeat(32),
  protocolVersion: '1',
  userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  userAgentOobi: 'http://keria.test/oobi/user/agent/agent',
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  challengeWords: ['amber', 'cabin', 'delta'],
  cliCapabilityHash: '1'.repeat(64),
  browserCapabilityHash: '2'.repeat(64),
  createdAt: 1_000,
  expiresAt: 10_000,
};

const proof = {
  registrationId: binding.registrationId,
  sourceAid: binding.userAid,
  recipientAid: binding.issuerAid,
  challengeWords: binding.challengeWords,
  responseSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
  acceptedAt: 2_000,
};

describe('Registration Session document boundary', () => {
  it.each([
    {
      name: 'malformed KERI identifiers',
      session: {
        kind: 'pending-proof',
        binding: { ...binding, userAid: 'EUser' },
        approval: { kind: 'awaiting-approval' },
      },
    },
    {
      name: 'a non-increasing lifetime',
      session: {
        kind: 'pending-proof',
        binding: { ...binding, expiresAt: binding.createdAt },
        approval: { kind: 'awaiting-approval' },
      },
    },
    {
      name: 'shared CLI and browser capability hashes',
      session: {
        kind: 'pending-proof',
        binding: { ...binding, browserCapabilityHash: binding.cliCapabilityHash },
        approval: { kind: 'awaiting-approval' },
      },
    },
    {
      name: 'proof bound to another user',
      session: {
        kind: 'pending-approval',
        binding,
        proof: { ...proof, sourceAid: 'EOtherUser' },
      },
    },
    {
      name: 'an invalid approved contact email',
      session: {
        kind: 'approved',
        binding,
        proof,
        approval: { contactEmail: 'not-an-email', approvedAt: 3_000 },
      },
    },
    {
      name: 'regressed issuance evidence',
      session: {
        kind: 'issuing',
        binding,
        proof,
        approval: { contactEmail: 'user@example.com', approvedAt: 3_000 },
        progress: {
          kind: 'credential-submitted',
          issuedAt: 5_000,
          credentialSaid: 'EH0pPEOR9SgXnsMmTJX12mh_H7WMRZxcM9h12GdZRvCQ',
          operationName: 'credential.operation',
          recordedAt: 4_000,
        },
      },
    },
  ])('rejects $name despite a structurally valid document', ({ session }) => {
    expect(() => decodeRegistrationSessionDocument(JSON.stringify(session))).toThrow(
      RegistrationSessionDocumentFailure,
    );
  });

  it('reconstructs one lawful issuing session', () => {
    const session = {
      kind: 'issuing',
      binding,
      proof,
      approval: { contactEmail: 'user@example.com', approvedAt: 3_000 },
      progress: {
        kind: 'grant-prepared',
        issuedAt: 4_000,
        credentialSaid: 'EH0pPEOR9SgXnsMmTJX12mh_H7WMRZxcM9h12GdZRvCQ',
        credentialOperationName: 'credential.operation',
        credentialSubmissionRecordedAt: 5_000,
        credentialVerifiedAt: 6_000,
        grantSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
        preparedAt: 7_000,
      },
    };

    expect(decodeRegistrationSessionDocument(JSON.stringify(session))).toEqual(session);
  });
});
