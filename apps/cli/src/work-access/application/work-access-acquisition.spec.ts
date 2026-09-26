import { CurrentTaskAuthority } from '../../task/application/user-tasks.js';
import { ServerWorkAccessHttp } from '../infrastructure/server-work-access-http.js';
import {
  confirmCurrentUserCustody,
  ProtectedCredentials,
  decideUserAdmission,
  verifyDevrandomUserCredential,
  type AdmittedUser,
} from '@devrandom/domain';
import { challengeResponseSaid, type ChallengeResponseSaid } from '@devrandom/identity';
import type { WorkAccessAttemptProjection } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { clientInstanceId, type ClientInstanceId } from '../../identity/domain/user-profile.js';
import type {
  CurrentUserAidProof,
  HostedWorkIdentityOutcome,
} from '../../identity/application/user-identity.js';
import {
  acquireWorkAccess,
  type WorkAccessAcquisitionDependencies,
} from './work-access-acquisition.js';

const attemptId = '123e4567-e89b-42d3-a456-426614174001';
const commandId = '123e4567-e89b-42d3-a456-426614174002';
const installationId = clientInstanceId('123e4567-e89b-42d3-a456-426614174003');
const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
const issuerAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
const responseSaid = challengeResponseSaid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');
const secretHash = 'sha256:9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885';
const bearer = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';
const challengeWords = Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`);

function admittedUser(): AdmittedUser {
  const custody = confirmCurrentUserCustody({
    user: { aid: userAid },
    controllerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    kelSequence: 0,
    witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
    witnessThreshold: 1,
    witnessReceiptIndexes: [0],
    verifiedAt: '2026-09-24T12:00:00.000Z',
  });
  if (custody.kind !== 'Current') {
    throw new Error('test custody must be current');
  }
  const credential = verifyDevrandomUserCredential(
    {
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    },
    {
      credentialSaid,
      attributeSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      issuedAt: '2026-09-24T11:00:00.000Z',
      verifiedAt: '2026-09-24T12:00:00.000Z',
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: {
        kind: 'Resolved',
        schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      },
      telState: { kind: 'Issued' },
      issuerAnchor: {
        kind: 'Anchored',
        eventSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
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
    throw new Error('test admission must be ready');
  }
  return admission.user;
}

function readyIdentity(
  proof: CurrentUserAidProof,
  clientId: ClientInstanceId = installationId,
): Extract<HostedWorkIdentityOutcome, { readonly kind: 'Ready' }> {
  return {
    kind: 'Ready',
    user: admittedUser(),
    clientInstanceId: clientId,
    userAidProof: proof,
    protectedCredentials: new ProtectedCredentials(['opaque-custody-fixture-732916']),
  };
}

function binding() {
  return {
    version: 1 as const,
    attemptId,
    commandId,
    clientInstanceId: installationId,
    userAid,
    credentialSaid,
    issuerRecipientAid: issuerAid,
    grantSecretHash: secretHash,
    attemptExpiresAt: '2026-09-24T12:05:00.000Z',
  };
}

function awaiting(): Extract<WorkAccessAttemptProjection, { readonly kind: 'AwaitingProof' }> {
  return { ...binding(), kind: 'AwaitingProof', challengeWords };
}

function verifying(): Extract<WorkAccessAttemptProjection, { readonly kind: 'VerifyingProof' }> {
  return { ...binding(), kind: 'VerifyingProof', responseSaid };
}

function granted(): Extract<WorkAccessAttemptProjection, { readonly kind: 'Granted' }> {
  return {
    ...binding(),
    kind: 'Granted',
    verifiedResponseSaid: responseSaid,
    scopes: ['task:read', 'task:create'],
    policyFingerprint: `sha256:${'a'.repeat(64)}`,
    disposition: {
      kind: 'Active',
      expiresAt: '2026-09-24T12:30:00.000Z',
      remainingRequests: 1_999,
    },
  };
}

function response(body: WorkAccessAttemptProjection, status: 200 | 201 | 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('Work Access acquisition', () => {
  it('reports grant capacity promptly when observation rejects a proof-ready attempt', async () => {
    const paths: string[] = [];
    const replies = [
      response(awaiting(), 201),
      response(verifying(), 202),
      new Response(
        JSON.stringify({
          type: 'https://devrandom.example/problems/work-access-capacity-exceeded',
          title: 'Work Access capacity exceeded',
          status: 429,
          code: 'WorkAccessCapacityExceeded',
          correlationId: commandId,
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
        },
      ),
    ];
    const acquired = await acquireWorkAccess(
      'http://127.0.0.1:3211',
      readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
      {
        randomBytes: () => new Uint8Array(32).fill(0xab),
        randomUUID: () => commandId,
        monotonicNow: () => 0,
        wait: () => Promise.resolve(),
        fetch: (input) => {
          paths.push(new URL(requestUrl(input)).pathname);
          const next = replies.shift();
          if (next === undefined) throw new Error('capacity must stop polling');
          return Promise.resolve(next);
        },
      },
    );
    expect(acquired).toEqual({
      kind: 'ServerRejected',
      code: 'WorkAccessCapacityExceeded',
      correlationId: commandId,
    });
    expect(paths).toEqual([
      '/api/work-access-attempts',
      `/api/work-access-attempts/${attemptId}/proof`,
      `/api/work-access-attempts/${attemptId}`,
    ]);
  });

  it.each(
    [
      {
        code: 'WorkAccessConcurrentUpdate',
        status: 409,
        title: 'Work Access Attempt changed concurrently',
        slug: 'work-access-concurrent-update',
      },
      {
        code: 'WorkAccessUnavailable',
        status: 503,
        title: 'Work Access dependency is unavailable',
        slug: 'work-access-unavailable',
      },
      { code: 'Network', status: 0, title: '', slug: '' },
    ].flatMap((fault) =>
      ['Granted', 'AttemptExpired', 'Interrupted'].map((ending) => ({ ...fault, ending })),
    ),
  )('retains one proof-ready attempt through $code until $ending', async (scenario) => {
    const paths: string[] = [];
    let proofs = 0;
    const failures =
      scenario.code === 'Network'
        ? Array.from({ length: 3 }, () => new Error('connection lost'))
        : [
            new Response(
              JSON.stringify({
                type: `https://devrandom.example/problems/${scenario.slug}`,
                title: scenario.title,
                status: scenario.status,
                code: scenario.code,
                correlationId: commandId,
              }),
              {
                status: scenario.status,
                headers: {
                  'content-type': 'application/problem+json',
                  'cache-control': 'no-store',
                },
              },
            ),
          ];
    const replies: (Response | Error)[] = [
      response(awaiting(), 201),
      response(verifying(), 202),
      ...failures,
      response(granted(), 200),
    ];
    const cancellation = new AbortController();
    let elapsed = 0;
    let waits = 0;
    const acquired = await acquireWorkAccess(
      'http://127.0.0.1:3211',
      readyIdentity({
        respond: () => {
          proofs += 1;
          return Promise.resolve(responseSaid);
        },
      }),
      {
        randomBytes: () => new Uint8Array(32).fill(0xab),
        randomUUID: () => commandId,
        monotonicNow: () => elapsed,
        wait: (milliseconds) => {
          elapsed += milliseconds;
          waits += 1;
          if (waits === failures.length + 1) {
            if (scenario.ending === 'AttemptExpired') elapsed = 300_000;
            if (scenario.ending === 'Interrupted') cancellation.abort();
          }
          return Promise.resolve();
        },
        fetch: (input) => {
          paths.push(new URL(requestUrl(input)).pathname);
          const next = replies.shift();
          if (next === undefined) throw new Error('Unexpected new acquisition');
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
      },
      cancellation.signal,
    );
    expect(acquired.kind).toBe(scenario.ending);
    expect(proofs).toBe(1);
    expect(paths).toEqual([
      '/api/work-access-attempts',
      `/api/work-access-attempts/${attemptId}/proof`,
      ...Array.from(
        { length: failures.length + (scenario.ending === 'Granted' ? 1 : 0) },
        () => `/api/work-access-attempts/${attemptId}`,
      ),
    ]);
    expect(replies).toHaveLength(scenario.ending === 'Granted' ? 0 : 1);
  });

  it('retains identity custody and protects both bearers when Task authority reacquires Work Access', async () => {
    const identity = readyIdentity({ respond: () => Promise.resolve(responseSaid) });
    const observedSignals: (AbortSignal | undefined)[] = [];
    let acquired = 0;
    const authority = new CurrentTaskAuthority(
      { admitHostedWork: () => Promise.resolve(identity) },
      'http://127.0.0.1:3211',
      (url, current, signal) => {
        expect(current).toBe(identity);
        observedSignals.push(signal);
        acquired += 1;
        const access = new ServerWorkAccessHttp(
          url,
          new Uint8Array(32).fill(acquired),
          fetch,
          current.protectedCredentials,
        );
        const server = access.authorizedWork({
          ...granted(),
          grantSecretHash: access.grantSecretHash,
        });
        return Promise.resolve({ kind: 'Granted', server, grantDeadline: acquired * 1_800_000 });
      },
    );
    const initial = await authority.acquireHostedWork();
    if (initial.kind !== 'Authorized') throw new Error('expected authority');
    const signal = new AbortController().signal;
    const replacement = await initial.workAccessRenewal.acquire(signal);
    expect(replacement).toMatchObject({
      kind: 'Granted',
      grant: {
        deadline: 3_600_000,
        userAid,
        credentialSaid,
        clientInstanceId: installationId,
        issuerAid,
      },
    });
    expect(observedSignals).toEqual([undefined, signal]);
    expect(initial.protectedCredentials).toBe(identity.protectedCredentials);
    for (const byte of [1, 2]) {
      const secret = Buffer.alloc(32, byte).toString('base64url');
      expect(initial.protectedCredentials.inspect(new TextEncoder().encode(secret))).toMatchObject({
        kind: 'WithheldSecret',
        reason: 'Credential',
      });
      expect(JSON.stringify(replacement)).not.toContain(secret);
    }
  });

  it('releases a superseded grant early and only the current bearer at command settlement', async () => {
    const identity = readyIdentity({ respond: () => Promise.resolve(responseSaid) });
    const released: { readonly path: string; readonly bearer: string | null }[] = [];
    let acquired = 0;
    const authority = new CurrentTaskAuthority(
      { admitHostedWork: () => Promise.resolve(identity) },
      'http://127.0.0.1:3211',
      (url, current) => {
        acquired += 1;
        const access = new ServerWorkAccessHttp(
          url,
          new Uint8Array(32).fill(acquired),
          (input, init) => {
            if (typeof input !== 'string' || init?.method !== 'DELETE') {
              throw new Error('expected a grant release request');
            }
            released.push({
              path: new URL(input).pathname,
              bearer: new Headers(init.headers).get('authorization'),
            });
            return Promise.resolve(
              new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
            );
          },
          current.protectedCredentials,
        );
        const server = access.authorizedWork({
          ...granted(),
          attemptId: acquired === 1 ? attemptId : '123e4567-e89b-42d3-a456-426614174099',
          grantSecretHash: access.grantSecretHash,
        });
        return Promise.resolve({ kind: 'Granted' as const, server, grantDeadline: 1_800_000 });
      },
    );

    const initial = await authority.acquireHostedWork();
    if (initial.kind !== 'Authorized') throw new Error('expected initial authority');
    const replacement = await initial.workAccessRenewal.acquire(new AbortController().signal);
    expect(replacement.kind).toBe('Granted');
    expect(released).toEqual([]);

    await initial.workAccessRenewal.initialGrant.release();
    expect(released.map((request) => request.path)).toEqual([
      `/api/work-access-attempts/${attemptId}/grant`,
    ]);

    await expect(authority.releaseHeldGrants()).resolves.toEqual({ kind: 'Released' });
    expect(released.map((request) => request.path)).toEqual([
      `/api/work-access-attempts/${attemptId}/grant`,
      `/api/work-access-attempts/123e4567-e89b-42d3-a456-426614174099/grant`,
    ]);
    expect(new Set(released.map((request) => request.bearer)).size).toBe(2);
    await expect(authority.releaseHeldGrants()).resolves.toEqual({ kind: 'Released' });
    expect(released).toHaveLength(2);
  });

  it('returns a late granted replacement to the Run owner after cancellation so it can retire the bearer', async () => {
    const identity = readyIdentity({ respond: () => Promise.resolve(responseSaid) });
    let acquired = 0;
    let finishLate: (() => void) | undefined;
    const authority = new CurrentTaskAuthority(
      { admitHostedWork: () => Promise.resolve(identity) },
      'http://127.0.0.1:3211',
      (url, current) => {
        acquired += 1;
        const access = new ServerWorkAccessHttp(
          url,
          new Uint8Array(32).fill(acquired),
          () =>
            Promise.resolve(
              new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
            ),
          current.protectedCredentials,
        );
        const server = access.authorizedWork({
          ...granted(),
          attemptId: acquired === 1 ? attemptId : '123e4567-e89b-42d3-a456-426614174099',
          grantSecretHash: access.grantSecretHash,
        });
        const result = { kind: 'Granted' as const, server, grantDeadline: 1_800_000 };
        if (acquired === 1) return Promise.resolve(result);
        return new Promise<typeof result>((resolve) => {
          finishLate = () => {
            resolve(result);
          };
        });
      },
    );
    const initial = await authority.acquireHostedWork();
    if (initial.kind !== 'Authorized') throw new Error('expected initial authority');
    const stopped = new AbortController();
    const late = initial.workAccessRenewal.acquire(stopped.signal);
    stopped.abort();
    if (!finishLate) throw new Error('expected pending replacement');
    finishLate();
    const outcome = await late;
    expect(outcome.kind).toBe('Granted');
    if (outcome.kind === 'Granted') await outcome.grant.release();
    await expect(authority.releaseHeldGrants()).resolves.toEqual({ kind: 'Released' });
  });

  it.each([
    { skew: -86_400_000, delay: 20_000, lifetime: 1_800_000, expected: 'Granted' },
    { skew: 86_400_000, delay: 20_000, lifetime: 1_800_000, expected: 'Granted' },
    { skew: 0, delay: 60_000, lifetime: 60_000, expected: 'GrantInactive' },
  ])(
    'uses elapsed request time with server skew $skew and lifetime $lifetime',
    async (scenario) => {
      let monotonic = 1_000;
      let requests = 0;
      const serverStart = Date.parse('2026-09-24T12:00:00.000Z') + scenario.skew;
      const attemptExpiresAt = new Date(serverStart + 300_000).toISOString();
      const outcome = await acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
        {
          randomBytes: () => new Uint8Array(32).fill(0xab),
          randomUUID: () => commandId,
          monotonicNow: () => monotonic,
          wait: () => Promise.resolve(),
          fetch: () => {
            requests += 1;
            if (requests === 1) {
              return Promise.resolve(response({ ...awaiting(), attemptExpiresAt }, 201));
            }
            monotonic += scenario.delay;
            return Promise.resolve(
              response(
                {
                  ...granted(),
                  attemptExpiresAt,
                  disposition: {
                    kind: 'Active',
                    remainingRequests: 1_999,
                    expiresAt: new Date(serverStart + scenario.lifetime).toISOString(),
                  },
                },
                200,
              ),
            );
          },
        },
      );
      expect(outcome.kind).toBe(scenario.expected);
      expect(requests).toBe(2);
      if (outcome.kind === 'Granted') {
        expect(outcome).toMatchObject({ grantDeadline: 1_000 + scenario.lifetime });
      } else {
        expect(outcome).toEqual({ kind: 'GrantInactive', disposition: 'Expired' });
      }
    },
  );

  it('does not reset attempt age after a lost create response and delayed replay', async () => {
    let monotonic = 10;
    let requests = 0;
    let proofs = 0;
    const outcome = await acquireWorkAccess(
      'http://127.0.0.1:3211',
      readyIdentity({
        respond: () => {
          proofs += 1;
          return Promise.resolve(responseSaid);
        },
      }),
      {
        randomBytes: () => new Uint8Array(32).fill(0xab),
        randomUUID: () => commandId,
        monotonicNow: () => monotonic,
        wait: () => Promise.resolve(),
        fetch: () => {
          requests += 1;
          monotonic += 150_000;
          return requests === 1
            ? Promise.reject(new Error('lost response'))
            : Promise.resolve(response(awaiting(), 200));
        },
      },
    );
    expect(outcome).toEqual({ kind: 'AttemptExpired' });
    expect({ requests, proofs }).toEqual({ requests: 2, proofs: 0 });
  });

  it.each([
    { stage: 'BeforeStart', requests: 0, proofs: 0 },
    { stage: 'AfterCreate', requests: 1, proofs: 0 },
    { stage: 'AfterProof', requests: 1, proofs: 1 },
    { stage: 'RetryWait', requests: 1, proofs: 0 },
    { stage: 'PollWait', requests: 2, proofs: 1 },
    { stage: 'GrantedResponse', requests: 2, proofs: 1 },
  ] as const)(
    'stops acquisition at $stage without accepting a late grant or starting another request',
    async (expected) => {
      const cancellation = new AbortController();
      if (expected.stage === 'BeforeStart') cancellation.abort();
      let requests = 0;
      let proofs = 0;
      let preparations = 0;
      const outcome = await acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({
          respond: () => {
            proofs += 1;
            if (expected.stage === 'AfterProof') cancellation.abort();
            return Promise.resolve(responseSaid);
          },
        }),
        {
          randomBytes: () => {
            preparations += 1;
            return new Uint8Array(32).fill(0xab);
          },
          randomUUID: () => commandId,
          monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
          wait: () => {
            cancellation.abort();
            return Promise.resolve();
          },
          fetch: () => {
            requests += 1;
            if (requests === 1) {
              if (expected.stage === 'RetryWait')
                return Promise.reject(new Error('temporary transport failure'));
              if (expected.stage === 'AfterCreate') cancellation.abort();
              return Promise.resolve(response(awaiting(), 201));
            }
            if (expected.stage === 'GrantedResponse') cancellation.abort();
            return Promise.resolve(
              expected.stage === 'PollWait' ? response(verifying(), 202) : response(granted(), 200),
            );
          },
        },
        cancellation.signal,
      );
      expect(outcome).toEqual({ kind: 'Interrupted' });
      expect(requests).toBe(expected.requests);
      expect(proofs).toBe(expected.proofs);
      expect(preparations).toBe(expected.stage === 'BeforeStart' ? 0 : 1);
    },
  );

  it('closes a local command identifier failure without making an HTTP request', async () => {
    let requests = 0;
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => {
        throw new Error(`${bearer}:${challengeWords.join(' ')}`);
      },
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: () => {
        requests += 1;
        return Promise.resolve(response(awaiting(), 201));
      },
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'LocalPreparationFailed' });
    expect(requests).toBe(0);
  });

  it('proves the validated binding and request-polls one attempt to an active grant', async () => {
    const proofWords: string[][] = [];
    const proof: CurrentUserAidProof = {
      respond(words): Promise<ChallengeResponseSaid> {
        proofWords.push([...words]);
        return Promise.resolve(responseSaid);
      },
    };
    const responses = [
      response(awaiting(), 201),
      response(verifying(), 202),
      response(verifying(), 202),
      response(granted(), 200),
    ];
    const requests: { readonly url: string; readonly init?: RequestInit | undefined }[] = [];
    const waits: number[] = [];
    const sourceSecret = new Uint8Array(32).fill(0xab);
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: (size) => {
        expect(size).toBe(32);
        return sourceSecret;
      },
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      fetch: (input, init) => {
        requests.push({ url: requestUrl(input), init });
        const next = responses.shift();
        return next === undefined
          ? Promise.reject(new Error('unexpected request'))
          : Promise.resolve(next);
      },
    };

    const outcome = await acquireWorkAccess(
      'http://127.0.0.1:3211',
      readyIdentity(proof),
      dependencies,
    );

    expect(outcome).toMatchObject({ kind: 'Granted' });
    if (outcome.kind !== 'Granted') {
      throw new Error(`expected a grant, received ${outcome.kind}`);
    }
    expect(outcome.server.grant).toEqual(granted());
    expect(
      outcome.server.protectedCredentials.inspect(
        new TextEncoder().encode('opaque-custody-fixture-732916'),
      ),
    ).toEqual({ kind: 'WithheldSecret', reason: 'Credential', byteLength: 29 });
    expect(
      outcome.server.protectedCredentials.inspect(new TextEncoder().encode(bearer)),
    ).toMatchObject({ kind: 'WithheldSecret', reason: 'Credential' });
    expect(JSON.stringify(outcome.server.protectedCredentials)).toBe('{}');
    expect(proofWords).toEqual([challengeWords]);
    expect(waits).toEqual([1_000, 1_000]);
    expect(sourceSecret).toEqual(new Uint8Array(32));
    expect(requests).toHaveLength(4);
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBeNull();
    expect(
      requests.slice(1).map((request) => new Headers(request.init?.headers).get('authorization')),
    ).toEqual([`Bearer ${bearer}`, `Bearer ${bearer}`, `Bearer ${bearer}`]);
    const creationBody = requests[0]?.init?.body;
    expect(typeof creationBody).toBe('string');
    expect(creationBody).toContain(secretHash);
    expect(creationBody).not.toContain(bearer);
    expect(JSON.stringify(outcome.server)).not.toContain(bearer);
  });

  it.each([
    ['command', { commandId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['client', { clientInstanceId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['user', { userAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk' }],
    ['credential', { credentialSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs' }],
    ['issuer', { issuerRecipientAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs' }],
    ['secret hash', { grantSecretHash: `sha256:${'b'.repeat(64)}` }],
  ] as const)('rejects an echoed %s mismatch before AID proof', async (_label, mismatch) => {
    let proofCalls = 0;
    const projection = { ...awaiting(), ...mismatch };
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: () => Promise.resolve(response(projection, 201)),
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({
          respond: () => {
            proofCalls += 1;
            return Promise.resolve(responseSaid);
          },
        }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'ServerResponseInvalid' });
    expect(proofCalls).toBe(0);
  });

  it.each([
    ['attempt', { attemptId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['command', { commandId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['client', { clientInstanceId: '123e4567-e89b-42d3-a456-426614174099' }],
    ['user', { userAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk' }],
    ['credential', { credentialSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs' }],
    ['issuer', { issuerRecipientAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs' }],
    ['secret hash', { grantSecretHash: `sha256:${'b'.repeat(64)}` }],
    ['attempt expiry', { attemptExpiresAt: '2026-09-24T12:06:00.000Z' }],
  ] as const)('rejects a post-proof echoed %s mismatch', async (_label, mismatch) => {
    const responses = [response(awaiting(), 201), response({ ...verifying(), ...mismatch }, 202)];
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: () => {
        const next = responses.shift();
        return next === undefined
          ? Promise.reject(new Error('unexpected request'))
          : Promise.resolve(next);
      },
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'ServerResponseInvalid' });
    expect(responses).toHaveLength(0);
  });

  it('rejects a proof projection that echoes a different response SAID', async () => {
    const responses = [
      response(awaiting(), 201),
      response(
        {
          ...verifying(),
          responseSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
        },
        202,
      ),
    ];
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: () => {
        const next = responses.shift();
        return next === undefined
          ? Promise.reject(new Error('unexpected request'))
          : Promise.resolve(next);
      },
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'ServerResponseInvalid' });
  });

  it('rejects a non-24-word challenge before AID proof', async () => {
    let proofCalls = 0;
    const malformed = { ...awaiting(), challengeWords: challengeWords.slice(1) };
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(malformed), {
            status: 201,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          }),
        ),
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({
          respond: () => {
            proofCalls += 1;
            return Promise.resolve(responseSaid);
          },
        }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'ServerResponseInvalid' });
    expect(proofCalls).toBe(0);
  });

  it('retries ambiguous create and proof requests with the same command, bearer, and response SAID', async () => {
    const calls: {
      readonly url: string;
      readonly authorization: string | null;
      readonly body?: BodyInit | null;
    }[] = [];
    const responses: (Response | Error)[] = [
      new Error(`lost create response ${bearer}`),
      response(awaiting(), 200),
      new Error(`lost proof response ${challengeWords[0] ?? 'challenge'}`),
      response(verifying(), 202),
      response(granted(), 200),
    ];
    let proofCalls = 0;
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => Date.parse('2026-09-24T12:00:00.000Z'),
      wait: () => Promise.resolve(),
      fetch: (input, init) => {
        const call = {
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get('authorization'),
        };
        calls.push(init?.body === undefined ? call : { ...call, body: init.body });
        const next = responses.shift();
        if (next instanceof Error) {
          return Promise.reject(next);
        }
        return next === undefined
          ? Promise.reject(new Error('unexpected request'))
          : Promise.resolve(next);
      },
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({
          respond: () => {
            proofCalls += 1;
            return Promise.resolve(responseSaid);
          },
        }),
        dependencies,
      ),
    ).resolves.toMatchObject({ kind: 'Granted' });

    expect(proofCalls).toBe(1);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[2]?.body).toBe(calls[3]?.body);
    expect(calls[2]?.authorization).toBe(`Bearer ${bearer}`);
    expect(calls[3]?.authorization).toBe(`Bearer ${bearer}`);
    expect(calls[2]?.body).toBe(JSON.stringify({ version: 1, responseSaid }));
  });

  it('stops request-driven polling at the attempt expiry', async () => {
    let now = 0;
    let requests = 0;
    const dependencies: WorkAccessAcquisitionDependencies = {
      randomBytes: () => new Uint8Array(32).fill(0xab),
      randomUUID: () => commandId,
      monotonicNow: () => now,
      wait: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
      fetch: () => {
        requests += 1;
        if (requests === 1) now += 298_000;
        return Promise.resolve(
          requests === 1 ? response(awaiting(), 201) : response(verifying(), 202),
        );
      },
    };

    await expect(
      acquireWorkAccess(
        'http://127.0.0.1:3211',
        readyIdentity({ respond: () => Promise.resolve(responseSaid) }),
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'AttemptExpired' });
    expect(requests).toBe(3);
  });
});
