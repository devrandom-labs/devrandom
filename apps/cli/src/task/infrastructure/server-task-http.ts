import {
  createTaskBodySchema,
  decodeTaskProjection,
  taskLabelParametersSchema,
  taskListProjectionSchema,
  taskListQuerySchema,
  taskProblemSchema,
  type CreateTaskBody,
  type TaskListQuery,
  type TaskProblem,
  type TaskProjection,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import type {
  HostedTaskCreation,
  HostedTaskFailure,
  HostedTaskInspection,
  HostedTaskListing,
  HostedTasks,
} from '../application/user-tasks.js';

type TaskHttpError =
  | { readonly kind: 'GrantInvalid' }
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: TaskProblem };

class TaskHttpFailure extends Error {
  readonly detail: TaskHttpError;

  constructor(detail: TaskHttpError) {
    super(detail.kind);
    this.name = 'TaskHttpFailure';
    this.detail = detail;
  }
}

export class ServerTaskHttp implements HostedTasks {
  readonly #origin: DevrandomServerOrigin;
  readonly #authorization: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) {
      throw new TaskHttpFailure({ kind: 'GrantInvalid' });
    }
    this.#origin = origin;
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetch;
  }

  async create(command: CreateTaskBody): Promise<HostedTaskCreation> {
    if (!Value.Check(createTaskBodySchema, command)) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request('/api/tasks', {
        method: 'POST',
        headers: this.#headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(command),
      });
      const task = this.#taskProjection(response);
      if (response.status === 201) {
        return { kind: 'Created', task };
      }
      if (response.status === 200) {
        return { kind: 'Reconciled', task };
      }
      return this.#reject(response);
    } catch (cause) {
      return taskHttpFailure(cause);
    }
  }

  async list(query: TaskListQuery): Promise<HostedTaskListing> {
    if (!Value.Check(taskListQuerySchema, query)) {
      return { kind: 'InputInvalid' };
    }
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) {
      parameters.set('limit', String(query.limit));
    }
    if (query.cursor !== undefined) {
      parameters.set('cursor', query.cursor);
    }
    const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
    try {
      const response = await this.#request(`/api/tasks${suffix}`, {
        headers: this.#headers(),
      });
      if (response.status !== 200 || !Value.Check(taskListProjectionSchema, response.body)) {
        return this.#reject(response);
      }
      return {
        kind: 'Listed',
        page: Value.Parse(taskListProjectionSchema, response.body),
      };
    } catch (cause) {
      return taskHttpFailure(cause);
    }
  }

  async inspect(label: string): Promise<HostedTaskInspection> {
    if (!Value.Check(taskLabelParametersSchema, { label })) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(`/api/tasks/by-label/${encodeURIComponent(label)}`, {
        headers: this.#headers(),
      });
      if (response.status !== 200) {
        return this.#reject(response);
      }
      return { kind: 'Inspected', task: this.#taskProjection(response) };
    } catch (cause) {
      return taskHttpFailure(cause);
    }
  }

  #headers(additional?: Readonly<{ 'content-type': 'application/json' }>): HeadersInit {
    return additional === undefined
      ? { authorization: this.#authorization }
      : { ...additional, authorization: this.#authorization };
  }

  async #request(
    path: string,
    init: RequestInit,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, init);
    } catch {
      throw new TaskHttpFailure({ kind: 'ServerUnavailable' });
    }
    if (response.headers.get('cache-control') !== 'no-store') {
      throw new TaskHttpFailure({ kind: 'ResponseInvalid' });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TaskHttpFailure({ kind: 'ResponseInvalid' });
    }
    return { status: response.status, body };
  }

  #taskProjection(response: { readonly status: number; readonly body: unknown }): TaskProjection {
    const decoded = decodeTaskProjection(response.body);
    if (decoded.kind === 'Rejected') {
      return this.#reject(response);
    }
    return decoded.projection;
  }

  #reject(response: { readonly status: number; readonly body: unknown }): never {
    if (Value.Check(taskProblemSchema, response.body) && response.body.status === response.status) {
      throw new TaskHttpFailure({
        kind: 'RequestRejected',
        problem: Value.Parse(taskProblemSchema, response.body),
      });
    }
    throw new TaskHttpFailure({ kind: 'ResponseInvalid' });
  }
}

function taskHttpFailure(cause: unknown): HostedTaskFailure {
  if (!(cause instanceof TaskHttpFailure)) {
    return { kind: 'ResponseInvalid' };
  }
  switch (cause.detail.kind) {
    case 'GrantInvalid':
    case 'InputInvalid':
      return { kind: 'InputInvalid' };
    case 'ServerUnavailable':
      return { kind: 'ServerUnavailable' };
    case 'ResponseInvalid':
      return { kind: 'ResponseInvalid' };
    case 'RequestRejected':
      return { kind: 'RequestRejected', problem: cause.detail.problem };
  }
}
