import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure } from './identity-error.js';
import type {
  GovernorAid,
  IpexGrantSaid,
  IssuerAid,
  PersonalAgentAid,
  UserAid,
} from './keri-identifier.js';

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
        p: Type.String(),
        r: Type.Literal('/ipex/grant'),
        a: Type.Object(
          { i: Type.String({ minLength: 1 }), m: Type.String() },
          { additionalProperties: true },
        ),
        e: Type.Object(
          {
            d: Type.String({ minLength: 1 }),
            acdc: Type.Object(
              {
                d: Type.String({ minLength: 1 }),
                i: Type.String({ minLength: 1 }),
                ri: Type.String({ minLength: 1 }),
                a: Type.Object(
                  { i: Type.String({ minLength: 1 }) },
                  { additionalProperties: true },
                ),
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

export interface MandateIpexGrantExpectation {
  readonly grantSaid: IpexGrantSaid;
  readonly exchangeSenderAid: string;
  readonly exchangeRecipientAid: string;
  readonly credentialIssuerAid: string;
  readonly credentialIssueeAid: string;
  readonly credentialSaid: string;
}

export interface IpexAdmitExpectation {
  readonly admitSaid: string;
  readonly grantSaid: IpexGrantSaid;
  readonly sourceAid: UserAid | PersonalAgentAid | GovernorAid | IssuerAid;
  readonly recipientAid: UserAid | PersonalAgentAid | GovernorAid | IssuerAid;
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

export function verifyMandateIpexGrantEvidence(
  evidence: unknown,
  expected: MandateIpexGrantExpectation,
): MandateIpexGrantExpectation {
  if (!Value.Check(grantExchangeSchema, evidence)) {
    return invalidMandateGrant();
  }
  const { exn } = evidence;
  if (
    exn.d !== expected.grantSaid ||
    exn.i !== expected.exchangeSenderAid ||
    exn.rp !== expected.exchangeRecipientAid ||
    exn.p !== '' ||
    exn.a.i !== expected.exchangeRecipientAid ||
    exn.a.m !== '' ||
    exn.e.acdc.d !== expected.credentialSaid ||
    exn.e.acdc.i !== expected.credentialIssuerAid ||
    exn.e.acdc.a.i !== expected.credentialIssueeAid ||
    exn.e.iss.i !== exn.e.acdc.d ||
    exn.e.iss.ri !== exn.e.acdc.ri ||
    exn.e.anc.i !== expected.credentialIssuerAid ||
    !exn.e.anc.a.some(
      (seal) => seal.i === exn.e.acdc.d && seal.s === exn.e.iss.s && seal.d === exn.e.iss.d,
    )
  ) {
    return invalidMandateGrant();
  }
  try {
    if (
      !new Saider({ qb64: exn.d }).verify(exn, true, true) ||
      !new Saider({ qb64: exn.e.d }).verify(exn.e, true) ||
      !new Saider({ qb64: exn.e.acdc.d }).verify(exn.e.acdc, true, true) ||
      !new Saider({ qb64: exn.e.iss.d }).verify(exn.e.iss, true, true) ||
      !new Saider({ qb64: exn.e.anc.d }).verify(exn.e.anc, true, true)
    ) {
      return invalidMandateGrant();
    }
  } catch {
    return invalidMandateGrant();
  }
  return { ...expected };
}

function invalidGrant(): never {
  throw new IdentityFailure({
    kind: 'ipex-evidence-invalid',
    reason: 'IPEX grant does not match the exact Registration Session evidence',
  });
}

function invalidMandateGrant(): never {
  throw new IdentityFailure({
    kind: 'ipex-evidence-invalid',
    reason: 'IPEX grant does not match the exact mandate presentation evidence',
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
      readonly notificationIds: readonly [string, ...string[]];
      readonly grantSaid: IpexGrantSaid;
    }
  | {
      readonly kind: 'expected-grant-already-read';
      readonly grantSaid: IpexGrantSaid;
    };

function duplicateNotificationIdentity(): never {
  throw new IdentityFailure({
    kind: 'ipex-evidence-invalid',
    reason: 'IPEX notification identity is duplicated for the exact expected grant',
  });
}

export function mergeIpexGrantCorrelations(
  accumulated: IpexGrantCorrelation,
  next: IpexGrantCorrelation,
): IpexGrantCorrelation {
  if (accumulated.kind === 'expected-grant-pending') {
    return next;
  }
  if (next.kind === 'expected-grant-pending') {
    return accumulated;
  }
  if (accumulated.grantSaid !== next.grantSaid) {
    throw new IdentityFailure({
      kind: 'ipex-evidence-invalid',
      reason: 'IPEX notification pages correlate different expected grants',
    });
  }
  if (accumulated.kind === 'expected-grant-already-read') {
    return next.kind === 'expected-grant-already-read' ? accumulated : next;
  }
  if (next.kind === 'expected-grant-already-read') {
    return accumulated;
  }
  const identities = new Set(accumulated.notificationIds);
  for (const notificationId of next.notificationIds) {
    if (identities.has(notificationId)) {
      return duplicateNotificationIdentity();
    }
    identities.add(notificationId);
  }
  return {
    kind: 'expected-grant-available',
    notificationIds: [
      accumulated.notificationIds[0],
      ...accumulated.notificationIds.slice(1),
      ...next.notificationIds,
    ],
    grantSaid: accumulated.grantSaid,
  };
}

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
  const identities = new Set<string>();
  const unreadNotificationIds: string[] = [];
  for (const notification of matching) {
    if (identities.has(notification.i)) {
      return duplicateNotificationIdentity();
    }
    identities.add(notification.i);
    if (!notification.r) {
      unreadNotificationIds.push(notification.i);
    }
  }
  const [firstUnread, ...remainingUnread] = unreadNotificationIds;
  return firstUnread === undefined
    ? { kind: 'expected-grant-already-read', grantSaid: expectedGrantSaid }
    : {
        kind: 'expected-grant-available',
        notificationIds: [firstUnread, ...remainingUnread],
        grantSaid: expectedGrantSaid,
      };
}
