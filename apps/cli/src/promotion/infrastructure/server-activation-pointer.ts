import { activeHarnessPointerSchema } from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import type { ActivationPointerReading } from '../application/activation-pointer-reading.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumBodyBytes = 4096;
const timeoutMilliseconds = 10_000;

/** Reads one owner-authorized, committed pointer; pending reservations stay invisible. */
export class ServerActivationPointer implements ActivationPointerReading {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('Activation bearer invalid');
    this.#origin = origin;
    this.#bearer = bearer;
    this.#fetch = fetch;
  }

  async inspect(taskId: string): ReturnType<ActivationPointerReading['inspect']> {
    if (!uuid.test(taskId)) return { kind: 'Unavailable' };
    const timeout = new AbortController();
    const cancel = setTimeout(() => {
      timeout.abort();
    }, timeoutMilliseconds);
    try {
      const response = await this.#fetch(
        `${this.#origin}/api/tasks/${encodeURIComponent(taskId)}/activation`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this.#bearer}`, accept: 'application/json' },
          signal: timeout.signal,
        },
      );
      if (response.status === 403 || response.status === 409) return { kind: 'Missing' };
      if (response.status !== 200) return { kind: 'Unavailable' };
      if (
        !response.headers.get('content-type')?.startsWith('application/json') ||
        response.headers.get('cache-control') !== 'no-store'
      )
        return { kind: 'Unavailable' };
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maximumBodyBytes) return { kind: 'Unavailable' };
      const parsed: unknown = JSON.parse(text);
      return Value.Check(activeHarnessPointerSchema, parsed) && parsed.taskId === taskId
        ? { kind: 'Observed', pointer: parsed }
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      clearTimeout(cancel);
    }
  }
}
