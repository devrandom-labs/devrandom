import {
  decodeHarnessPackage,
  publicationAdmissionSchema,
  publishedHarnessSchema,
  type PublishHarnessCommand,
  type PublicationAdmission,
  type PublishedHarness,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
export class ServerPublicationHttp {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string | undefined;
  readonly #fetch: DevrandomFetch;
  constructor(origin: DevrandomServerOrigin, fetch: DevrandomFetch, bearer?: string) {
    this.#origin = origin;
    this.#fetch = fetch;
    this.#bearer = bearer;
  }
  async publish(command: PublishHarnessCommand): Promise<PublicationAdmission> {
    if (this.#bearer === undefined) return { kind: 'Rejected' };
    try {
      const response = await this.#fetch(
        new URL(`/api/harness-packages/${command.published.package.d}`, this.#origin),
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${this.#bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(10000),
        },
      );
      const value: unknown = await response.json();
      return Value.Check(publicationAdmissionSchema, value) &&
        ((value.kind !== 'Published' && value.kind !== 'AlreadyPublished') ||
          value.packageSaid === command.published.package.d) &&
        ((response.status === 200 && value.kind === 'AlreadyPublished') ||
          (response.status === 201 && value.kind === 'Published') ||
          ['Rejected', 'Conflict', 'Unavailable'].includes(value.kind))
        ? value
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
  async fetch(
    packageSaid: string,
  ): Promise<
    | { readonly kind: 'Fetched'; readonly published: PublishedHarness }
    | { readonly kind: 'Rejected' | 'Unavailable' }
  > {
    if (!/^[A-Z][A-Za-z0-9_-]{43}$/u.test(packageSaid)) return { kind: 'Rejected' };
    try {
      const response = await this.#fetch(
        new URL(`/api/harness-packages/${packageSaid}`, this.#origin),
        { signal: AbortSignal.timeout(10000) },
      );
      if (response.status !== 200)
        return { kind: response.status === 404 ? 'Rejected' : 'Unavailable' };
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 96 * 1024) return { kind: 'Rejected' };
      const value: unknown = JSON.parse(text);
      return Value.Check(publishedHarnessSchema, value) &&
        decodeHarnessPackage(value.package).kind === 'Accepted' &&
        value.package.d === packageSaid
        ? { kind: 'Fetched', published: value }
        : { kind: 'Rejected' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
