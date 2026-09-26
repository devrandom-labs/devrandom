import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import { issuerAid as decodeIssuerAid, personalAgentAid } from '@devrandom/identity';

import {
  prepareEvaluationSourceInventory,
  type CreateWorkAccessAttemptBody,
  type WorkAccessAttemptProjection,
} from '@devrandom/protocol';

import type { DevrandomFetch } from '../../infrastructure/devrandom-server-http.js';
import { ServerHarnessHttp } from '../../harness/infrastructure/server-harness-http.js';
import { ServerMandatePresentationHttp } from '../../mandate/infrastructure/server-mandate-http.js';
import { ServerTaskHttp } from '../../task/infrastructure/server-task-http.js';
import { ServerWorkAccessHttp, WorkAccessHttpFailure } from './server-work-access-http.js';

const grantSecret = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';
const grantSecretHash = 'sha256:9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885';
const attemptId = '123e4567-e89b-42d3-a456-426614174001';
const commandId = '123e4567-e89b-42d3-a456-426614174002';
const clientInstanceId = '123e4567-e89b-42d3-a456-426614174003';
const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
const issuerAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
const responseSaid = 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4';
const challengeWords = Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`);

const command: CreateWorkAccessAttemptBody = {
  version: 1,
  commandId,
  clientInstanceId,
  userAid,
  credentialSaid,
  grantSecretHash,
};

const awaiting: WorkAccessAttemptProjection = {
  ...command,
  attemptId,
  issuerRecipientAid: issuerAid,
  attemptExpiresAt: '2026-09-24T12:05:00.000Z',
  kind: 'AwaitingProof',
  challengeWords,
};

const verifying: WorkAccessAttemptProjection = {
  ...command,
  attemptId,
  issuerRecipientAid: issuerAid,
  attemptExpiresAt: awaiting.attemptExpiresAt,
  kind: 'VerifyingProof',
  responseSaid,
};

const granted: Extract<WorkAccessAttemptProjection, { readonly kind: 'Granted' }> = {
  ...command,
  attemptId,
  issuerRecipientAid: issuerAid,
  attemptExpiresAt: awaiting.attemptExpiresAt,
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

it('opens H0 Context only under both current retrieval and raw-read scopes without exposing the bearer', () => {
  const prepared = prepareEvaluationSourceInventory({
    taskId: commandId,
    taskRevisionSaid: credentialSaid,
    ownerAid: userAid,
    repositoryResourceSaid: issuerAid,
    corpusSaid: responseSaid,
    experienceMandateSaid: credentialSaid,
    sources: [
      {
        episodeSaid: issuerAid,
        rawEvidenceSaid: responseSaid,
        ownerAid: userAid,
        repositoryResourceSaid: issuerAid,
        corpusSaid: responseSaid,
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (prepared.kind !== 'Prepared') throw new Error('inventory fixture rejected');
  const access = new ServerWorkAccessHttp('http://127.0.0.1:3211', new Uint8Array(32).fill(0xab));
  expect(() => access.authorizedWork(granted).context(prepared.inventory)).toThrow(
    WorkAccessHttpFailure,
  );
  expect(() =>
    access
      .authorizedWork({ ...granted, scopes: ['experience:retrieve'] })
      .context(prepared.inventory),
  ).toThrow(WorkAccessHttpFailure);
  const scoped = access
    .authorizedWork({
      ...granted,
      scopes: ['experience:retrieve', 'evidence:read'],
    })
    .context(prepared.inventory);
  expect(JSON.stringify(scoped)).not.toContain(grantSecret);
  expect(typeof scoped.retrieval.retrieve).toBe('function');
  expect(typeof scoped.reading.read).toBe('function');
});

function jsonResponse(body: WorkAccessAttemptProjection, status: 200 | 201 | 202): Response {
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

describe('Devrandom Server Work Access HTTP', () => {
  it('exposes activation only from an active grant with exact activation:commit scope', () => {
    const access = new ServerWorkAccessHttp('http://127.0.0.1:3211', new Uint8Array(32).fill(0xab));
    const receipts = { inspect: vi.fn() };
    const source = decodeIssuerAid(issuerAid);
    const recipient = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
    expect(() => access.authorizedWork(granted).activation(receipts, source, recipient)).toThrow();
    const scoped = access.authorizedWork({ ...granted, scopes: ['activation:commit'] });
    expect(scoped.activation(receipts, source, recipient)).toBeDefined();
    expect(scoped.activationPointer()).toBeDefined();
    expect(() => access.authorizedWork(granted).activationPointer()).toThrow();
    expect(() =>
      access
        .authorizedWork({
          ...granted,
          scopes: ['activation:commit'],
          disposition: { kind: 'Expired' },
        })
        .activation(receipts, source, recipient),
    ).toThrow();
  });

  it('retries a lost release reply with the exact DELETE path and bearer', async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch: DevrandomFetch = (input, init) => {
      requests.push({ url: requestUrl(input), init });
      return requests.length === 1
        ? Promise.reject(new Error('reply lost after commit'))
        : Promise.resolve(
            new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
          );
    };
    const access = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    ).authorizedWork(granted);

    await expect(access.releaseGrant()).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url)).toEqual([
      `http://127.0.0.1:3211/api/work-access-attempts/${attemptId}/grant`,
      `http://127.0.0.1:3211/api/work-access-attempts/${attemptId}/grant`,
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(['DELETE', 'DELETE']);
    expect(requests.map(({ init }) => new Headers(init?.headers).get('authorization'))).toEqual([
      `Bearer ${grantSecret}`,
      `Bearer ${grantSecret}`,
    ]);
  });

  it('fails release promptly for a closed capability problem', async () => {
    const fetch = vi.fn<DevrandomFetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'https://devrandom.example/problems/work-access-capability-invalid',
          title: 'Work Access capability is invalid',
          status: 401,
          code: 'WorkAccessCapabilityInvalid',
          correlationId: '44444444-4444-4444-8444-444444444444',
        }),
        { status: 401, headers: { 'cache-control': 'no-store' } },
      ),
    );
    const access = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    ).authorizedWork(granted);

    await expect(access.releaseGrant()).rejects.toMatchObject({
      detail: { kind: 'request-rejected', problem: { code: 'WorkAccessCapabilityInvalid' } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: 409,
      body: {
        type: 'https://devrandom.example/problems/work-access-grant-release-conflict',
        title: 'Work Access Grant cannot be released',
        status: 409,
        code: 'WorkAccessGrantReleaseConflict',
        correlationId: '44444444-4444-4444-8444-444444444444',
      },
      failure: 'request-rejected',
    },
    { status: 204, body: undefined, failure: 'server-response-invalid' },
  ] as const)('does not retry a $status release response that fails closed', async (scenario) => {
    const fetch = vi.fn<DevrandomFetch>().mockResolvedValue(
      new Response(scenario.body === undefined ? null : JSON.stringify(scenario.body), {
        status: scenario.status,
        headers: scenario.status === 204 ? {} : { 'cache-control': 'no-store' },
      }),
    );
    const access = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    ).authorizedWork(granted);

    await expect(access.releaseGrant()).rejects.toMatchObject({
      detail: { kind: scenario.failure },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(
    (['Create', 'Proof', 'Observe'] as const).flatMap((operation) =>
      (['Headers', 'Body'] as const).flatMap((stage) =>
        (['Deadline', 'Cancellation'] as const).map((stop) => ({ operation, stage, stop })),
      ),
    ),
  )(
    'stops $operation waiting for $stage on $stop over real HTTP',
    async ({ operation, stage, stop }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const requested = Promise.withResolvers<undefined>();
      const received = Promise.withResolvers<undefined>();
      const server = createServer((request, response) => {
        request.resume();
        if (stage === 'Body') {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          });
          response.write('{');
        }
        requested.resolve(undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      let pending: Promise<void> | undefined;
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Expected HTTP address');
        const access = new ServerWorkAccessHttp(
          `http://127.0.0.1:${String(address.port)}`,
          new Uint8Array(32).fill(0xab),
          async (input, init) => {
            const response = await fetch(input, init);
            received.resolve(undefined);
            return response;
          },
        );
        const cancellation = new AbortController();
        const settled = vi.fn();
        const outcome =
          operation === 'Create'
            ? access.createAttempt(command, cancellation.signal)
            : operation === 'Proof'
              ? access.submitProof(attemptId, responseSaid, cancellation.signal)
              : access.observeAttempt(attemptId, cancellation.signal);
        pending = outcome.then(
          () => {
            settled('UnexpectedSuccess');
          },
          (cause: unknown) => {
            settled(cause instanceof WorkAccessHttpFailure ? cause.detail : 'UnexpectedFailure');
          },
        );
        await requested.promise;
        if (stage === 'Body') await received.promise;
        if (stop === 'Deadline') {
          await vi.advanceTimersByTimeAsync(9999);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
        } else cancellation.abort();
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toHaveBeenCalledExactlyOnceWith({ kind: 'server-unavailable' });
      } finally {
        server.closeAllConnections();
        await pending;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        );
        vi.useRealTimers();
      }
    },
  );

  it('precommits the raw-byte hash without authorizing attempt creation', async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch: DevrandomFetch = (input, init) => {
      requests.push({ url: requestUrl(input), init });
      return Promise.resolve(jsonResponse(awaiting, 201));
    };
    const http = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    );

    await expect(http.createAttempt(command)).resolves.toEqual(awaiting);
    expect(http.grantSecretHash).toBe(grantSecretHash);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:3211/api/work-access-attempts');
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBeNull();
    expect(requests[0]?.init?.body).toBe(JSON.stringify(command));
    expect(JSON.stringify(http)).not.toContain(grantSecret);
  });

  it('rejects an attempt command that does not precommit its own retained secret', async () => {
    let requests = 0;
    const http = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      () => {
        requests += 1;
        return Promise.resolve(jsonResponse(awaiting, 201));
      },
    );

    await expect(
      http.createAttempt({ ...command, grantSecretHash: `sha256:${'b'.repeat(64)}` }),
    ).rejects.toMatchObject({
      detail: { kind: 'request-invalid' },
    });
    expect(requests).toBe(0);
  });

  it('uses the same private bearer for proof, polling, and granted observation', async () => {
    const requests: RequestInit[] = [];
    const responses = [
      jsonResponse(verifying, 202),
      jsonResponse(verifying, 202),
      jsonResponse(granted, 200),
    ];
    const fetch: DevrandomFetch = (_input, init) => {
      requests.push(init ?? {});
      const response = responses.shift();
      if (response === undefined) {
        return Promise.reject(new Error('unexpected request'));
      }
      return Promise.resolve(response);
    };
    const http = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    );

    await expect(http.submitProof(attemptId, responseSaid)).resolves.toEqual({
      kind: 'Pending',
      attempt: verifying,
    });
    await expect(http.observeAttempt(attemptId)).resolves.toEqual({
      kind: 'Pending',
      attempt: verifying,
    });
    const authorized = http.authorizedWork(granted);
    expect(authorized.tasks()).toBeInstanceOf(ServerTaskHttp);
    expect(authorized.mandates()).toBeInstanceOf(ServerMandatePresentationHttp);
    expect(authorized.harnesses()).toBeInstanceOf(ServerHarnessHttp);
    await expect(authorized.observeWorkAccessAttempt()).resolves.toEqual({
      kind: 'Observed',
      attempt: granted,
    });

    expect(requests.map((request) => new Headers(request.headers).get('authorization'))).toEqual([
      `Bearer ${grantSecret}`,
      `Bearer ${grantSecret}`,
      `Bearer ${grantSecret}`,
    ]);
    expect(JSON.stringify(authorized)).not.toContain(grantSecret);
    expect('grantSecret' in authorized).toBe(false);
    expect(authorized.protectedCredentials.inspect(new TextEncoder().encode(grantSecret))).toEqual({
      kind: 'WithheldSecret',
      reason: 'Credential',
      byteLength: new TextEncoder().encode(grantSecret).byteLength,
    });
    expect(JSON.stringify(authorized.protectedCredentials)).toBe('{}');
    expect('authorization' in authorized).toBe(false);
    expect('toJSON' in authorized).toBe(false);
  });

  it('returns a closed failure that cannot retain bearer or challenge material', async () => {
    const forbidden = `${grantSecret}:${challengeWords.join(' ')}`;
    const fetch: DevrandomFetch = () => Promise.reject(new Error(forbidden));
    const http = new ServerWorkAccessHttp(
      'http://127.0.0.1:3211',
      new Uint8Array(32).fill(0xab),
      fetch,
    );

    let failure: unknown;
    try {
      await http.submitProof(attemptId, responseSaid);
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(WorkAccessHttpFailure);
    const rendered =
      failure instanceof Error ? `${failure.name}:${failure.message}` : String(failure);
    expect(rendered).not.toContain(grantSecret);
    expect(rendered).not.toContain(challengeWords[0] ?? 'word-0');
    expect(JSON.stringify(failure)).not.toContain(grantSecret);
  });
});
