import { incept, MtrDex, Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  keyEventSaid,
  provisionNamedKeriIdentifier,
  userAid,
  witnessAid,
  type KeyEventSaid,
  type UserAid,
  type WitnessAid,
} from './keri-identifier.js';
import { completeSignifyOperation } from './signify-operation.js';

export interface WitnessedUserPolicy {
  readonly kind: 'witnessed';
  readonly witnessAids: readonly WitnessAid[];
  readonly threshold: number;
}

export interface WitnessedUserIdentifier {
  readonly alias: string;
  readonly aid: UserAid;
  readonly kelSequence: number;
  readonly currentEventSaid: KeyEventSaid;
  readonly witnessPolicy: WitnessedUserPolicy;
  readonly receiptIndexes: readonly number[];
}

const identifierSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    prefix: Type.String({ minLength: 1 }),
    state: Type.Object(
      {
        i: Type.String({ minLength: 1 }),
        s: Type.String({ pattern: '^[0-9a-f]+$' }),
        d: Type.String({ minLength: 1 }),
        bt: Type.String({ pattern: '^[0-9a-f]+$' }),
        b: Type.Array(Type.String({ minLength: 1 })),
      },
      { additionalProperties: true },
    ),
    windexes: Type.Array(Type.Union([Type.Integer({ minimum: 0 }), Type.String()])),
  },
  { additionalProperties: true },
);

const keriThresholdSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
]);

const inceptionKeyEventSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('icp'),
    d: Type.String({ minLength: 1 }),
    i: Type.String({ minLength: 1 }),
    s: Type.Literal('0'),
    kt: keriThresholdSchema,
    k: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    nt: keriThresholdSchema,
    n: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    bt: Type.String({ pattern: '^[0-9a-f]+$' }),
    b: Type.Array(Type.String({ minLength: 1 })),
    c: Type.Tuple([]),
    a: Type.Tuple([]),
  },
  { additionalProperties: false },
);

const rotationKeyEventSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('rot'),
    d: Type.String({ minLength: 1 }),
    i: Type.String({ minLength: 1 }),
    s: Type.String({ pattern: '^[1-9a-f][0-9a-f]*$' }),
    p: Type.String({ minLength: 1 }),
    kt: keriThresholdSchema,
    k: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    nt: keriThresholdSchema,
    n: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    bt: Type.Union([Type.String({ pattern: '^[0-9a-f]+$' }), Type.Integer({ minimum: 0 })]),
    br: Type.Tuple([]),
    ba: Type.Tuple([]),
    a: Type.Tuple([]),
  },
  { additionalProperties: false },
);

const keyEventSchema = Type.Union([inceptionKeyEventSchema, rotationKeyEventSchema]);

const keyEventsSchema = Type.Array(
  Type.Object({ ked: keyEventSchema }, { additionalProperties: true }),
);

const userEvidenceSchema = Type.Object(
  { identifier: identifierSchema, keyEvents: keyEventsSchema },
  { additionalProperties: false },
);

function invalidUserIdentifier(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'user-identifier-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function receiptIndex(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalidUserIdentifier('witness receipt index is invalid');
  }
  return parsed;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalKeyEvent(event: Type.Static<typeof keyEventSchema>) {
  switch (event.t) {
    case 'icp':
      return {
        v: event.v,
        t: event.t,
        d: event.d,
        i: event.i,
        s: event.s,
        kt: event.kt,
        k: event.k,
        nt: event.nt,
        n: event.n,
        bt: event.bt,
        b: event.b,
        c: event.c,
        a: event.a,
      };
    case 'rot':
      return {
        v: event.v,
        t: event.t,
        d: event.d,
        i: event.i,
        s: event.s,
        p: event.p,
        kt: event.kt,
        k: event.k,
        nt: event.nt,
        n: event.n,
        bt: event.bt,
        br: event.br,
        ba: event.ba,
        a: event.a,
      };
  }
}

function inceptionIsBound(event: Type.Static<typeof inceptionKeyEventSchema>): boolean {
  const reconstructed = incept({
    keys: [...event.k],
    isith: event.kt,
    ndigs: [...event.n],
    nsith: event.nt,
    toad: event.bt,
    wits: [...event.b],
    cnfg: [],
    data: [],
    code: MtrDex.Blake3_256,
  }).sad;
  return reconstructed.d === event.d && reconstructed.i === event.i && event.d === event.i;
}

function eventSequence(event: Type.Static<typeof keyEventSchema>): number {
  const sequence = Number.parseInt(event.s, 16);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    invalidUserIdentifier('KEL event sequence is invalid');
  }
  return sequence;
}

function eventWitnessThreshold(event: Type.Static<typeof keyEventSchema>): number {
  const threshold = typeof event.bt === 'number' ? event.bt : Number.parseInt(event.bt, 16);
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    invalidUserIdentifier('KEL event witness threshold is invalid');
  }
  return threshold;
}

function verifyKeyEventChain(
  records: Type.Static<typeof keyEventsSchema>,
  aid: UserAid,
  currentSequence: number,
  currentEventSaid: string,
  expectedPolicy: WitnessedUserPolicy,
): void {
  const eventsBySequence = new Map<number, Type.Static<typeof keyEventSchema>>();
  for (const record of records) {
    const sequence = eventSequence(record.ked);
    if (record.ked.i !== aid || sequence > currentSequence || eventsBySequence.has(sequence)) {
      invalidUserIdentifier('KEL is not a continuous inception-to-current KEL');
    }
    eventsBySequence.set(sequence, record.ked);
  }
  if (eventsBySequence.size !== currentSequence + 1) {
    invalidUserIdentifier('KEL is not a continuous inception-to-current KEL');
  }

  let priorEventSaid: string | undefined;
  for (let sequence = 0; sequence <= currentSequence; sequence += 1) {
    const event = eventsBySequence.get(sequence);
    if (
      event === undefined ||
      (sequence === 0 && event.t !== 'icp') ||
      (sequence > 0 && event.t !== 'rot')
    ) {
      invalidUserIdentifier('KEL is not a continuous inception-to-current KEL');
    }
    try {
      const canonical = canonicalKeyEvent(event);
      const isBound =
        canonical.t === 'icp'
          ? inceptionIsBound(canonical)
          : new Saider({ qb64: canonical.d }).verify(canonical, true, true);
      if (!isBound) {
        invalidUserIdentifier('KEL event is not bound by its SAID');
      }
    } catch (cause) {
      if (cause instanceof IdentityFailure) {
        throw cause;
      }
      invalidUserIdentifier('KEL event has an invalid SAID', cause);
    }
    if (eventWitnessThreshold(event) !== expectedPolicy.threshold) {
      invalidUserIdentifier('KEL witness threshold does not match the configured policy');
    }
    if (event.t === 'icp') {
      if (!sameStrings(event.b, expectedPolicy.witnessAids)) {
        invalidUserIdentifier('KEL inception witnesses do not match the configured policy');
      }
    } else if (priorEventSaid === undefined || event.p !== priorEventSaid) {
      invalidUserIdentifier('KEL rotation does not bind its exact predecessor event');
    }
    priorEventSaid = event.d;
  }
  if (priorEventSaid !== currentEventSaid) {
    invalidUserIdentifier('current key event does not terminate the verified KEL');
  }
}

export function verifyWitnessedUserEvidence(
  evidence: unknown,
  alias: string,
  expectedPolicy: WitnessedUserPolicy,
): WitnessedUserIdentifier {
  if (!Value.Check(userEvidenceSchema, evidence)) {
    invalidUserIdentifier('user identifier or KEL evidence is malformed');
  }
  if (evidence.identifier.name !== alias) {
    invalidUserIdentifier('managed alias does not match the local profile');
  }
  const aid = userAid(evidence.identifier.prefix);
  if (evidence.identifier.state.i !== aid) {
    invalidUserIdentifier('managed state belongs to another user AID');
  }
  if (!sameStrings(evidence.identifier.state.b, expectedPolicy.witnessAids)) {
    invalidUserIdentifier('witness AIDs do not match the configured policy');
  }
  if (Number.parseInt(evidence.identifier.state.bt, 16) !== expectedPolicy.threshold) {
    invalidUserIdentifier('witness threshold does not match the configured policy');
  }

  const indexes = evidence.identifier.windexes.map(receiptIndex);
  const uniqueIndexes = new Set(indexes);
  if (
    uniqueIndexes.size !== indexes.length ||
    indexes.some((index) => index >= expectedPolicy.witnessAids.length) ||
    indexes.length < expectedPolicy.threshold
  ) {
    invalidUserIdentifier('witness receipt threshold is not satisfied');
  }

  const sequence = Number.parseInt(evidence.identifier.state.s, 16);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    invalidUserIdentifier('current KEL sequence is invalid');
  }
  const current = evidence.keyEvents.find(
    (record) =>
      record.ked.i === aid &&
      Number.parseInt(record.ked.s, 16) === sequence &&
      record.ked.d === evidence.identifier.state.d,
  );
  if (current === undefined) {
    invalidUserIdentifier('current key event is absent from the KEL');
  }
  verifyKeyEventChain(
    evidence.keyEvents,
    aid,
    sequence,
    evidence.identifier.state.d,
    expectedPolicy,
  );

  return {
    alias,
    aid,
    kelSequence: sequence,
    currentEventSaid: keyEventSaid(current.ked.d),
    witnessPolicy: {
      kind: 'witnessed',
      witnessAids: expectedPolicy.witnessAids.map(witnessAid),
      threshold: expectedPolicy.threshold,
    },
    receiptIndexes: [...indexes],
  };
}

export async function verifyWitnessedUserIdentifier(
  client: SignifyClient,
  alias: string,
  policy: WitnessedUserPolicy,
): Promise<WitnessedUserIdentifier> {
  try {
    const identifier: unknown = await client.identifiers().get(alias);
    if (!Value.Check(identifierSchema, identifier)) {
      invalidUserIdentifier('managed user identifier response is malformed');
    }
    const keyEvents: unknown = await client.keyEvents().get(identifier.prefix);
    return verifyWitnessedUserEvidence({ identifier, keyEvents }, alias, policy);
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'witnessed user identifier verification',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
}

export async function provisionWitnessedUserIdentifier(
  client: SignifyClient,
  alias: string,
  policy: WitnessedUserPolicy,
  operationTimeoutMs: number,
): Promise<WitnessedUserIdentifier> {
  await provisionNamedKeriIdentifier(client, alias, policy, operationTimeoutMs);
  return verifyWitnessedUserIdentifier(client, alias, policy);
}

export async function rotateWitnessedUserIdentifier(
  client: SignifyClient,
  alias: string,
  policy: WitnessedUserPolicy,
  operationTimeoutMs: number,
): Promise<WitnessedUserIdentifier> {
  const before = await verifyWitnessedUserIdentifier(client, alias, policy);
  let rotation;
  try {
    rotation = await client.identifiers().rotate(alias);
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'user AID rotation',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  if (rotation.sigs.length === 0 || rotation.serder.sad.t !== 'rot') {
    invalidUserIdentifier('rotation did not contain an edge-signed rotation event');
  }
  await completeSignifyOperation(
    client,
    await rotation.op(),
    'user AID rotation',
    operationTimeoutMs,
  );
  const after = await verifyWitnessedUserIdentifier(client, alias, policy);
  if (after.aid !== before.aid) {
    invalidUserIdentifier('rotation replaced the user AID');
  }
  if (after.kelSequence !== before.kelSequence + 1) {
    invalidUserIdentifier('rotation did not increment the KEL sequence exactly once');
  }
  if (after.currentEventSaid !== rotation.serder.said) {
    invalidUserIdentifier('current KEL event does not match the submitted rotation event');
  }
  return after;
}
