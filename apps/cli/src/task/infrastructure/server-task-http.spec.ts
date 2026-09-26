import { describe, expect, it } from 'vitest';

import {
  decodeDevrandomServerOrigin,
  type DevrandomFetch,
  type DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import {
  preparedTaskCommandFixture,
  taskProjectionFixture,
} from '../../../test/task-source-fixture.js';
import { ServerTaskHttp } from './server-task-http.js';

const bearer = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';

function serverOrigin(): DevrandomServerOrigin {
  const decoded = decodeDevrandomServerOrigin('https://server.example');
  if (decoded.kind !== 'Accepted') {
    throw new Error('expected server origin fixture to decode');
  }
  return decoded.origin;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('Devrandom Server Task HTTP adapter', () => {
  it('creates, lists, and inspects only typed Task projections with the grant bearer', async () => {
    const prepared = preparedTaskCommandFixture();
    const task = taskProjectionFixture(prepared);
    const responses = [
      new Response(JSON.stringify(task), {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      }),
      new Response(
        JSON.stringify({
          version: 1,
          tasks: [{ ...task, revision: undefined }],
          nextCursor: null,
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
      new Response(JSON.stringify(task), {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      }),
    ];
    const requests: { readonly input: string; readonly authorization: string | null }[] = [];
    const fetch: DevrandomFetch = (input, init) => {
      requests.push({
        input: requestUrl(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const response = responses.shift();
      return response === undefined
        ? Promise.reject(new Error('unexpected Task HTTP request'))
        : Promise.resolve(response);
    };
    const server = new ServerTaskHttp(serverOrigin(), bearer, fetch);

    await expect(server.create(prepared)).resolves.toEqual({ kind: 'Created', task });
    await expect(server.list({ limit: 25 })).resolves.toMatchObject({
      kind: 'Listed',
      page: { version: 1, nextCursor: null },
    });
    await expect(server.inspect('repair-parser')).resolves.toEqual({
      kind: 'Inspected',
      task,
    });
    expect(requests.map((request) => request.input)).toEqual([
      'https://server.example/api/tasks',
      'https://server.example/api/tasks?limit=25',
      'https://server.example/api/tasks/by-label/repair-parser',
    ]);
    expect(requests.every((request) => request.authorization === `Bearer ${bearer}`)).toBe(true);
  });

  it('preserves a typed expired-grant rejection', async () => {
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://devrandom.example/problems/work-access-grant-expired',
            title: 'Work Access Grant expired',
            status: 401,
            code: 'WorkAccessGrantExpired',
            correlationId: '44444444-4444-4444-8444-444444444444',
          }),
          { status: 401, headers: { 'cache-control': 'no-store' } },
        ),
      );

    await expect(new ServerTaskHttp(serverOrigin(), bearer, fetch).list({})).resolves.toMatchObject(
      {
        kind: 'RequestRejected',
        problem: { code: 'WorkAccessGrantExpired' },
      },
    );
  });

  it('rejects a structurally valid projection whose revision SAID binding disagrees', async () => {
    const task = taskProjectionFixture();
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ...task, revisionSaid: task.ownerAid }), {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        }),
      );

    await expect(
      new ServerTaskHttp(serverOrigin(), bearer, fetch).create(preparedTaskCommandFixture()),
    ).resolves.toEqual({ kind: 'ResponseInvalid' });
  });
});
