import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure } from './identity-error.js';
import { type IpexGrantSaid, type IssuerAid, type UserAid } from './keri-identifier.js';

const notificationPageSchema = Type.Object(
  {
    notes: Type.Array(
      Type.Object(
        {
          i: Type.String({ minLength: 1 }),
          r: Type.Boolean(),
          a: Type.Object(
            {
              r: Type.String({ minLength: 1 }),
              d: Type.String({ minLength: 1 }),
            },
            { additionalProperties: true },
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const grantExchangeSchema = Type.Object(
  {
    exn: Type.Object(
      {
        v: Type.String({ minLength: 1 }),
        d: Type.String({ minLength: 1 }),
        i: Type.String({ minLength: 1 }),
        rp: Type.String({ minLength: 1 }),
        r: Type.Literal('/ipex/grant'),
        a: Type.Object({ i: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
        e: Type.Object(
          {
            d: Type.String({ minLength: 1 }),
            acdc: Type.Object(
              {
                d: Type.String({ minLength: 1 }),
                i: Type.String({ minLength: 1 }),
                ri: Type.String({ minLength: 1 }),
              },
              { additionalProperties: true },
            ),
            iss: Type.Object(
              {
                d: Type.String({ minLength: 1 }),
                i: Type.String({ minLength: 1 }),
                ri: Type.String({ minLength: 1 }),
                s: Type.String({ minLength: 1 }),
              },
              { additionalProperties: true },
            ),
            anc: Type.Object(
              {
                d: Type.String({ minLength: 1 }),
                i: Type.String({ minLength: 1 }),
                a: Type.Array(
                  Type.Object(
                    {
                      i: Type.String({ minLength: 1 }),
                      s: Type.String({ minLength: 1 }),
                      d: Type.String({ minLength: 1 }),
                    },
                    { additionalProperties: true },
                  ),
                ),
              },
              { additionalProperties: true },
            ),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const admitExchangeSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    d: Type.String({ minLength: 1 }),
    i: Type.String({ minLength: 1 }),
    rp: Type.String({ minLength: 1 }),
    p: Type.String({ minLength: 1 }),
    r: Type.Literal('/ipex/admit'),
    a: Type.Object({ i: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);

export interface IpexGrantExpectation {
  readonly grantSaid: IpexGrantSaid;
  readonly issuerAid: IssuerAid;
  readonly recipientAid: UserAid;
  readonly credentialSaid: string;
}

export interface VerifiedIpexGrant {
  readonly grantSaid: IpexGrantSaid;
  readonly credentialSaid: string;
}

export interface IpexAdmitExpectation {
  readonly admitSaid: string;
  readonly grantSaid: IpexGrantSaid;
  readonly sourceAid: UserAid;
  readonly recipientAid: IssuerAid;
}

export function verifyIpexGrantEvidence(
  evidence: unknown,
  expected: IpexGrantExpectation,
): VerifiedIpexGrant {
  if (!Value.Check(grantExchangeSchema, evidence)) {
    return invalidGrant();
  }
  const { exn } = evidence;
  if (
    exn.d !== expected.grantSaid ||
    exn.i !== expected.issuerAid ||
    exn.rp !== expected.recipientAid ||
    exn.a.i !== expected.recipientAid ||
    exn.e.acdc.d !== expected.credentialSaid ||
    exn.e.acdc.i !== expected.issuerAid ||
    exn.e.iss.i !== exn.e.acdc.d ||
    exn.e.iss.ri !== exn.e.acdc.ri ||
    exn.e.anc.i !== expected.issuerAid ||
    !exn.e.anc.a.some(
      (seal) => seal.i === exn.e.acdc.d && seal.s === exn.e.iss.s && seal.d === exn.e.iss.d,
    )
  ) {
    return invalidGrant();
  }
  try {
    if (
      !new Saider({ qb64: exn.d }).verify(exn, true, true) ||
      !new Saider({ qb64: exn.e.d }).verify(exn.e, true) ||
      !new Saider({ qb64: exn.e.acdc.d }).verify(exn.e.acdc, true, true) ||
      !new Saider({ qb64: exn.e.iss.d }).verify(exn.e.iss, true, true) ||
      !new Saider({ qb64: exn.e.anc.d }).verify(exn.e.anc, true, true)
    ) {
      return invalidGrant();
    }
  } catch {
    return invalidGrant();
  }
  return {
    grantSaid: expected.grantSaid,
    credentialSaid: expected.credentialSaid,
  };
}

function invalidGrant(): never {
  throw new IdentityFailure({
    kind: 'ipex-evidence-invalid',
    reason: 'IPEX grant does not match the exact Registration Session evidence',
  });
}

export function verifyIpexAdmitEvidence(evidence: unknown, expected: IpexAdmitExpectation): void {
  if (
    !Value.Check(admitExchangeSchema, evidence) ||
    evidence.d !== expected.admitSaid ||
    evidence.i !== expected.sourceAid ||
    evidence.rp !== expected.recipientAid ||
    evidence.a.i !== expected.recipientAid ||
    evidence.p !== expected.grantSaid
  ) {
    return invalidAdmit();
  }
  try {
    if (!new Saider({ qb64: evidence.d }).verify(evidence, true, true)) {
      return invalidAdmit();
    }
  } catch {
    return invalidAdmit();
  }
}

function invalidAdmit(): never {
  throw new IdentityFailure({
    kind: 'ipex-evidence-invalid',
    reason: 'IPEX admit does not match the exact Registration Session grant',
  });
}

export type IpexGrantCorrelation =
  | { readonly kind: 'expected-grant-pending' }
  | {
      readonly kind: 'expected-grant-available';
      readonly notificationId: string;
      readonly grantSaid: IpexGrantSaid;
    }
  | {
      readonly kind: 'expected-grant-already-read';
      readonly notificationId: string;
      readonly grantSaid: IpexGrantSaid;
    };

export function correlateIpexGrantNotification(
  evidence: unknown,
  expectedGrantSaid: IpexGrantSaid,
): IpexGrantCorrelation {
  if (!Value.Check(notificationPageSchema, evidence)) {
    throw new IdentityFailure({
      kind: 'ipex-evidence-invalid',
      reason: 'IPEX notification page is malformed',
    });
  }

  const matching = evidence.notes.filter(
    (note) => note.a.r === '/exn/ipex/grant' && note.a.d === expectedGrantSaid,
  );
  if (matching.length === 0) {
    return { kind: 'expected-grant-pending' };
  }
  if (matching.length !== 1 || matching[0] === undefined) {
    throw new IdentityFailure({
      kind: 'ipex-evidence-invalid',
      reason: 'more than one notification claims the exact expected IPEX grant',
    });
  }
  const notification = matching[0];
  return notification.r
    ? {
        kind: 'expected-grant-already-read',
        notificationId: notification.i,
        grantSaid: expectedGrantSaid,
      }
    : {
        kind: 'expected-grant-available',
        notificationId: notification.i,
        grantSaid: expectedGrantSaid,
      };
}
