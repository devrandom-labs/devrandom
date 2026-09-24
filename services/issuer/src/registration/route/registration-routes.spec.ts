import { afterEach, describe, expect, it } from 'vitest';

import {
  createRegistrationSession,
  rejectRegistration,
  type RegistrationSession,
} from '../domain/registration-session.js';
import {
  RegistrationEnrollmentFailure,
  type RegistrationCreationOutcome,
  type RegistrationSnapshot,
} from '../application/registration-enrollment.js';
import type { UserRegistrationConversation } from '../application/user-registration.js';
import { RegistrationRequestQuota } from './registration-request-quota.js';
import { buildIssuerServer } from '../../route/issuer-server.js';
import { verifiedIssuerFixture } from '../../../test/verified-issuer-fixture.js';
import { issuerReadinessFixture } from '../../../test/issuer-readiness-fixture.js';

const cliCapability = `cli_${'c'.repeat(43)}`;
const browserCapability = `browser_${'b'.repeat(43)}`;
const registrationId = 'a'.repeat(32);
const creationKey = `registration_${'r'.repeat(43)}`;
const createdAt = Date.parse('2026-09-24T12:00:00.000Z');

const pending = createRegistrationSession({
  registrationId,
  protocolVersion: '1',
  userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
  userAgentOobi:
    'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  challengeWords: ['amber', 'cabin', 'delta'],
  cliCapabilityHash: '1'.repeat(64),
  browserCapabilityHash: '2'.repeat(64),
  createdAt,
  expiresAt: createdAt + 60_000,
});

function snapshot(session: RegistrationSession = pending): RegistrationSnapshot {
  return { revision: 0, session };
}

function enrollment(
  creationKind: RegistrationCreationOutcome['kind'] = 'registration-created',
): UserRegistrationConversation {
  const authorize = (capability: string, expected: string): Promise<RegistrationSnapshot> =>
    capability === expected
      ? Promise.resolve(snapshot())
      : Promise.reject(new RegistrationEnrollmentFailure({ kind: 'registration-unavailable' }));
  return {
    create(): Promise<RegistrationCreationOutcome> {
      return Promise.resolve({
        kind: creationKind,
        response: {
          registrationId,
          cliCapability,
          browserUrl: `http://site.test/#/registration/${registrationId}?capability=${browserCapability}`,
          challengeWords: [...pending.binding.challengeWords],
          issuerAid: pending.binding.issuerAid,
          issuerOobi:
            'http://issuer.test/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
          expiresAt: new Date(pending.binding.expiresAt).toISOString(),
          pollIntervalMs: 1_000,
        },
      });
    },
    cliSession(_id: string, capability: string) {
      return authorize(capability, cliCapability);
    },
    browserSession(_id: string, capability: string) {
      return authorize(capability, browserCapability);
    },
    submitAidProof(_id: string, capability: string) {
      return authorize(capability, cliCapability);
    },
    approve(_id: string, capability: string) {
      return authorize(capability, browserCapability);
    },
    reject(_id: string, capability: string) {
      if (capability !== browserCapability) {
        return Promise.reject(
          new RegistrationEnrollmentFailure({ kind: 'registration-unavailable' }),
        );
      }
      return Promise.resolve(
        snapshot(
          rejectRegistration(pending, {
            rejection: { kind: 'browser-declined' },
            rejectedAt: createdAt + 1,
          }),
        ),
      );
    },
  };
}

const servers: ReturnType<typeof buildIssuerServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function server(
  maximumRequests = 100,
  creationKind: RegistrationCreationOutcome['kind'] = 'registration-created',
) {
  const built = buildIssuerServer(
    verifiedIssuerFixture(),
    {
      enrollment: enrollment(creationKind),
      browserOrigin: 'http://site.test',
      quota: new RegistrationRequestQuota(maximumRequests, 60_000, () => createdAt),
    },
    issuerReadinessFixture(),
  );
  servers.push(built);
  return built;
}

describe('Registration HTTP routes', () => {
  it('creates a registration with an exact 201 no-store response', async () => {
    const response = await server().inject({
      method: 'POST',
      url: '/registrations',
      headers: { 'idempotency-key': creationKey },
      payload: {
        protocolVersion: 1,
        userAid: pending.binding.userAid,
        userAgentOobi: pending.binding.userAgentOobi,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ registrationId, cliCapability });
  });

  it('returns 200 with the same contract for an idempotent creation replay', async () => {
    const response = await server(100, 'registration-replayed').inject({
      method: 'POST',
      url: '/registrations',
      headers: { 'idempotency-key': creationKey },
      payload: {
        protocolVersion: 1,
        userAid: pending.binding.userAid,
        userAgentOobi: pending.binding.userAgentOobi,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ registrationId, cliCapability });
  });

  it('returns indistinguishable responses for an unknown session and wrong capability', async () => {
    const built = server();
    const wrongToken = await built.inject({
      method: 'GET',
      url: `/registrations/${registrationId}`,
      headers: { 'x-devrandom-registration-capability': browserCapability },
    });
    const unknown = await built.inject({
      method: 'GET',
      url: `/registrations/${'f'.repeat(32)}`,
      headers: { 'x-devrandom-registration-capability': browserCapability },
    });

    expect(wrongToken.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(wrongToken.body).toBe(unknown.body);
    expect(wrongToken.headers['cache-control']).toBe('no-store');
  });

  it('requires exact browser Fetch Metadata and origin for approval', async () => {
    const built = server();
    const denied = await built.inject({
      method: 'POST',
      url: `/registrations/${registrationId}/approval`,
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.test',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'x-devrandom-registration-capability': browserCapability,
      },
      payload: { contactEmail: 'User+Demo@example.com' },
    });
    const accepted = await built.inject({
      method: 'POST',
      url: `/registrations/${registrationId}/approval`,
      headers: {
        'content-type': 'application/json',
        origin: 'http://site.test',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'x-devrandom-registration-capability': browserCapability,
      },
      payload: { contactEmail: 'User+Demo@example.com' },
    });

    expect(denied.statusCode).toBe(422);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers['cache-control']).toBe('no-store');
  });

  it('returns only a browser-safe projection to the browser capability', async () => {
    const response = await server().inject({
      method: 'GET',
      url: `/registrations/${registrationId}/approval`,
      headers: { 'x-devrandom-registration-capability': browserCapability },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'pending-proof',
      userAid: pending.binding.userAid,
      contactEmailAssurance: 'self-asserted-unverified',
    });
    expect(response.body).not.toContain('amber');
    expect(response.body).not.toContain('CapabilityHash');
  });

  it('returns 200 for an accepted terminal rejection transition', async () => {
    const response = await server().inject({
      method: 'POST',
      url: `/registrations/${registrationId}/rejection`,
      headers: {
        'content-type': 'application/json',
        origin: 'http://site.test',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'x-devrandom-registration-capability': browserCapability,
      },
      payload: { action: 'reject' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ kind: 'rejected', registrationId });
  });

  it('rate limits without revealing whether a registration exists', async () => {
    const built = server(1);
    const headers = { 'x-devrandom-registration-capability': cliCapability };
    await built.inject({ method: 'GET', url: `/registrations/${registrationId}`, headers });
    const limited = await built.inject({
      method: 'GET',
      url: `/registrations/${'f'.repeat(32)}`,
      headers,
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toEqual({ error: 'rate-limited' });
  });
});
