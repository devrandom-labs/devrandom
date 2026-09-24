import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  browserApprovalRequestSchema,
  browserRegistrationProjectionSchema,
  cliRegistrationProjectionSchema,
  contactEmailSchema,
  createRegistrationRequestSchema,
  createRegistrationResponseSchema,
  submitAidProofRequestSchema,
} from './registration-session.js';

const registrationId = '09f9302f5e7d44e2b430663d8f872a3b';
const userAid = 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz';
const issuerAid = 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk';
const credentialSaid = 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao';

describe('registration HTTP protocol', () => {
  it('accepts only the closed session-creation input', () => {
    const input = {
      protocolVersion: 1,
      userAid,
      userAgentOobi:
        'http://keria:3902/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    };

    expect(Value.Check(createRegistrationRequestSchema, input)).toBe(true);
    expect(Value.Check(createRegistrationRequestSchema, { ...input, capabilities: [] })).toBe(
      false,
    );
  });

  it('returns purpose-separated creation capabilities without putting the CLI token in the URL', () => {
    const response = {
      registrationId,
      cliCapability: 'cli_Dk4PzUlDlZxXc0wS_KtT7qAksjN99QdK',
      browserUrl:
        'http://127.0.0.1:3210/#/registration/09f9302f5e7d44e2b430663d8f872a3b?capability=browser_wFW39ouYvvcnpcMrMo2w4G2A0M5nnSP1',
      challengeWords: ['alpha', 'bravo', 'charlie'],
      issuerAid,
      issuerOobi:
        'http://keria:3902/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/ENhrK8fWYea9Ji0YBL7hMfSYEKzkUKyUtPfiyMcgfjoC',
      expiresAt: '2026-09-24T16:05:00.000Z',
      pollIntervalMs: 500,
    };

    expect(Value.Check(createRegistrationResponseSchema, response)).toBe(true);
    expect(response.browserUrl).not.toContain(response.cliCapability);
  });

  it('keeps proof submission exact and closed', () => {
    const proof = { responseSaid: credentialSaid };

    expect(Value.Check(submitAidProofRequestSchema, proof)).toBe(true);
    expect(Value.Check(submitAidProofRequestSchema, { ...proof, userAid })).toBe(false);
  });

  it('validates a bounded self-asserted contact email without rewriting it', () => {
    expect(Value.Check(contactEmailSchema, 'First.Last+demo@example.co.uk')).toBe(true);
    expect(Value.Check(contactEmailSchema, 'not-an-email')).toBe(false);
    expect(Value.Check(contactEmailSchema, `a@${'x'.repeat(250)}.test`)).toBe(false);
    expect(
      Value.Check(browserApprovalRequestSchema, {
        contactEmail: 'First.Last+demo@example.co.uk',
      }),
    ).toBe(true);
  });

  it('keeps browser projections free of CLI proof, issuance, and credential internals', () => {
    const projection = {
      kind: 'pending-approval',
      registrationId,
      issuerAid,
      userAid,
      abbreviatedUserAid: 'EERMVx…YLjmz',
      comparisonCode: 'MANGO-RIVER',
      credentialName: 'Devrandom User',
      capabilities: [
        'CreateAgent',
        'CreateTask',
        'RunPrivateTask',
        'PublishHarness',
        'ReceiveTaskResults',
      ],
      expiresAt: '2026-09-24T16:05:00.000Z',
      contactEmailAssurance: 'self-asserted-unverified',
    };

    expect(Value.Check(browserRegistrationProjectionSchema, projection)).toBe(true);
    expect(
      Value.Check(browserRegistrationProjectionSchema, {
        ...projection,
        challengeWords: ['must', 'not', 'leak'],
      }),
    ).toBe(false);
    expect(
      Value.Check(browserRegistrationProjectionSchema, {
        ...projection,
        grantSaid: credentialSaid,
      }),
    ).toBe(false);
  });

  it('gives the CLI exact grant and credential correlation only after issuance', () => {
    const projection = {
      kind: 'issued',
      registrationId,
      userAid,
      expiresAt: '2026-09-24T16:05:00.000Z',
      grantSaid: credentialSaid,
      credentialSaid,
    };

    expect(Value.Check(cliRegistrationProjectionSchema, projection)).toBe(true);
    expect(
      Value.Check(cliRegistrationProjectionSchema, {
        ...projection,
        browserCapability: 'browser-secret',
      }),
    ).toBe(false);
  });
});
