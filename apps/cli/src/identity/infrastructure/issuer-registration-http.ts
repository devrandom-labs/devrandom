import {
  cliRegistrationProjectionSchema,
  createRegistrationResponseSchema,
  registrationErrorSchema,
  type CliRegistrationProjection,
  type CreateRegistrationRequest,
  type CreateRegistrationResponse,
} from '@devrandom/protocol';
import type Type from 'typebox';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';

export type IssuerRegistrationHttpError =
  | { readonly kind: 'issuer-unavailable' }
  | { readonly kind: 'issuer-response-invalid' }
  | {
      readonly kind: 'registration-rejected';
      readonly status: number;
      readonly error: Type.Static<typeof registrationErrorSchema>['error'];
    };

export class IssuerRegistrationHttpFailure extends Error {
  readonly detail: IssuerRegistrationHttpError;

  constructor(detail: IssuerRegistrationHttpError, cause?: unknown) {
    super(detail.kind, cause === undefined ? undefined : { cause });
    this.name = 'IssuerRegistrationHttpFailure';
    this.detail = detail;
  }
}

export class IssuerRegistrationHttp {
  readonly #issuerUrl: string;

  constructor(issuerUrl: string) {
    this.#issuerUrl = issuerUrl;
  }

  async create(
    request: CreateRegistrationRequest,
    creationKey: string,
  ): Promise<CreateRegistrationResponse> {
    return this.#request(
      '/registrations',
      {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json', 'idempotency-key': creationKey },
      },
      [200, 201],
      createRegistrationResponseSchema,
    );
  }

  async submitAidProof(
    registrationId: string,
    capability: string,
    responseSaid: string,
  ): Promise<CliRegistrationProjection> {
    return this.#request(
      `/registrations/${encodeURIComponent(registrationId)}/aid-proof`,
      {
        method: 'POST',
        body: JSON.stringify({ responseSaid }),
        headers: {
          'content-type': 'application/json',
          'x-devrandom-registration-capability': capability,
        },
      },
      [200, 202],
      cliRegistrationProjectionSchema,
    );
  }

  async retrieve(registrationId: string, capability: string): Promise<CliRegistrationProjection> {
    return this.#request(
      `/registrations/${encodeURIComponent(registrationId)}`,
      { headers: { 'x-devrandom-registration-capability': capability } },
      [200],
      cliRegistrationProjectionSchema,
    );
  }

  async #request<Schema extends TSchema>(
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
    schema: Schema,
  ): Promise<Type.Static<Schema>> {
    let response: Response;
    try {
      response = await fetch(`${this.#issuerUrl}${path}`, init);
    } catch (cause) {
      throw new IssuerRegistrationHttpFailure({ kind: 'issuer-unavailable' }, cause);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new IssuerRegistrationHttpFailure({ kind: 'issuer-response-invalid' }, cause);
    }
    if (!expectedStatuses.includes(response.status)) {
      if (Value.Check(registrationErrorSchema, body)) {
        throw new IssuerRegistrationHttpFailure({
          kind: 'registration-rejected',
          status: response.status,
          error: body.error,
        });
      }
      throw new IssuerRegistrationHttpFailure({ kind: 'issuer-response-invalid' });
    }
    if (response.headers.get('cache-control') !== 'no-store' || !Value.Check(schema, body)) {
      throw new IssuerRegistrationHttpFailure({ kind: 'issuer-response-invalid' });
    }
    return Value.Parse(schema, body);
  }
}
