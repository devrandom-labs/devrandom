import { isDeepStrictEqual } from 'node:util';

import type {
  IssuerActivationReceiptExchange,
  IssuerAid,
  PersonalAgentAid,
} from '@devrandom/identity';
import {
  activationCommitReceiptSchema,
  activationReceiptPayload,
  decodeActivationCommitCommand,
  type ActivationCommitCommand,
  type ActivationCommitReceipt,
} from '@devrandom/protocol';
import type { HostedActivationCommit } from '@devrandom/runtime';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

const timeoutMilliseconds = 10_000;

type Committed = Extract<ActivationCommitReceipt, { kind: 'Committed' | 'AlreadyCommitted' }>;

/** A response is committed only after issuer KERIA inspection and a durable exact retry. */
export class ServerActivationHttp implements HostedActivationCommit {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #fetch: DevrandomFetch;
  readonly #receipts: Pick<IssuerActivationReceiptExchange, 'inspect'>;
  readonly #issuerAid: IssuerAid;
  readonly #personalAgentAid: PersonalAgentAid;

  constructor(
    origin: DevrandomServerOrigin,
    bearer: string,
    fetch: DevrandomFetch,
    receipts: Pick<IssuerActivationReceiptExchange, 'inspect'>,
    issuerAid: IssuerAid,
    personalAgentAid: PersonalAgentAid,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('Activation bearer invalid');
    this.#origin = origin;
    this.#bearer = bearer;
    this.#fetch = fetch;
    this.#receipts = receipts;
    this.#issuerAid = issuerAid;
    this.#personalAgentAid = personalAgentAid;
  }

  async commit(command: ActivationCommitCommand): Promise<ActivationCommitReceipt> {
    if (
      decodeActivationCommitCommand(command).kind !== 'Accepted' ||
      command.expectedPointerVersion >= Number.MAX_SAFE_INTEGER
    )
      return { kind: 'Unavailable' };
    const first = await this.#put(command);
    if (first.kind !== 'Committed' && first.kind !== 'AlreadyCommitted') return first;
    if (!this.#matchesCommand(first, command)) return { kind: 'Unavailable' };
    const expected = {
      exchangeSaid: first.decisionReceiptSaid,
      sourceAid: this.#issuerAid,
      recipientAid: this.#personalAgentAid,
      payload: activationReceiptPayload(command),
    };
    let signed: Awaited<ReturnType<IssuerActivationReceiptExchange['inspect']>>;
    try {
      signed = await this.#receipts.inspect(expected);
    } catch {
      return { kind: 'Unavailable' };
    }
    if (
      signed.kind !== 'Verified' ||
      signed.exchangeSaid !== expected.exchangeSaid ||
      !isDeepStrictEqual(signed.payload, expected.payload)
    )
      return { kind: 'Unavailable' };
    if (first.kind === 'AlreadyCommitted') return first;
    const reread = await this.#put(command);
    return reread.kind === 'AlreadyCommitted' &&
      reread.decisionReceiptSaid === first.decisionReceiptSaid &&
      this.#matchesCommand(reread, command)
      ? first
      : { kind: 'Unavailable' };
  }

  #matchesCommand(receipt: Committed, command: ActivationCommitCommand): boolean {
    const payload = activationReceiptPayload(command);
    return (
      receipt.activeRevisionSaid === payload.activeRevisionSaid &&
      receipt.pointerVersion === payload.pointerVersion &&
      receipt.disposition === payload.disposition
    );
  }

  async #put(command: ActivationCommitCommand): Promise<ActivationCommitReceipt> {
    const timeout = new AbortController();
    const cancel = setTimeout(() => {
      timeout.abort();
    }, timeoutMilliseconds);
    try {
      const reply = await this.#fetch(
        `${this.#origin}/api/tasks/${encodeURIComponent(command.taskId)}/activation`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${this.#bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
          signal: timeout.signal,
        },
      );
      if (reply.status === 409) return { kind: 'Conflict' };
      if (
        (reply.status !== 200 && reply.status !== 201) ||
        reply.headers.get('cache-control') !== 'no-store'
      )
        return { kind: 'Unavailable' };
      const body: unknown = await reply.json();
      if (!Value.Check(activationCommitReceiptSchema, body)) return { kind: 'Unavailable' };
      if (
        (reply.status === 201 && body.kind !== 'Committed') ||
        (reply.status === 200 && body.kind !== 'AlreadyCommitted')
      )
        return { kind: 'Unavailable' };
      return body;
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      clearTimeout(cancel);
    }
  }
}
