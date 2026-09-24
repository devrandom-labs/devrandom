import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
  correlateIpexGrantNotification,
  verifyIpexAdmitEvidence,
  verifyIpexGrantEvidence,
} from './ipex.js';
import { ipexGrantSaid, issuerAid, userAid } from './keri-identifier.js';

const expected = ipexGrantSaid('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao');
const unrelated = 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4';

describe('IPEX grant correlation', () => {
  it('ignores the first unread grant when its SAID is unrelated', () => {
    const page = {
      notes: [
        { i: 'note-decoy', r: false, a: { r: '/exn/ipex/grant', d: unrelated } },
        { i: 'note-expected', r: false, a: { r: '/exn/ipex/grant', d: expected } },
      ],
    };

    expect(correlateIpexGrantNotification(page, expected)).toEqual({
      kind: 'expected-grant-available',
      notificationId: 'note-expected',
      grantSaid: expected,
    });
  });

  it('does not correlate a matching SAID on another exchange route', () => {
    expect(
      correlateIpexGrantNotification(
        { notes: [{ i: 'note', r: false, a: { r: '/exn/ipex/offer', d: expected } }] },
        expected,
      ),
    ).toEqual({ kind: 'expected-grant-pending' });
  });

  it('distinguishes an already-read exact grant for reconciliation', () => {
    expect(
      correlateIpexGrantNotification(
        { notes: [{ i: 'note', r: true, a: { r: '/exn/ipex/grant', d: expected } }] },
        expected,
      ),
    ).toEqual({
      kind: 'expected-grant-already-read',
      notificationId: 'note',
      grantSaid: expected,
    });
  });

  it('rejects a malformed notification page instead of treating it as pending', () => {
    expect(() => correlateIpexGrantNotification({ notes: 'invalid' }, expected)).toThrow(
      'IPEX notification page',
    );
  });
});

describe('IPEX grant evidence', () => {
  const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
  const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
  function saidify<Value extends object & { readonly d: string }>(value: Value): Value {
    const untrusted: unknown = Saider.saidify(value)[1];
    if (
      typeof untrusted !== 'object' ||
      untrusted === null ||
      !('d' in untrusted) ||
      typeof untrusted.d !== 'string'
    ) {
      throw new Error('SAID was not produced');
    }
    if ('v' in value) {
      if (!('v' in untrusted) || typeof untrusted.v !== 'string') {
        throw new Error('versioned SAID did not preserve a version string');
      }
      return { ...value, d: untrusted.d, v: untrusted.v };
    }
    return { ...value, d: untrusted.d };
  }

  function grantEvidence() {
    const acdc = saidify({
      v: 'ACDC10JSON000000_',
      d: '',
      i: issuer,
      ri: 'ERegistry',
      s: 'ESchema',
      a: { d: 'EAttributes', i: user },
    });
    const iss = saidify({
      v: 'KERI10JSON000000_',
      t: 'iss',
      d: '',
      i: acdc.d,
      ri: acdc.ri,
      s: '0',
    });
    const anc = saidify({
      v: 'KERI10JSON000000_',
      t: 'ixn',
      d: '',
      i: issuer,
      s: '1',
      p: issuer,
      a: [{ i: acdc.d, s: iss.s, d: iss.d }],
    });
    const embeds = saidify({ d: '', acdc, iss, anc });
    const exn = saidify({
      v: 'KERI10JSON000000_',
      t: 'exn',
      d: '',
      i: issuer,
      rp: user,
      p: '',
      dt: '2026-09-24T16:00:00.000000+00:00',
      r: '/ipex/grant',
      q: {},
      a: { i: user, m: '' },
      e: embeds,
    });
    return { exn, credentialSaid: acdc.d };
  }

  it('requires the exact grant, issuer, recipient, route, and embedded credential', () => {
    const evidence = grantEvidence();
    expect(
      verifyIpexGrantEvidence(
        { exn: evidence.exn },
        {
          grantSaid: ipexGrantSaid(evidence.exn.d),
          issuerAid: issuer,
          recipientAid: user,
          credentialSaid: evidence.credentialSaid,
        },
      ),
    ).toEqual({
      grantSaid: evidence.exn.d,
      credentialSaid: evidence.credentialSaid,
    });
  });

  it('rejects a grant embedding a different credential', () => {
    const evidence = grantEvidence();
    expect(() =>
      verifyIpexGrantEvidence(
        { exn: evidence.exn },
        {
          grantSaid: ipexGrantSaid(evidence.exn.d),
          issuerAid: issuer,
          recipientAid: user,
          credentialSaid: unrelated,
        },
      ),
    ).toThrow('exact Registration Session');
  });

  it('rejects tampering that retains the claimed grant SAID', () => {
    const evidence = grantEvidence();

    expect(() =>
      verifyIpexGrantEvidence(
        { exn: { ...evidence.exn, a: { ...evidence.exn.a, m: 'tampered' } } },
        {
          grantSaid: ipexGrantSaid(evidence.exn.d),
          issuerAid: issuer,
          recipientAid: user,
          credentialSaid: evidence.credentialSaid,
        },
      ),
    ).toThrow('exact Registration Session');
  });

  it('accepts only a self-addressed admit for the exact grant and principals', () => {
    const grant = grantEvidence();
    const admit = saidify({
      v: 'KERI10JSON000000_',
      t: 'exn',
      d: '',
      i: user,
      rp: issuer,
      p: grant.exn.d,
      dt: '2026-09-24T16:01:00.000000+00:00',
      r: '/ipex/admit',
      q: {},
      a: { i: issuer, m: '' },
      e: {},
    });

    expect(() => {
      verifyIpexAdmitEvidence(admit, {
        admitSaid: admit.d,
        grantSaid: ipexGrantSaid(grant.exn.d),
        sourceAid: user,
        recipientAid: issuer,
      });
    }).not.toThrow();
    expect(() => {
      verifyIpexAdmitEvidence(
        { ...admit, p: unrelated },
        {
          admitSaid: admit.d,
          grantSaid: ipexGrantSaid(grant.exn.d),
          sourceAid: user,
          recipientAid: issuer,
        },
      );
    }).toThrow('exact Registration Session grant');
  });
});
