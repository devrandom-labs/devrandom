import { issuerOobi } from '@devrandom/identity';
import {
  browserRegistrationProjectionSchema,
  cliRegistrationProjectionSchema,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  approveRegistration,
  createRegistrationSession,
  submitAidProof,
} from '../domain/registration-session.js';
import {
  browserRegistrationProjection,
  cliRegistrationProjection,
} from './registration-projection.js';

const registration = createRegistrationSession({
  registrationId: 'a'.repeat(32),
  protocolVersion: '1',
  userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  userAgentOobi:
    'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  challengeWords: ['amber', 'cabin', 'delta'],
  cliCapabilityHash: '1'.repeat(64),
  browserCapabilityHash: '2'.repeat(64),
  createdAt: Date.parse('2026-09-24T12:00:00.000Z'),
  expiresAt: Date.parse('2026-09-24T12:05:00.000Z'),
});

const oobi = issuerOobi(
  'http://issuer.test/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
);

describe('Registration Session projections', () => {
  it('exposes challenge only to the CLI pending-proof projection', () => {
    const cli = cliRegistrationProjection(registration, oobi);
    const browser = browserRegistrationProjection(registration);

    expect(Value.Check(cliRegistrationProjectionSchema, cli)).toBe(true);
    expect(Value.Check(browserRegistrationProjectionSchema, browser)).toBe(true);
    expect(cli).toMatchObject({
      kind: 'pending-proof',
      challengeWords: ['amber', 'cabin', 'delta'],
      issuerOobi: oobi,
    });
    expect(JSON.stringify(browser)).not.toContain('amber');
    expect(JSON.stringify(browser)).not.toContain('Capability');
    expect(JSON.stringify(browser)).not.toContain('"contactEmail":');
    expect(browser).toMatchObject({
      userAid: registration.binding.userAid,
      issuerAid: registration.binding.issuerAid,
      contactEmailAssurance: 'self-asserted-unverified',
    });
  });

  it('keeps email and proof evidence out of both projections after approval', () => {
    const proved = submitAidProof(registration, {
      registrationId: registration.binding.registrationId,
      sourceAid: registration.binding.userAid,
      recipientAid: registration.binding.issuerAid,
      challengeWords: registration.binding.challengeWords,
      responseSaid: 'EResponseSaid',
      acceptedAt: registration.binding.createdAt + 1_000,
    });
    const approved = approveRegistration(proved, {
      contactEmail: 'Private+Demo@example.com',
      approvedAt: registration.binding.createdAt + 2_000,
    });

    for (const projection of [
      cliRegistrationProjection(approved, oobi),
      browserRegistrationProjection(approved),
    ]) {
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain('Private+Demo@example.com');
      expect(serialized).not.toContain('EResponseSaid');
      expect(serialized).not.toContain('CapabilityHash');
    }
  });
});
