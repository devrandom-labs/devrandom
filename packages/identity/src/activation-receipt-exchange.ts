import { isDeepStrictEqual } from 'node:util';

import {
  activationReceiptExchangeRoute,
  activationReceiptPayloadSchema,
  type ActivationReceiptPayload,
} from '@devrandom/protocol';
import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import type { IssuerAid, PersonalAgentAid } from './keri-identifier.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const receiptExchange = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('exn'),
    d: said,
    i: said,
    rp: said,
    p: Type.String(),
    dt: Type.String({ minLength: 1 }),
    r: Type.String({ minLength: 1 }),
    q: Type.Object({}, { additionalProperties: true }),
    a: Type.Object(
      { i: said, ...activationReceiptPayloadSchema.properties },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);
const exchangeResource = Type.Object({ exn: Type.Unknown() }, { additionalProperties: true });

export interface ActivationReceiptExchangeExpectation {
  readonly exchangeSaid: string;
  readonly sourceAid: IssuerAid;
  readonly recipientAid: PersonalAgentAid;
  readonly payload: ActivationReceiptPayload;
}

export type ActivationReceiptExchangeInspection =
  | {
      readonly kind: 'Verified';
      readonly exchangeSaid: string;
      readonly payload: ActivationReceiptPayload;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'Malformed' | 'Binding' | 'Said' }
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

export interface StableActivationReceiptExchange {
  readonly senderAlias: string;
  readonly sourceAid: IssuerAid;
  readonly recipientAid: PersonalAgentAid;
  readonly payload: ActivationReceiptPayload;
  readonly preparedAt: number;
}

export interface IssuerActivationReceiptExchange {
  sign(input: StableActivationReceiptExchange): Promise<ActivationReceiptExchangeInspection>;
  inspect(
    expected: ActivationReceiptExchangeExpectation,
  ): Promise<ActivationReceiptExchangeInspection>;
}

/** Exact binding only; Verified requires an issuer KERIA read of the native signed EXN. */
export function matchActivationReceiptExchange(
  untrusted: unknown,
  expected: ActivationReceiptExchangeExpectation,
): ActivationReceiptExchangeInspection {
  if (!Value.Check(receiptExchange, untrusted)) return { kind: 'Rejected', reason: 'Malformed' };
  if (untrusted.d !== expected.exchangeSaid) return { kind: 'Rejected', reason: 'Said' };
  const { i: recipientAid, ...payload } = untrusted.a;
  if (
    untrusted.r !== activationReceiptExchangeRoute ||
    untrusted.i !== expected.sourceAid ||
    untrusted.rp !== expected.recipientAid ||
    recipientAid !== expected.recipientAid ||
    !isDeepStrictEqual(payload, expected.payload)
  )
    return { kind: 'Rejected', reason: 'Binding' };
  try {
    return new Saider({ qb64: untrusted.d }).verify(untrusted, true, true)
      ? { kind: 'Verified', exchangeSaid: untrusted.d, payload: expected.payload }
      : { kind: 'Rejected', reason: 'Said' };
  } catch {
    return { kind: 'Rejected', reason: 'Said' };
  }
}

function notFound(cause: unknown, exchangeSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${exchangeSaid} - 404 `)
  );
}

async function inspect(
  client: SignifyClient,
  expected: ActivationReceiptExchangeExpectation,
): Promise<ActivationReceiptExchangeInspection> {
  try {
    const retrieved: unknown = await client.exchanges().get(expected.exchangeSaid);
    return Value.Check(exchangeResource, retrieved)
      ? matchActivationReceiptExchange(retrieved.exn, expected)
      : { kind: 'Rejected', reason: 'Malformed' };
  } catch (cause) {
    return notFound(cause, expected.exchangeSaid)
      ? { kind: 'Pending' }
      : { kind: 'Unavailable', dependency: 'Keria' };
  }
}

function protocolDatetime(instant: number): string | undefined {
  return Number.isSafeInteger(instant) && instant >= 0
    ? new Date(instant).toISOString().replace('Z', '000+00:00')
    : undefined;
}

export function signifyIssuerActivationReceiptExchange(
  client: SignifyClient,
): IssuerActivationReceiptExchange {
  return {
    inspect: (expected) => inspect(client, expected),
    async sign(input) {
      const datetime = protocolDatetime(input.preparedAt);
      if (datetime === undefined || !Value.Check(activationReceiptPayloadSchema, input.payload))
        return { kind: 'Rejected', reason: 'Binding' };
      try {
        const sender = await client.identifiers().get(input.senderAlias);
        if (sender.prefix !== input.sourceAid) return { kind: 'Rejected', reason: 'Binding' };
        const [message, signatures, attachment] = await client
          .exchanges()
          .createExchangeMessage(
            sender,
            activationReceiptExchangeRoute,
            input.payload,
            {},
            input.recipientAid,
            datetime,
          );
        const expected = {
          exchangeSaid: message.said,
          sourceAid: input.sourceAid,
          recipientAid: input.recipientAid,
          payload: input.payload,
        };
        if (matchActivationReceiptExchange(message.sad, expected).kind !== 'Verified')
          return { kind: 'Rejected', reason: 'Binding' };
        const prior = await inspect(client, expected);
        if (prior.kind !== 'Pending') return prior;
        try {
          await client
            .exchanges()
            .sendFromEvents(
              input.senderAlias,
              'activation-receipt',
              message,
              signatures,
              attachment,
              [input.recipientAid],
            );
        } catch {
          // A lost send response is reconciled only through issuer KERIA custody.
        }
        return await inspect(client, expected);
      } catch {
        return { kind: 'Unavailable', dependency: 'Keria' };
      }
    },
  };
}
