import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WorkAccessAttemptProjection } from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundedWorkAccessAttemptQuota } from './bounded-work-access-attempt-quota.js';
import type { WorkAccessConversation } from './work-access-routes.js';
import { workAccessRoutes } from './work-access-routes.js';

const secret = Buffer.alloc(32, 7).toString('base64url');
const grantSecretHash = `sha256:${'a'.repeat(64)}`;
const attemptId = '11111111-1111-4111-8111-111111111111';
const commandId = '33333333-3333-4333-8333-333333333333';
const clientInstanceId = '22222222-2222-4222-8222-222222222222';
const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
const issuerRecipientAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
const responseSaid = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const challengeWords = Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`);

const awaiting = {
  version: 1,
  kind: 'AwaitingProof',
  attemptId,
  userAid,
  credentialSaid,
  issuerRecipientAid,
  clientInstanceId,
  commandId,
  grantSecretHash,
  attemptExpiresAt: '2026-09-24T17:05:00.000Z',
  challengeWords,
} as const satisfies WorkAccessAttemptProjection;

const verifying = {
  version: 1,
  kind: 'VerifyingProof',
  attemptId,
  userAid,
  credentialSaid,
  issuerRecipientAid,
  clientInstanceId,
  commandId,
  grantSecretHash,
  attemptExpiresAt: '2026-09-24T17:05:00.000Z',
  responseSaid,
} as const satisfies WorkAccessAttemptProjection;

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function server(conversation: WorkAccessConversation) {
  const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  void instance.register(
    workAccessRoutes({
      conversation,
      newCorrelationId: () => '44444444-4444-4444-8444-444444444444',
    }),
  );
  servers.push(instance);
  return instance;
}

function conversation() {
  const create = vi.fn<WorkAccessConversation['create']>(() =>
    Promise.resolve({ kind: 'AttemptCreated', attempt: awaiting }),
  );
  const submitProof = vi.fn<WorkAccessConversation['submitProof']>(() =>
    Promise.resolve({ kind: 'ProofPending', attempt: verifying }),
  );
  const observe = vi.fn<WorkAccessConversation['observe']>(() =>
    Promise.resolve({ kind: 'ProofPending', attempt: verifying }),
  );
  const release = vi.fn<WorkAccessConversation['release']>(() =>
    Promise.resolve({ kind: 'GrantReleased' }),
  );
  return {
    access: { create, submitProof, observe, release } satisfies WorkAccessConversation,
    create,
    submitProof,
    release,
  };
}

describe('Work Access HTTP routes', () => {
  it('accepts exact bearer-authorized grant release at the public boundary', async () => {
    const fixture = conversation();
    const response = await server(fixture.access).inject({
      method: 'DELETE',
      url: `/api/work-access-attempts/${attemptId}/grant`,
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('');
    expect(fixture.release).toHaveBeenCalledWith({ attemptId, bearerSecret: secret });
  });

  it.each([
    [{ kind: 'CapabilityInvalid' } as const, 401, 'WorkAccessCapabilityInvalid'],
    [{ kind: 'GrantReleaseConflict' } as const, 409, 'WorkAccessGrantReleaseConflict'],
  ])('rejects release outcome %s at the public boundary', async (outcome, status, code) => {
    const fixture = conversation();
    fixture.release.mockResolvedValue(outcome);
    const response = await server(fixture.access).inject({
      method: 'DELETE',
      url: `/api/work-access-attempts/${attemptId}/grant`,
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, status });
  });

  it('enforces the same-source creation rate under concurrent public requests', async () => {
    let now = 1_000;
    const quota = new BoundedWorkAccessAttemptQuota(() => now);
    const sources: string[] = [];
    const create = vi.fn<WorkAccessConversation['create']>((input) => {
      sources.push(input.sourceAddress);
      const admission = quota.admit(input.sourceAddress);
      return Promise.resolve(
        admission.kind === 'AttemptQuotaAdmitted'
          ? { kind: 'AttemptCreated', attempt: awaiting }
          : { kind: 'AttemptRateExceeded' },
      );
    });
    const built = server({ ...conversation().access, create });
    const request = () =>
      built.inject({
        method: 'POST',
        url: '/api/work-access-attempts',
        payload: {
          version: 1,
          commandId: randomUUID(),
          clientInstanceId,
          userAid,
          credentialSaid,
          grantSecretHash,
        },
      });

    const responses = await Promise.all(Array.from({ length: 21 }, request));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      ...Array.from({ length: 20 }, () => 201),
      429,
    ]);
    expect(new Set(sources).size).toBe(1);
    expect(sources[0]).toBe('127.0.0.1');
    expect(create).toHaveBeenCalledTimes(21);
    now += 60_000;
    expect((await request()).statusCode).toBe(201);
  });

  it('creates through the closed public request and rejects unknown input fields', async () => {
    const fixture = conversation();
    const built = server(fixture.access);
    const body = {
      version: 1,
      commandId,
      clientInstanceId,
      userAid,
      credentialSaid,
      grantSecretHash,
    };

    const accepted = await built.inject({
      method: 'POST',
      url: '/api/work-access-attempts',
      payload: body,
    });
    const rejected = await built.inject({
      method: 'POST',
      url: '/api/work-access-attempts',
      payload: { ...body, grantSecret: secret },
    });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(accepted.json()).toEqual(awaiting);
    expect(rejected.statusCode).toBe(400);
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('submits proof using the precommitted bearer without returning it', async () => {
    const fixture = conversation();
    const response = await server(fixture.access).inject({
      method: 'PUT',
      url: `/api/work-access-attempts/${attemptId}/proof`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { version: 1, responseSaid },
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).not.toContain(secret);
    expect(fixture.submitProof).toHaveBeenCalledExactlyOnceWith({
      attemptId,
      bearerSecret: secret,
      responseSaid,
    });
  });

  it('accepts exactly 256 KiB and rejects the next byte before creating a Work Access attempt', async () => {
    const fixture = conversation();
    const built = server(fixture.access);
    const address = await built.listen({ host: '127.0.0.1', port: 0 });
    const body = JSON.stringify({
      version: 1,
      commandId,
      clientInstanceId,
      userAid,
      credentialSaid,
      grantSecretHash,
    });
    const exact = body.padEnd(262_144, ' ');
    expect(Buffer.byteLength(exact)).toBe(262_144);

    const admitted = await fetch(`${address}/api/work-access-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: exact,
    });
    expect(admitted.status).toBe(201);
    expect(fixture.create).toHaveBeenCalledTimes(1);

    const rejected = await fetch(`${address}/api/work-access-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `${exact} `,
    });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({
      code: 'WorkAccessBodyTooLarge',
      status: 413,
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('returns a closed problem document for an invalid capability', async () => {
    const access: WorkAccessConversation = {
      ...conversation().access,
      observe: () => Promise.resolve({ kind: 'CapabilityInvalid' }),
    };
    const response = await server(access).inject({
      method: 'GET',
      url: `/api/work-access-attempts/${attemptId}`,
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      type: 'https://devrandom.example/problems/work-access-capability-invalid',
      title: 'Work Access capability is invalid',
      status: 401,
      code: 'WorkAccessCapabilityInvalid',
      correlationId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it.each([
    [
      { kind: 'ProofRejected', reason: 'ChallengeProofInvalid' } as const,
      403,
      'WorkAccessProofRejected',
    ],
    [{ kind: 'ProofReplayed' } as const, 409, 'WorkAccessProofReplayed'],
    [{ kind: 'ConcurrentUpdate' } as const, 409, 'WorkAccessConcurrentUpdate'],
  ])('keeps the proof outcome %s distinct at the HTTP boundary', async (outcome, status, code) => {
    const access: WorkAccessConversation = {
      ...conversation().access,
      observe: () => Promise.resolve(outcome),
    };
    const response = await server(access).inject({
      method: 'GET',
      url: `/api/work-access-attempts/${attemptId}`,
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, status });
  });

  it('reports a submitted proof conflict without conflating it with replay', async () => {
    const access: WorkAccessConversation = {
      ...conversation().access,
      submitProof: () => Promise.resolve({ kind: 'ProofConflict' }),
    };
    const response = await server(access).inject({
      method: 'PUT',
      url: `/api/work-access-attempts/${attemptId}/proof`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { version: 1, responseSaid },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'WorkAccessProofConflict',
      status: 409,
    });
  });
});
