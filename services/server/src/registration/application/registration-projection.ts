import { createHash } from 'node:crypto';

import type { IssuerOobi } from '@devrandom/identity';
import {
  credentialCapabilities,
  type BrowserRegistrationProjection,
  type CliRegistrationProjection,
} from '@devrandom/protocol';

import type { RegistrationRejection, RegistrationSession } from '../domain/registration-session.js';

export function cliRegistrationProjection(
  session: RegistrationSession,
  issuerOobi: IssuerOobi,
): CliRegistrationProjection {
  const reference = registrationReference(session);
  switch (session.kind) {
    case 'pending-proof':
      return {
        kind: 'pending-proof',
        ...reference,
        issuerAid: session.binding.issuerAid,
        issuerOobi,
        challengeWords: [...session.binding.challengeWords],
      };
    case 'pending-approval':
      return { kind: 'pending-approval', ...reference };
    case 'approved':
      return { kind: 'approved', ...reference };
    case 'issuing':
      return { kind: 'issuing', ...reference };
    case 'issued':
      return {
        kind: 'issued',
        ...reference,
        grantSaid: session.grantSaid,
        credentialSaid: session.credentialSaid,
      };
    case 'rejected':
      return {
        kind: 'rejected',
        ...reference,
        reason: cliRejection(session.rejection),
      };
    case 'expired':
      return { kind: 'expired', ...reference };
  }
}

export function browserRegistrationProjection(
  session: RegistrationSession,
): BrowserRegistrationProjection {
  const reference = browserReference(session);
  switch (session.kind) {
    case 'pending-proof':
      return { kind: 'pending-proof', ...reference };
    case 'pending-approval':
      return { kind: 'pending-approval', ...reference };
    case 'approved':
      return { kind: 'approved', ...reference };
    case 'issuing':
      return { kind: 'issuing', ...reference };
    case 'issued':
      return { kind: 'issued', ...reference };
    case 'rejected':
      return { kind: 'rejected', ...reference };
    case 'expired':
      return { kind: 'expired', ...reference };
  }
}

type BrowserReference = Omit<
  Extract<BrowserRegistrationProjection, { kind: 'pending-proof' }>,
  'kind'
>;

function browserReference(session: RegistrationSession): BrowserReference {
  return {
    ...registrationReference(session),
    issuerAid: session.binding.issuerAid,
    abbreviatedUserAid: abbreviatedAid(session.binding.userAid),
    comparisonCode: comparisonCode(session),
    credentialName: 'Devrandom User',
    capabilities: [...credentialCapabilities],
    contactEmailAssurance: 'self-asserted-unverified',
  };
}

function registrationReference(session: RegistrationSession) {
  return {
    registrationId: session.binding.registrationId,
    userAid: session.binding.userAid,
    expiresAt: new Date(session.binding.expiresAt).toISOString(),
  };
}

function abbreviatedAid(aid: string): string {
  return `${aid.slice(0, 8)}…${aid.slice(-8)}`;
}

function comparisonCode(session: RegistrationSession): string {
  const digest = createHash('sha256')
    .update(session.binding.registrationId, 'utf8')
    .update('\0', 'utf8')
    .update(session.binding.userAid, 'utf8')
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `${digest.slice(0, 4)}-${digest.slice(4)}`;
}

function cliRejection(
  rejection: RegistrationRejection,
): Extract<CliRegistrationProjection, { kind: 'rejected' }>['reason'] {
  switch (rejection.kind) {
    case 'browser-declined':
      return 'browser-rejected';
    case 'proof-rejected':
      return 'aid-proof-rejected';
    case 'issuance-failed':
      return 'issuance-failed';
  }
}
