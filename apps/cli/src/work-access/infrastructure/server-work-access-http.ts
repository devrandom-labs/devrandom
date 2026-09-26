import { createHash } from 'node:crypto';

import { ProtectedCredentials } from '@devrandom/domain';

import {
  createWorkAccessAttemptBodySchema,
  submitWorkAccessProofBodySchema,
  workAccessAttemptParametersSchema,
  workAccessAttemptProjectionSchema,
  workAccessProblemSchema,
  type CreateWorkAccessAttemptBody,
  type WorkAccessAttemptProjection,
  type WorkAccessProblem,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import {
  decodeDevrandomServerOrigin,
  type DevrandomFetch,
  type DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import { ServerHarnessHttp } from '../../harness/infrastructure/server-harness-http.js';
import { ServerMandatePresentationHttp } from '../../mandate/infrastructure/server-mandate-http.js';
import { ServerRunHttp } from '../../run/infrastructure/server-run-http.js';
import { ServerEvidenceHttp } from '../../run/infrastructure/server-evidence-http.js';
import { ServerTaskHttp } from '../../task/infrastructure/server-task-http.js';

export type WorkAccessHttpError =
  | { readonly kind: 'server-url-invalid' }
  | { readonly kind: 'grant-secret-invalid' }
  | { readonly kind: 'request-invalid' }
  | { readonly kind: 'server-unavailable' }
  | { readonly kind: 'server-response-invalid' }
  | { readonly kind: 'request-rejected'; readonly problem: WorkAccessProblem };

const workAccessRequestTimeoutMilliseconds = 10_000;

export class WorkAccessHttpFailure extends Error {
  readonly detail: WorkAccessHttpError;

  constructor(detail: WorkAccessHttpError) {
    super(detail.kind);
    this.name = 'WorkAccessHttpFailure';
    this.detail = detail;
  }
}

export type WorkAccessHttpObservation =
  | { readonly kind: 'Pending'; readonly attempt: WorkAccessAttemptProjection }
  | { readonly kind: 'Observed'; readonly attempt: WorkAccessAttemptProjection };

export type GrantedWorkAccessProjection = Extract<
  WorkAccessAttemptProjection,
  { readonly kind: 'Granted' }
>;

export type GrantedWorkAccess = Readonly<
  Omit<GrantedWorkAccessProjection, 'scopes' | 'disposition'> & {
    readonly scopes: readonly GrantedWorkAccessProjection['scopes'][number][];
    readonly disposition: Readonly<GrantedWorkAccessProjection['disposition']>;
  }
>;

export class ServerWorkAccessHttp {
  readonly #serverOrigin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #protectedCredentials: ProtectedCredentials;
  readonly #fetch: DevrandomFetch;
  readonly grantSecretHash: string;

  constructor(
    serverUrl: string,
    secretBytes: Uint8Array,
    fetch: DevrandomFetch = globalThis.fetch,
    protectedCredentials = new ProtectedCredentials(),
  ) {
    const decodedOrigin = decodeDevrandomServerOrigin(serverUrl);
    if (decodedOrigin.kind === 'Rejected') {
      throw new WorkAccessHttpFailure({ kind: 'server-url-invalid' });
    }
    this.#serverOrigin = decodedOrigin.origin;
    if (secretBytes.byteLength !== 32) {
      throw new WorkAccessHttpFailure({ kind: 'grant-secret-invalid' });
    }
    const retainedBytes = Uint8Array.from(secretBytes);
    this.#bearer = Buffer.from(retainedBytes).toString('base64url');
    this.grantSecretHash = `sha256:${createHash('sha256').update(retainedBytes).digest('hex')}`;
    retainedBytes.fill(0);
    this.#fetch = fetch;
    this.#protectedCredentials = protectedCredentials;
    this.#protectedCredentials.protect(this.#bearer);
  }

  async createAttempt(
    command: CreateWorkAccessAttemptBody,
    signal?: AbortSignal,
  ): Promise<WorkAccessAttemptProjection> {
    if (
      !Value.Check(createWorkAccessAttemptBodySchema, command) ||
      command.grantSecretHash !== this.grantSecretHash
    ) {
      throw new WorkAccessHttpFailure({ kind: 'request-invalid' });
    }
    const response = await this.#request(
      '/api/work-access-attempts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
        ...(signal === undefined ? {} : { signal }),
      },
      [200, 201],
    );
    return response.attempt;
  }

  async submitProof(
    attemptId: string,
    responseSaid: string,
    signal?: AbortSignal,
  ): Promise<WorkAccessHttpObservation> {
    const body = { version: 1 as const, responseSaid };
    if (
      !Value.Check(workAccessAttemptParametersSchema, { attemptId }) ||
      !Value.Check(submitWorkAccessProofBodySchema, body)
    ) {
      throw new WorkAccessHttpFailure({ kind: 'request-invalid' });
    }
    const response = await this.#request(
      `/api/work-access-attempts/${encodeURIComponent(attemptId)}/proof`,
      {
        method: 'PUT',
        headers: this.#authorizedHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
      [200, 202],
    );
    return responseStatus(response.status, response.attempt);
  }

  async observeAttempt(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<WorkAccessHttpObservation> {
    if (!Value.Check(workAccessAttemptParametersSchema, { attemptId })) {
      throw new WorkAccessHttpFailure({ kind: 'request-invalid' });
    }
    const response = await this.#request(
      `/api/work-access-attempts/${encodeURIComponent(attemptId)}`,
      { headers: this.#authorizedHeaders(), ...(signal === undefined ? {} : { signal }) },
      [200, 202],
    );
    return responseStatus(response.status, response.attempt);
  }

  async releaseGrant(attemptId: string): Promise<void> {
    if (!Value.Check(workAccessAttemptParametersSchema, { attemptId })) {
      throw new WorkAccessHttpFailure({ kind: 'request-invalid' });
    }
    let unavailable: WorkAccessHttpFailure | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#releaseOnce(attemptId);
        return;
      } catch (cause) {
        if (
          !(cause instanceof WorkAccessHttpFailure) ||
          cause.detail.kind !== 'server-unavailable'
        ) {
          throw cause;
        }
        unavailable = cause;
        if (attempt < 2) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          });
        }
      }
    }
    throw unavailable ?? new WorkAccessHttpFailure({ kind: 'server-unavailable' });
  }

  async #releaseOnce(attemptId: string): Promise<void> {
    const cancellation = new AbortController();
    const timeout = setTimeout(() => {
      cancellation.abort();
    }, workAccessRequestTimeoutMilliseconds);
    try {
      const response = await this.#fetch(
        `${this.#serverOrigin}/api/work-access-attempts/${encodeURIComponent(attemptId)}/grant`,
        { method: 'DELETE', headers: this.#authorizedHeaders(), signal: cancellation.signal },
      );
      const body = await response.text();
      if (response.status === 204) {
        if (response.headers.get('cache-control') !== 'no-store' || body !== '') {
          throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
        }
        return;
      }
      let problem: unknown;
      try {
        problem = JSON.parse(body);
      } catch {
        throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
      }
      if (Value.Check(workAccessProblemSchema, problem)) {
        throw new WorkAccessHttpFailure({ kind: 'request-rejected', problem });
      }
      throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
    } catch (cause) {
      if (cause instanceof WorkAccessHttpFailure) throw cause;
      throw new WorkAccessHttpFailure({ kind: 'server-unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }

  authorizedWork(grant: GrantedWorkAccessProjection): GrantedServerWorkHttp {
    return new GrantedServerWorkHttp(
      this,
      new ServerTaskHttp(this.#serverOrigin, this.#bearer, this.#fetch),
      new ServerMandatePresentationHttp(this.#serverOrigin, this.#bearer, this.#fetch),
      new ServerHarnessHttp(this.#serverOrigin, this.#bearer, this.#fetch),
      new ServerRunHttp(this.#serverOrigin, this.#bearer, this.#fetch),
      new ServerEvidenceHttp(this.#serverOrigin, this.#bearer, this.#fetch),
      grant,
      this.#protectedCredentials,
    );
  }

  #authorizedHeaders(additional?: Readonly<{ 'content-type': 'application/json' }>): HeadersInit {
    return additional === undefined
      ? { authorization: `Bearer ${this.#bearer}` }
      : { ...additional, authorization: `Bearer ${this.#bearer}` };
  }

  async #request(
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
  ): Promise<{ readonly status: number; readonly attempt: WorkAccessAttemptProjection }> {
    const cancellation = new AbortController();
    const signal =
      init.signal === undefined || init.signal === null
        ? cancellation.signal
        : AbortSignal.any([init.signal, cancellation.signal]);
    const timeout = setTimeout(() => {
      cancellation.abort();
    }, workAccessRequestTimeoutMilliseconds);
    try {
      signal.throwIfAborted();
      const response = await this.#fetch(`${this.#serverOrigin}${path}`, { ...init, signal });
      signal.throwIfAborted();
      const encoded = await response.text();
      signal.throwIfAborted();
      let body: unknown;
      try {
        body = JSON.parse(encoded);
      } catch {
        throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
      }
      if (!expectedStatuses.includes(response.status)) {
        if (Value.Check(workAccessProblemSchema, body)) {
          throw new WorkAccessHttpFailure({ kind: 'request-rejected', problem: body });
        }
        throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
      }
      if (
        response.headers.get('cache-control') !== 'no-store' ||
        !Value.Check(workAccessAttemptProjectionSchema, body)
      ) {
        throw new WorkAccessHttpFailure({ kind: 'server-response-invalid' });
      }
      return {
        status: response.status,
        attempt: Value.Parse(workAccessAttemptProjectionSchema, body),
      };
    } catch (cause) {
      if (cause instanceof WorkAccessHttpFailure) throw cause;
      throw new WorkAccessHttpFailure({ kind: 'server-unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class GrantedServerWorkHttp {
  readonly #access: ServerWorkAccessHttp;
  readonly #tasks: ServerTaskHttp;
  readonly #mandates: ServerMandatePresentationHttp;
  readonly #harnesses: ServerHarnessHttp;
  readonly #runs: ServerRunHttp;
  readonly #evidence: ServerEvidenceHttp;
  readonly grant: GrantedWorkAccess;
  readonly protectedCredentials: ProtectedCredentials;

  constructor(
    access: ServerWorkAccessHttp,
    tasks: ServerTaskHttp,
    mandates: ServerMandatePresentationHttp,
    harnesses: ServerHarnessHttp,
    runs: ServerRunHttp,
    evidence: ServerEvidenceHttp,
    grant: GrantedWorkAccessProjection,
    protectedCredentials: ProtectedCredentials,
  ) {
    this.#access = access;
    this.protectedCredentials = protectedCredentials;
    this.#tasks = tasks;
    this.#mandates = mandates;
    this.#harnesses = harnesses;
    this.#runs = runs;
    this.#evidence = evidence;
    const retained = {
      ...grant,
      scopes: [...grant.scopes],
      disposition: { ...grant.disposition },
    };
    Object.freeze(retained.scopes);
    Object.freeze(retained.disposition);
    this.grant = Object.freeze(retained);
  }

  observeWorkAccessAttempt(): Promise<WorkAccessHttpObservation> {
    return this.#access.observeAttempt(this.grant.attemptId);
  }

  releaseGrant(): Promise<void> {
    return this.#access.releaseGrant(this.grant.attemptId);
  }

  tasks(): ServerTaskHttp {
    return this.#tasks;
  }

  mandates(): ServerMandatePresentationHttp {
    return this.#mandates;
  }

  harnesses(): ServerHarnessHttp {
    return this.#harnesses;
  }

  runs(): ServerRunHttp {
    return this.#runs;
  }

  evidence(): ServerEvidenceHttp {
    return this.#evidence;
  }
}

function responseStatus(
  status: number,
  attempt: WorkAccessAttemptProjection,
): WorkAccessHttpObservation {
  return status === 202 ? { kind: 'Pending', attempt } : { kind: 'Observed', attempt };
}
