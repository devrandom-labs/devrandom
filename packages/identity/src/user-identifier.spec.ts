import { incept, MtrDex, Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { userAid, witnessAid } from './keri-identifier.js';
import { verifyWitnessedUserEvidence } from './user-identifier.js';

const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const witness = witnessAid('BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha');

function rotationEvent(eventAid: string = user, priorEventSaid: string = user) {
  const event = {
    v: 'KERI10JSON000000_',
    t: 'rot',
    d: '',
    i: eventAid,
    s: '1',
    p: priorEventSaid,
    kt: '1',
    k: ['DHKxy2g3cPs6knNLCxv6nx39OqNFcaU2DycTt4gcse2a'],
    nt: '1',
    n: ['EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao'],
    bt: 1,
    br: [],
    ba: [],
    a: [],
  };
  const untrusted: unknown = Saider.saidify(event)[1];
  if (
    typeof untrusted !== 'object' ||
    untrusted === null ||
    !('d' in untrusted) ||
    typeof untrusted.d !== 'string' ||
    !('v' in untrusted) ||
    typeof untrusted.v !== 'string'
  ) {
    throw new Error('rotation event SAID was not produced');
  }
  return { ...event, d: untrusted.d, v: untrusted.v };
}

function evidence() {
  const event = rotationEvent();
  return {
    identifier: {
      name: 'devrandom-user',
      prefix: user,
      state: {
        i: user,
        s: '1',
        d: event.d,
        bt: '1',
        b: [witness],
      },
      windexes: [0],
    },
    keyEvents: [{ ked: event }],
  };
}

function inceptionEvidence() {
  const event: unknown = incept({
    keys: ['DHKxy2g3cPs6knNLCxv6nx39OqNFcaU2DycTt4gcse2a'],
    ndigs: ['EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao'],
    toad: 1,
    wits: [witness],
    code: MtrDex.Blake3_256,
  }).sad;
  if (
    typeof event !== 'object' ||
    event === null ||
    !('i' in event) ||
    typeof event.i !== 'string' ||
    !('d' in event) ||
    typeof event.d !== 'string'
  ) {
    throw new Error('inception event was not produced');
  }
  const inceptionUser = userAid(event.i);

  return {
    user: inceptionUser,
    said: event.d,
    evidence: {
      identifier: {
        name: 'devrandom-user',
        prefix: inceptionUser,
        state: {
          i: inceptionUser,
          s: '0',
          d: event.d,
          bt: '1',
          b: [witness],
        },
        windexes: [0],
      },
      keyEvents: [{ ked: event }],
    },
  };
}

function chainedEvidence() {
  const inception = inceptionEvidence();
  const rotation = rotationEvent(inception.user, inception.said);
  return {
    identifier: {
      name: 'devrandom-user',
      prefix: inception.user,
      state: {
        i: inception.user,
        s: '1',
        d: rotation.d,
        bt: '1',
        b: [witness],
      },
      windexes: [0],
    },
    keyEvents: [...inception.evidence.keyEvents, { ked: rotation }],
  };
}

describe('witnessed user identifier evidence', () => {
  it('verifies a self-addressing witnessed inception event', () => {
    const inception = inceptionEvidence();

    expect(
      verifyWitnessedUserEvidence(inception.evidence, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toMatchObject({
      aid: inception.user,
      kelSequence: 0,
      currentEventSaid: inception.said,
    });
  });

  it('accepts the integer rotation threshold returned by the pinned KERIA runtime', () => {
    const chained = chainedEvidence();
    expect(
      verifyWitnessedUserEvidence(chained, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toEqual({
      alias: 'devrandom-user',
      aid: chained.identifier.prefix,
      kelSequence: 1,
      currentEventSaid: chained.identifier.state.d,
      witnessPolicy: {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      },
      receiptIndexes: [0],
    });
  });

  it('rejects a detached current event without its inception-to-current KEL', () => {
    expect(() =>
      verifyWitnessedUserEvidence(evidence(), 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toThrow('continuous inception-to-current KEL');
  });

  it('rejects a missing witness receipt at the configured threshold', () => {
    const incomplete = chainedEvidence();
    incomplete.identifier.windexes = [];

    expect(() =>
      verifyWitnessedUserEvidence(incomplete, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toThrow('witness receipt threshold');
  });

  it('rejects current state whose event is absent from the KEL', () => {
    const incomplete = { ...chainedEvidence(), keyEvents: [] };

    expect(() =>
      verifyWitnessedUserEvidence(incomplete, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toThrow('current key event');
  });

  it('rejects a KEL event whose content does not match its SAID', () => {
    const inception = inceptionEvidence();
    const current = rotationEvent(inception.user, inception.said);
    const tampered = {
      identifier: {
        name: 'devrandom-user',
        prefix: inception.user,
        state: { i: inception.user, s: '1', d: current.d, bt: '1', b: [witness] },
        windexes: [0],
      },
      keyEvents: [...inception.evidence.keyEvents, { ked: { ...current, kt: '2' } }],
    };

    expect(() =>
      verifyWitnessedUserEvidence(tampered, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toThrow('KEL event is not bound by its SAID');
  });

  it('rejects a valid rotation event that does not bind its exact predecessor', () => {
    const broken = chainedEvidence();
    const rotation = rotationEvent(
      broken.identifier.prefix,
      'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    );
    broken.keyEvents[1] = { ked: rotation };
    broken.identifier.state.d = rotation.d;

    expect(() =>
      verifyWitnessedUserEvidence(broken, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }),
    ).toThrow('exact predecessor event');
  });

  it('verifies a lawful event independently of JSON object insertion order', () => {
    const inception = inceptionEvidence();
    const event = rotationEvent(inception.user, inception.said);
    const reordered = {
      identifier: {
        name: 'devrandom-user',
        prefix: inception.user,
        state: { i: inception.user, s: '1', d: event.d, bt: '1', b: [witness] },
        windexes: [0],
      },
      keyEvents: [
        ...inception.evidence.keyEvents,
        {
          ked: {
            d: event.d,
            a: event.a,
            ba: event.ba,
            br: event.br,
            bt: event.bt,
            n: event.n,
            nt: event.nt,
            k: event.k,
            kt: event.kt,
            p: event.p,
            s: event.s,
            i: event.i,
            t: event.t,
            v: event.v,
          },
        },
      ],
    };

    expect(
      verifyWitnessedUserEvidence(reordered, 'devrandom-user', {
        kind: 'witnessed',
        witnessAids: [witness],
        threshold: 1,
      }).currentEventSaid,
    ).toBe(event.d);
  });
});
