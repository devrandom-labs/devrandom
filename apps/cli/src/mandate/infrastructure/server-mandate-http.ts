import {
  mandatePresentationParametersSchema,
  mandatePresentationProblemSchema,
  mandatePresentationProjectionSchema,
  presentMandateBodySchema,
  type MandatePresentationProjection,
  type PresentMandateBody,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import type {
  HostedMandatePresentation,
  HostedMandatePresentations,
} from '../application/hosted-mandate-presentations.js';

type MandatePresentationHttpInvalidity =
  | { readonly kind: 'GrantInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' };

class MandatePresentationHttpFailure extends Error {
  readonly detail: MandatePresentationHttpInvalidity;

  constructor(detail: MandatePresentationHttpInvalidity) {
    super(detail.kind);
    this.name = 'MandatePresentationHttpFailure';
    this.detail = detail;
  }
}

export class ServerMandatePresentationHttp implements HostedMandatePresentations {
  readonly #origin: DevrandomServerOrigin;
  readonly #authorization: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) {
      throw new MandatePresentationHttpFailure({ kind: 'GrantInvalid' });
    }
    this.#origin = origin;
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetch;
  }

  async present(
    credentialSaid: string,
    command: PresentMandateBody,
  ): Promise<HostedMandatePresentation> {
    if (
      !Value.Check(mandatePresentationParametersSchema, { credentialSaid }) ||
      !Value.Check(presentMandateBodySchema, command)
    ) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(credentialSaid, command);
      if (Value.Check(mandatePresentationProblemSchema, response.body)) {
        return response.body.status === response.status
          ? {
              kind: 'RequestRejected',
              problem: Value.Parse(mandatePresentationProblemSchema, response.body),
            }
          : { kind: 'ResponseInvalid' };
      }
      if (!Value.Check(mandatePresentationProjectionSchema, response.body)) {
        return { kind: 'ResponseInvalid' };
      }
      const projection = Value.Parse(mandatePresentationProjectionSchema, response.body);
      if (!samePresentationBinding(projection, credentialSaid, command)) {
        return { kind: 'ResponseInvalid' };
      }
      if (
        response.status === 202 &&
        (projection.kind === 'AwaitingGrant' || projection.kind === 'Admitting')
      ) {
        return { kind: 'Pending', presentation: projection };
      }
      return response.status === 200 && projection.kind === 'Admitted'
        ? { kind: 'Admitted', presentation: projection }
        : { kind: 'ResponseInvalid' };
    } catch (cause) {
      return cause instanceof MandatePresentationHttpFailure &&
        cause.detail.kind === 'ServerUnavailable'
        ? { kind: 'ServerUnavailable' }
        : { kind: 'ResponseInvalid' };
    }
  }

  async #request(
    credentialSaid: string,
    command: PresentMandateBody,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}/api/mandate-presentations/${encodeURIComponent(credentialSaid)}`,
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
      throw new MandatePresentationHttpFailure({ kind: 'ServerUnavailable' });
    }
    if (response.headers.get('cache-control') !== 'no-store') {
      throw new MandatePresentationHttpFailure({ kind: 'ResponseInvalid' });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MandatePresentationHttpFailure({ kind: 'ResponseInvalid' });
    }
    return { status: response.status, body };
  }
}

function samePresentationBinding(
  projection: MandatePresentationProjection,
  credentialSaid: string,
  command: PresentMandateBody,
): boolean {
  return (
    projection.credentialSaid === credentialSaid &&
    projection.mandateKind === command.mandateKind &&
    projection.grantSaid === command.grantSaid
  );
}
