import {
  admitBaselineHarnessBodySchema,
  baselineHarnessProjectionSchema,
  decodeBaselineHarnessRevision,
  harnessProblemSchema,
  type AdmitBaselineHarnessBody,
  type HarnessProblem,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import type {
  HostedBaselineHarnessAdmission,
  HostedBaselineHarnesses,
} from '../application/baseline-harness-preparation.js';

type HarnessHttpError =
  | { readonly kind: 'GrantInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: HarnessProblem };

class HarnessHttpFailure extends Error {
  readonly detail: HarnessHttpError;

  constructor(detail: HarnessHttpError) {
    super(detail.kind);
    this.name = 'HarnessHttpFailure';
    this.detail = detail;
  }
}

export class ServerHarnessHttp implements HostedBaselineHarnesses {
  readonly #origin: DevrandomServerOrigin;
  readonly #authorization: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) {
      throw new HarnessHttpFailure({ kind: 'GrantInvalid' });
    }
    this.#origin = origin;
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetch;
  }

  async admit(command: AdmitBaselineHarnessBody): Promise<HostedBaselineHarnessAdmission> {
    if (!Value.Check(admitBaselineHarnessBodySchema, command)) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(command);
      if (response.status !== 200 && response.status !== 201) {
        return this.#reject(response);
      }
      if (!Value.Check(baselineHarnessProjectionSchema, response.body)) {
        return { kind: 'ResponseInvalid' };
      }
      const projection = Value.Parse(baselineHarnessProjectionSchema, response.body);
      if (
        decodeBaselineHarnessRevision(projection.revision).kind !== 'Accepted' ||
        projection.commandId !== command.commandId ||
        projection.revision.d !== command.revision.d
      ) {
        return { kind: 'ResponseInvalid' };
      }
      return response.status === 201
        ? { kind: 'Created', projection }
        : { kind: 'Reconciled', projection };
    } catch (cause) {
      return harnessHttpFailure(cause);
    }
  }

  async #request(
    command: AdmitBaselineHarnessBody,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}/api/harness-revisions/${encodeURIComponent(command.revision.d)}`,
        {
          method: 'PUT',
          headers: {
            authorization: this.#authorization,
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
    } catch {
      throw new HarnessHttpFailure({ kind: 'ServerUnavailable' });
    }
    if (response.headers.get('cache-control') !== 'no-store') {
      throw new HarnessHttpFailure({ kind: 'ResponseInvalid' });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HarnessHttpFailure({ kind: 'ResponseInvalid' });
    }
    return { status: response.status, body };
  }

  #reject(response: { readonly status: number; readonly body: unknown }): never {
    if (
      Value.Check(harnessProblemSchema, response.body) &&
      response.body.status === response.status
    ) {
      throw new HarnessHttpFailure({
        kind: 'RequestRejected',
        problem: Value.Parse(harnessProblemSchema, response.body),
      });
    }
    throw new HarnessHttpFailure({ kind: 'ResponseInvalid' });
  }
}

function harnessHttpFailure(cause: unknown): HostedBaselineHarnessAdmission {
  if (!(cause instanceof HarnessHttpFailure)) {
    return { kind: 'ResponseInvalid' };
  }
  switch (cause.detail.kind) {
    case 'GrantInvalid':
      return { kind: 'InputInvalid' };
    case 'ServerUnavailable':
      return { kind: 'ServerUnavailable' };
    case 'ResponseInvalid':
      return { kind: 'ResponseInvalid' };
    case 'RequestRejected':
      return { kind: 'RequestRejected', problem: cause.detail.problem };
  }
}
