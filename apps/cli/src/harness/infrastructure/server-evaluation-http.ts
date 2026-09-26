import {
  decodeEvaluationExecutionProfile,
  decodeEvaluationSourceInventory,
  evaluationAdmissionCommandSchema,
  evaluationAdmissionReceiptSchema,
  evaluationPreparationCommandSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

export type HostedEvaluationPreparation =
  | { readonly kind: 'Prepared' | 'AlreadyPrepared' }
  | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' };

export type HostedEvaluationAdmission =
  | {
      readonly kind: 'Admitted';
      readonly evaluationId: string;
      readonly version: number;
      readonly lease: {
        readonly evaluationId: string;
        readonly leaseId: string;
        readonly version: number;
        readonly serverTime: string;
        readonly expiresAt: string;
      };
      readonly evidenceStreamId: string;
      readonly reservationSaid: string;
    }
  | {
      readonly kind: 'Blocked';
      readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
    }
  | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' };

const gates = ['Profile', 'Source', 'Authority', 'Budget', 'Qualification', 'Evidence'] as const;
const requestTimeoutMilliseconds = 10_000;
const problemSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    correlationId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    title: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

interface HttpReading {
  readonly status: number;
  readonly body: unknown;
}

function validProblem(
  response: HttpReading,
): response is HttpReading & { readonly body: Type.Static<typeof problemSchema> } {
  return Value.Check(problemSchema, response.body) && response.body.status === response.status;
}

/** Typed Work Access client for the hosted E3 preparation and reservation boundary. */
export class ServerEvaluationHttp {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('Evaluation bearer invalid');
    this.#origin = origin;
    this.#bearer = bearer;
    this.#fetch = fetch;
  }

  async prepare(
    command: Type.Static<typeof evaluationPreparationCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationPreparation> {
    if (
      !Value.Check(evaluationPreparationCommandSchema, command) ||
      decodeEvaluationExecutionProfile(command.executionProfile).kind !== 'Accepted' ||
      decodeEvaluationSourceInventory(command.sourceInventory).kind !== 'Accepted'
    )
      return { kind: 'Rejected' };
    const response = await this.#post('/api/evaluations/prepare', command, signal);
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200 || response.status === 201) {
      const expected = response.status === 200 ? 'AlreadyPrepared' : 'Prepared';
      return typeof response.body === 'object' &&
        response.body !== null &&
        'kind' in response.body &&
        response.body.kind === expected &&
        Object.keys(response.body).length === 1
        ? { kind: expected }
        : { kind: 'ResponseInvalid' };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 403) return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  async admit(
    command: Type.Static<typeof evaluationAdmissionCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationAdmission> {
    if (!Value.Check(evaluationAdmissionCommandSchema, command)) return { kind: 'Rejected' };
    const response = await this.#post('/api/evaluations', command, signal);
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 201) {
      if (
        !Value.Check(evaluationAdmissionReceiptSchema, response.body) ||
        response.body.kind !== 'Admitted' ||
        response.body.lease.evaluationId !== response.body.evaluationId ||
        response.body.lease.version !== response.body.version ||
        !Number.isFinite(Date.parse(response.body.lease.serverTime)) ||
        !Number.isFinite(Date.parse(response.body.lease.expiresAt)) ||
        Date.parse(response.body.lease.expiresAt) <= Date.parse(response.body.lease.serverTime)
      )
        return { kind: 'ResponseInvalid' };
      return response.body;
    }
    if (response.status === 422) {
      if (!validProblem(response)) return { kind: 'ResponseInvalid' };
      const code = response.body.code;
      const gate = gates.find((candidate) => code === `EvaluationBlocked${candidate}`);
      return gate === undefined ? { kind: 'ResponseInvalid' } : { kind: 'Blocked', gate };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 403) return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  async #post(
    path: string,
    command: object,
    signal?: AbortSignal,
  ): Promise<HttpReading | undefined> {
    try {
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(requestTimeoutMilliseconds)
          : AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(command),
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      if (response.headers.get('cache-control') !== 'no-store') {
        return { status: -1, body: undefined };
      }
      try {
        return { status: response.status, body: (await response.json()) as unknown };
      } catch {
        return { status: -1, body: undefined };
      }
    } catch {
      return undefined;
    }
  }
}
