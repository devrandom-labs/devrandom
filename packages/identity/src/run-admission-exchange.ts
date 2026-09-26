import { isDeepStrictEqual } from 'node:util';

import {
  decodeRunAdmissionPayload,
  runAdmissionExchangeRoute,
  runAdmissionPayloadSchema,
  type RunAdmissionPayload,
} from '@devrandom/protocol';
import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import type { AgentAid, ControllerAid, IssuerAid, PersonalAgentAid } from './keri-identifier.js';
import {
  connectSignifyController,
  type ConnectedSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

export const runAdmissionExchangeEvidenceSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('exn'),
    d: saidSchema,
    i: saidSchema,
    rp: saidSchema,
    p: Type.String(),
    dt: Type.String({ minLength: 1 }),
    r: Type.String({ minLength: 1 }),
    q: Type.Object({}, { additionalProperties: true }),
    a: Type.Object(
      { i: saidSchema, ...runAdmissionPayloadSchema.properties },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

export type RunAdmissionExchangeEvidence = Type.Static<typeof runAdmissionExchangeEvidenceSchema>;

export function decodeRunAdmissionExchangeEvidence(
  input: unknown,
): RunAdmissionExchangeEvidence | undefined {
  return Value.Check(runAdmissionExchangeEvidenceSchema, input) ? input : undefined;
}

export type RunAdmissionExchangeRejection =
  | 'AdmissionExchangeMalformed'
  | 'AdmissionExchangeSaidMismatch'
  | 'AdmissionExchangeRouteMismatch'
  | 'AdmissionExchangeRecipientMismatch'
  | 'AdmissionExchangePayloadMismatch';

export type RunAdmissionExchangeVerification =
  | {
      readonly kind: 'Verified';
      readonly sourceAid: string;
      readonly payload: RunAdmissionPayload;
    }
  | { readonly kind: 'Rejected'; readonly reason: RunAdmissionExchangeRejection };

export interface RunAdmissionExchangeExpectation {
  readonly exchangeSaid: string;
  readonly recipientAid: string;
}

export function verifyRunAdmissionExchangeEvidence(
  input: unknown,
  expected: RunAdmissionExchangeExpectation,
): RunAdmissionExchangeVerification {
  const evidence = decodeRunAdmissionExchangeEvidence(input);
  if (evidence === undefined) {
    return { kind: 'Rejected', reason: 'AdmissionExchangeMalformed' };
  }
  if (evidence.d !== expected.exchangeSaid) {
    return { kind: 'Rejected', reason: 'AdmissionExchangeSaidMismatch' };
  }
  if (evidence.r !== runAdmissionExchangeRoute) {
    return { kind: 'Rejected', reason: 'AdmissionExchangeRouteMismatch' };
  }
  const { i: recipientAid, ...untrustedPayload } = evidence.a;
  if (evidence.rp !== expected.recipientAid || recipientAid !== expected.recipientAid) {
    return { kind: 'Rejected', reason: 'AdmissionExchangeRecipientMismatch' };
  }
  const decoded = decodeRunAdmissionPayload(untrustedPayload);
  if (decoded.kind === 'Rejected') {
    return { kind: 'Rejected', reason: 'AdmissionExchangePayloadMismatch' };
  }
  try {
    if (!new Saider({ qb64: evidence.d }).verify(evidence, true, true)) {
      return { kind: 'Rejected', reason: 'AdmissionExchangeSaidMismatch' };
    }
  } catch {
    return { kind: 'Rejected', reason: 'AdmissionExchangeSaidMismatch' };
  }
  return { kind: 'Verified', sourceAid: evidence.i, payload: decoded.payload };
}

export interface StableRunAdmissionExchange {
  readonly senderAlias: string;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  readonly payload: RunAdmissionPayload;
  readonly preparedAt: number;
}

export interface PreparedRunAdmissionExchange {
  readonly exchangeSaid: string;
}

export interface LocalRunAdmissionExchange {
  prepare(input: StableRunAdmissionExchange): Promise<PreparedRunAdmissionExchange>;
  deliver(
    input: StableRunAdmissionExchange & PreparedRunAdmissionExchange,
  ): Promise<PreparedRunAdmissionExchange>;
}

export interface LocalRunAdmissionConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
}

export type ConnectRunAdmissionController = (
  configuration: SignifyControllerConfiguration,
) => Promise<ConnectedSignifyController>;

export async function connectLocalRunAdmissionExchange(
  input: LocalRunAdmissionConnection,
  connectController: ConnectRunAdmissionController = connectSignifyController,
): Promise<LocalRunAdmissionExchange> {
  const connected = await connectController(input);
  if (
    connected.controllerAid !== input.expectedControllerAid ||
    connected.agentAid !== input.expectedAgentAid
  ) {
    throw new IdentityFailure({
      kind: 'controller-state-invalid',
      reason: 'Run signing custody differs from the recovered user controller binding',
    });
  }
  return signifyLocalRunAdmissionExchange(connected.client);
}

export type IssuerRunAdmissionInspection =
  | { readonly kind: 'Pending' }
  | {
      readonly kind: 'Verified';
      readonly sourceAid: string;
      readonly payload: RunAdmissionPayload;
    }
  | { readonly kind: 'Rejected'; readonly reason: RunAdmissionExchangeRejection }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

export interface IssuerRunAdmissionExchange {
  inspect(exchangeSaid: string): Promise<IssuerRunAdmissionInspection>;
}

function protocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'Run admission exchange preparation',
      reason: 'preparation time is invalid',
    });
  }
  return new Date(instant).toISOString().replace('Z', '000+00:00');
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}

function invalidPrepared(reason: string): never {
  throw new IdentityFailure({
    kind: 'keria-response-invalid',
    stage: 'Run admission exchange',
    reason,
  });
}

function exchangeNotFound(cause: unknown, said: string): boolean {
  return cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${said} - 404 `);
}

const exchangeResourceSchema = Type.Object({ exn: Type.Unknown() }, { additionalProperties: true });

async function retrieveExchange(client: SignifyClient, exchangeSaid: string): Promise<unknown> {
  let resource: unknown;
  try {
    resource = await client.exchanges().get(exchangeSaid);
  } catch (cause) {
    if (exchangeNotFound(cause, exchangeSaid)) {
      return undefined;
    }
    throw unavailable('Run admission exchange retrieval', cause);
  }
  if (!Value.Check(exchangeResourceSchema, resource)) {
    return invalidPrepared('retrieved resource is malformed');
  }
  return resource.exn;
}

async function prepareExchange(client: SignifyClient, input: StableRunAdmissionExchange) {
  let prepared;
  try {
    const sender = await client.identifiers().get(input.senderAlias);
    prepared = await client
      .exchanges()
      .createExchangeMessage(
        sender,
        runAdmissionExchangeRoute,
        input.payload,
        {},
        input.recipientAid,
        protocolDatetime(input.preparedAt),
      );
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw unavailable('Run admission exchange preparation', cause);
  }
  const verified = verifyRunAdmissionExchangeEvidence(prepared[0].sad, {
    exchangeSaid: prepared[0].said,
    recipientAid: input.recipientAid,
  });
  if (verified.kind === 'Rejected' || verified.sourceAid !== input.sourceAid) {
    return invalidPrepared('prepared exchange does not match its local authority binding');
  }
  return prepared;
}

function verifyExactExchange(
  evidence: unknown,
  input: StableRunAdmissionExchange & PreparedRunAdmissionExchange,
): PreparedRunAdmissionExchange {
  const verified = verifyRunAdmissionExchangeEvidence(evidence, {
    exchangeSaid: input.exchangeSaid,
    recipientAid: input.recipientAid,
  });
  if (
    verified.kind === 'Rejected' ||
    verified.sourceAid !== input.sourceAid ||
    !isDeepStrictEqual(verified.payload, input.payload)
  ) {
    return invalidPrepared('exchange differs from its stable local inputs');
  }
  return { exchangeSaid: input.exchangeSaid };
}

export function signifyLocalRunAdmissionExchange(client: SignifyClient): LocalRunAdmissionExchange {
  return {
    async prepare(input) {
      const prepared = await prepareExchange(client, input);
      return { exchangeSaid: prepared[0].said };
    },
    async deliver(input) {
      const existing = await retrieveExchange(client, input.exchangeSaid);
      if (existing !== undefined) {
        return verifyExactExchange(existing, input);
      }
      const [exchange, signatures, attachment] = await prepareExchange(client, input);
      if (exchange.said !== input.exchangeSaid) {
        return invalidPrepared('prepared exchange SAID changed before delivery');
      }
      let delivered: unknown;
      try {
        delivered = await client
          .exchanges()
          .sendFromEvents(input.senderAlias, 'run-admission', exchange, signatures, attachment, [
            input.recipientAid,
          ]);
      } catch (cause) {
        const reconciled = await retrieveExchange(client, input.exchangeSaid);
        if (reconciled !== undefined) {
          return verifyExactExchange(reconciled, input);
        }
        throw unavailable('Run admission exchange delivery', cause);
      }
      return verifyExactExchange(delivered, input);
    },
  };
}

export function signifyIssuerRunAdmissionExchange(
  client: SignifyClient,
  recipientAid: IssuerAid,
): IssuerRunAdmissionExchange {
  return {
    async inspect(exchangeSaid) {
      let evidence: unknown;
      try {
        const resource = await client.exchanges().get(exchangeSaid);
        if (!Value.Check(exchangeResourceSchema, resource)) {
          return { kind: 'Rejected', reason: 'AdmissionExchangeMalformed' };
        }
        evidence = resource.exn;
      } catch (cause) {
        return exchangeNotFound(cause, exchangeSaid)
          ? { kind: 'Pending' }
          : { kind: 'Unavailable', dependency: 'Keria' };
      }
      return verifyRunAdmissionExchangeEvidence(evidence, { exchangeSaid, recipientAid });
    },
  };
}
