import { issuerHealthSchema, type IssuerHealth } from '@devrandom/protocol';
import Value from 'typebox/value';

export class IssuerHealthHttpFailure extends Error {
  constructor(cause?: unknown) {
    super('issuer health is unavailable or invalid', cause === undefined ? undefined : { cause });
    this.name = 'IssuerHealthHttpFailure';
  }
}

export class IssuerHealthHttp {
  readonly #issuerUrl: string;

  constructor(issuerUrl: string) {
    this.#issuerUrl = issuerUrl;
  }

  async observe(): Promise<IssuerHealth> {
    let response: Response;
    try {
      response = await fetch(`${this.#issuerUrl}/health`);
    } catch (cause) {
      throw new IssuerHealthHttpFailure(cause);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new IssuerHealthHttpFailure(cause);
    }
    if (response.status !== 200 || !Value.Check(issuerHealthSchema, body)) {
      throw new IssuerHealthHttpFailure();
    }
    return Value.Parse(issuerHealthSchema, body);
  }
}
