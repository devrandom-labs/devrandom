import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { mandateRoutes, type MandateRoutesConfiguration } from './mandate-routes.js';
import type { MandatePresentation } from '../domain/presentation.js';

const ownerAid = `E${'a'.repeat(43)}`;
const userCredentialSaid = `E${'b'.repeat(43)}`;
const credentialSaid = `E${'c'.repeat(43)}`;
const grantSaid = `E${'d'.repeat(43)}`;
const bearerSecret = 's'.repeat(43);
const grantExpiresAt = '2026-09-24T12:30:00.000Z';

const admitting: MandatePresentation = {
  version: 1,
  binding: {
    ownerAid,
    userCredentialSaid,
    mandateKind: 'TaskMandate',
    credentialSaid,
    grantSaid,
    requestedAt: '2026-09-24T12:00:00.000Z',
    expiresAt: grantExpiresAt,
  },
  acceptedReference: null,
  state: { kind: 'Admitting', operationName: 'operation.123' },
};

function configuration(
  overrides: Partial<MandateRoutesConfiguration> = {},
): MandateRoutesConfiguration {
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'MandateAccessAuthorized',
          authority: { ownerAid, userCredentialSaid, grantExpiresAt },
        }),
    },
    conversation: {
      present: () =>
        Promise.resolve({ kind: 'MandatePresentationPending', presentation: admitting }),
    },
    now: () => '2026-09-24T12:00:00.000Z',
    newCorrelationId: randomUUID,
    ...overrides,
  };
}

async function server(configurationInput: MandateRoutesConfiguration) {
  const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await instance.register(mandateRoutes(configurationInput));
  return instance;
}

describe('Mandate Presentation HTTP route', () => {
  it('returns 202 AwaitingGrant when the exact IPEX grant has not materialized yet', async () => {
    const awaiting: MandatePresentation = {
      ...admitting,
      state: { kind: 'AwaitingGrant' },
    };
    const instance = await server(
      configuration({
        conversation: {
          present: () =>
            Promise.resolve({
              kind: 'MandatePresentationPending',
              presentation: awaiting,
            }),
        },
      }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      version: 1,
      mandateKind: 'TaskMandate',
      credentialSaid,
      grantSaid,
      presentationExpiresAt: grantExpiresAt,
      kind: 'AwaitingGrant',
    });
    await instance.close();
  });

  it('derives owner and deadline from run:prepare authority and returns persisted pending state', async () => {
    const authorize = vi.fn<MandateRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({
        kind: 'MandateAccessAuthorized',
        authority: { ownerAid, userCredentialSaid, grantExpiresAt },
      }),
    );
    const present = vi.fn<MandateRoutesConfiguration['conversation']['present']>(() =>
      Promise.resolve({ kind: 'MandatePresentationPending', presentation: admitting }),
    );
    const instance = await server(
      configuration({ access: { authorize }, conversation: { present } }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      version: 1,
      mandateKind: 'TaskMandate',
      credentialSaid,
      grantSaid,
      presentationExpiresAt: grantExpiresAt,
      kind: 'Admitting',
      operationName: 'operation.123',
    });
    expect(authorize).toHaveBeenCalledWith({
      bearerSecret,
      scope: 'run:prepare',
      observedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(present).toHaveBeenCalledWith({
      authority: { ownerAid, userCredentialSaid, grantExpiresAt },
      command: { mandateKind: 'TaskMandate', credentialSaid, grantSaid },
    });
    await instance.close();
  });

  it('rejects a forged owner field before invoking the application', async () => {
    const present = vi.fn<MandateRoutesConfiguration['conversation']['present']>();
    const instance = await server(configuration({ conversation: { present } }));

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid, ownerAid },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'MandatePresentationRequestInvalid' });
    expect(present).not.toHaveBeenCalled();
    await instance.close();
  });

  it.each([
    ['GrantEvidenceInvalid', 'holder grant sender mismatch'],
    ['CredentialBindingInvalid', 'ACDC issuer mismatch'],
    ['ResourceBindingInvalid', 'Task Revision mismatch'],
    ['AuthorityCeilingInvalid', 'capability or budget mismatch'],
    ['IncompatibleCredentialState', 'unknown TEL state'],
  ] as const)('returns the exact %s rejection for %s', async (reason, description) => {
    const instance = await server(
      configuration({
        conversation: {
          present: () => Promise.resolve({ kind: 'MandatePresentationRejected', reason }),
        },
      }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MandatePresentationRejected', reason });
    expect(description.length).toBeGreaterThan(0);
    await instance.close();
  });

  it.each([
    [{ kind: 'MandateAccessInvalid' as const }, 401, 'WorkAccessCapabilityInvalid'],
    [{ kind: 'MandateAccessExpired' as const }, 401, 'WorkAccessGrantExpired'],
    [
      { kind: 'MandateAccessRevoked' as const, reason: 'SecurityIncident' as const },
      403,
      'WorkAccessGrantRevoked',
    ],
    [{ kind: 'MandateAccessScopeRejected' as const }, 403, 'WorkAccessGrantScopeRejected'],
    [{ kind: 'MandateAccessConcurrentUpdate' as const }, 409, 'WorkAccessGrantConcurrentUpdate'],
    [{ kind: 'MandateAccessExhausted' as const }, 429, 'WorkAccessGrantExhausted'],
    [
      { kind: 'MandateAccessUnavailable' as const, dependency: 'HostedMongoDB' as const },
      503,
      'MandatePresentationUnavailable',
    ],
  ])('maps access outcome %j to a distinct public problem', async (authorization, status, code) => {
    const instance = await server(
      configuration({ access: { authorize: () => Promise.resolve(authorization) } }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    await instance.close();
  });

  it('keeps unexpected application failure opaque and server-attributed', async () => {
    const instance = await server(
      configuration({
        conversation: {
          present: () => Promise.reject(new Error('private mandate failure')),
        },
      }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/mandate-presentations/${credentialSaid}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { version: 1, mandateKind: 'TaskMandate', grantSaid },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('');
    expect(response.body).not.toContain('private mandate failure');
    await instance.close();
  });
});
