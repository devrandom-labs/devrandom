import { randomBytes } from 'node:crypto';

import {
  challengeResponseSaid,
  IdentityFailure,
  userAid,
  type IssuerAid,
  type IssuerChallengeProof,
  type IssuerOobi,
  type UserAid,
} from '@devrandom/identity';
import {
  browserApprovalRequestSchema,
  createRegistrationRequestSchema,
  registrationCreationKeySchema,
  submitAidProofRequestSchema,
  type BrowserApprovalRequest,
  type CreateRegistrationRequest,
  type CreateRegistrationResponse,
  type SubmitAidProofRequest,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import {
  approveRegistration,
  createRegistrationSession,
  rejectRegistration,
  RegistrationSessionFailure,
  submitAidProof,
  type RegistrationSession,
} from '../domain/registration-session.js';
import {
  registrationCreationKeyHash,
  verifyBrowserCapability,
  verifyCliCapability,
  type IssuedRegistrationCapabilities,
} from './registration-capability.js';

export interface RegistrationSnapshot {
  readonly revision: number;
  readonly session: RegistrationSession;
}

export type RegistrationCommit =
  | { readonly kind: 'registration-committed'; readonly snapshot: RegistrationSnapshot }
  | { readonly kind: 'registration-concurrently-modified' }
  | { readonly kind: 'registration-proof-replayed' };

export type RegistrationCreation =
  | (RegistrationSnapshot & { readonly kind: 'registration-created' })
  | (RegistrationSnapshot & { readonly kind: 'registration-already-created' });

export interface RegistrationSessions {
  create(session: RegistrationSession, creationKeyHash: string): Promise<RegistrationCreation>;
  retrieveByCreationKeyHash(
    creationKeyHash: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot | undefined>;
  retrieve(registrationId: string, observedAt: number): Promise<RegistrationSnapshot | undefined>;
  commit(current: RegistrationSnapshot, next: RegistrationSession): Promise<RegistrationCommit>;
}

export interface UserOobiResolution {
  readonly userAid: UserAid;
  readonly userAgentOobi: string;
}

export type RegistrationEnrollmentError =
  | { readonly kind: 'request-invalid' }
  | { readonly kind: 'registration-unavailable' }
  | { readonly kind: 'registration-conflict' }
  | { readonly kind: 'aid-proof-rejected' }
  | { readonly kind: 'aid-proof-replayed' }
  | { readonly kind: 'registration-expired' }
  | { readonly kind: 'registration-rejected' };

export class RegistrationEnrollmentFailure extends Error {
  readonly detail: RegistrationEnrollmentError;

  constructor(detail: RegistrationEnrollmentError) {
    super(detail.kind);
    this.name = 'RegistrationEnrollmentFailure';
    this.detail = detail;
  }
}

export interface RegistrationEnrollmentPolicy {
  readonly issuerAid: IssuerAid;
  readonly issuerOobi: IssuerOobi;
  readonly registrationSiteUrl: string;
  readonly lifetimeMs: number;
  readonly pollIntervalMs: number;
  readonly challengeOperationTimeoutMs: number;
}

export interface RegistrationEnrollmentDependencies {
  readonly sessions: RegistrationSessions;
  readonly challenge: IssuerChallengeProof;
  readonly resolveUserOobi: (resolution: UserOobiResolution) => Promise<void>;
  readonly now: () => number;
  readonly createRegistrationId: () => string;
  readonly issueCapabilities: (creationKey: string) => IssuedRegistrationCapabilities;
}

export type RegistrationCreationOutcome =
  | { readonly kind: 'registration-created'; readonly response: CreateRegistrationResponse }
  | { readonly kind: 'registration-replayed'; readonly response: CreateRegistrationResponse };

type RegistrationMutation =
  | {
      readonly kind: 'record-proof';
      readonly responseSaid: string;
      readonly acceptedAt: number;
    }
  | {
      readonly kind: 'record-proof-rejection';
      readonly rejectedAt: number;
    }
  | {
      readonly kind: 'record-approval';
      readonly contactEmail: string;
      readonly approvedAt: number;
    }
  | { readonly kind: 'record-rejection'; readonly rejectedAt: number };

export class RegistrationEnrollment {
  readonly #policy: RegistrationEnrollmentPolicy;
  readonly #dependencies: RegistrationEnrollmentDependencies;

  constructor(
    policy: RegistrationEnrollmentPolicy,
    dependencies: RegistrationEnrollmentDependencies,
  ) {
    this.#policy = policy;
    this.#dependencies = dependencies;
  }

  async create(
    input: CreateRegistrationRequest,
    creationKey: string,
  ): Promise<RegistrationCreationOutcome> {
    if (
      !Value.Check(createRegistrationRequestSchema, input) ||
      !Value.Check(registrationCreationKeySchema, creationKey)
    ) {
      return invalidRequest();
    }

    const registeredUserAid = userAid(input.userAid);
    const creationKeyHash = registrationCreationKeyHash(creationKey);
    const capabilities = this.#dependencies.issueCapabilities(creationKey);
    const observedAt = this.#dependencies.now();
    const existing = await this.#dependencies.sessions.retrieveByCreationKeyHash(
      creationKeyHash,
      observedAt,
    );
    if (existing !== undefined) {
      return {
        kind: 'registration-replayed',
        response: this.#creationResponse(existing.session, input, capabilities, observedAt),
      };
    }

    await this.#dependencies.resolveUserOobi({
      userAid: registeredUserAid,
      userAgentOobi: input.userAgentOobi,
    });
    const challengeWords = await this.#dependencies.challenge.createChallenge();
    const registrationId = this.#dependencies.createRegistrationId();
    const createdAt = observedAt;
    const expiresAt = createdAt + this.#policy.lifetimeMs;
    if (
      !/^[a-f0-9]{32}$/u.test(registrationId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= createdAt
    ) {
      return invalidRequest();
    }

    const creation = await this.#dependencies.sessions.create(
      createRegistrationSession({
        registrationId,
        protocolVersion: String(input.protocolVersion),
        userAid: registeredUserAid,
        userAgentOobi: input.userAgentOobi,
        issuerAid: this.#policy.issuerAid,
        challengeWords,
        cliCapabilityHash: capabilities.cli.hash,
        browserCapabilityHash: capabilities.browser.hash,
        createdAt,
        expiresAt,
      }),
      creationKeyHash,
    );

    return {
      kind:
        creation.kind === 'registration-created' ? 'registration-created' : 'registration-replayed',
      response: this.#creationResponse(creation.session, input, capabilities, observedAt),
    };
  }

  #creationResponse(
    session: RegistrationSession,
    input: CreateRegistrationRequest,
    capabilities: IssuedRegistrationCapabilities,
    observedAt: number,
  ): CreateRegistrationResponse {
    if (observedAt >= session.binding.expiresAt || session.kind === 'expired') {
      return expired();
    }
    if (session.kind === 'rejected') {
      throw new RegistrationEnrollmentFailure({ kind: 'registration-rejected' });
    }
    if (
      session.binding.protocolVersion !== String(input.protocolVersion) ||
      session.binding.userAid !== input.userAid ||
      session.binding.userAgentOobi !== input.userAgentOobi ||
      session.binding.issuerAid !== this.#policy.issuerAid ||
      session.binding.cliCapabilityHash !== capabilities.cli.hash ||
      session.binding.browserCapabilityHash !== capabilities.browser.hash
    ) {
      return conflict();
    }
    return {
      registrationId: session.binding.registrationId,
      cliCapability: capabilities.cli.value,
      browserUrl: `${this.#policy.registrationSiteUrl}/#/registration/${session.binding.registrationId}?capability=${capabilities.browser.value}`,
      challengeWords: [...session.binding.challengeWords],
      issuerAid: this.#policy.issuerAid,
      issuerOobi: this.#policy.issuerOobi,
      expiresAt: new Date(session.binding.expiresAt).toISOString(),
      pollIntervalMs: this.#policy.pollIntervalMs,
    };
  }

  async cliSession(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    return this.#authorizedCli(registrationId, capability, this.#dependencies.now());
  }

  async browserSession(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    return this.#authorizedBrowser(registrationId, capability, this.#dependencies.now());
  }

  async submitAidProof(
    registrationId: string,
    capability: string,
    request: SubmitAidProofRequest,
  ): Promise<RegistrationSnapshot> {
    if (!Value.Check(submitAidProofRequestSchema, request)) {
      return invalidRequest();
    }
    const observedAt = this.#dependencies.now();
    const current = await this.#authorizedCli(registrationId, capability, observedAt);
    requireActive(current.session);
    const recorded = recordedResponseSaid(current.session);
    if (recorded !== undefined) {
      if (recorded === request.responseSaid) {
        return current;
      }
      return conflict();
    }

    const responseSaid = challengeResponseSaid(request.responseSaid);
    try {
      await this.#dependencies.challenge.verifyResponse({
        sourceAid: userAid(current.session.binding.userAid),
        challengeWords: current.session.binding.challengeWords,
        responseSaid,
        operationTimeoutMs: this.#policy.challengeOperationTimeoutMs,
      });
    } catch (cause) {
      if (cause instanceof IdentityFailure && cause.detail.kind === 'challenge-response-invalid') {
        await this.#commit(current, {
          kind: 'record-proof-rejection',
          rejectedAt: this.#dependencies.now(),
        });
        return aidProofRejected();
      }
      throw cause;
    }

    const acceptedAt = this.#dependencies.now();

    return this.#commit(current, {
      kind: 'record-proof',
      responseSaid,
      acceptedAt,
    });
  }

  async approve(
    registrationId: string,
    capability: string,
    request: BrowserApprovalRequest,
  ): Promise<RegistrationSnapshot> {
    if (!Value.Check(browserApprovalRequestSchema, request)) {
      return invalidRequest();
    }
    const approvedAt = this.#dependencies.now();
    const current = await this.#authorizedBrowser(registrationId, capability, approvedAt);
    requireActive(current.session);
    return this.#commit(current, {
      kind: 'record-approval',
      contactEmail: request.contactEmail,
      approvedAt,
    });
  }

  async reject(registrationId: string, capability: string): Promise<RegistrationSnapshot> {
    const rejectedAt = this.#dependencies.now();
    const current = await this.#authorizedBrowser(registrationId, capability, rejectedAt);
    if (current.session.kind === 'expired') {
      return expired();
    }
    return this.#commit(current, { kind: 'record-rejection', rejectedAt });
  }

  async #authorizedCli(
    registrationId: string,
    capability: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot> {
    const snapshot = await this.#retrieved(registrationId, observedAt);
    if (
      verifyCliCapability(capability, snapshot.session.binding.cliCapabilityHash).kind !==
      'cli-capability-verified'
    ) {
      return unavailable();
    }
    return snapshot;
  }

  async #authorizedBrowser(
    registrationId: string,
    capability: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot> {
    const snapshot = await this.#retrieved(registrationId, observedAt);
    if (
      verifyBrowserCapability(capability, snapshot.session.binding.browserCapabilityHash).kind !==
      'browser-capability-verified'
    ) {
      return unavailable();
    }
    return snapshot;
  }

  async #retrieved(registrationId: string, observedAt: number): Promise<RegistrationSnapshot> {
    if (!/^[a-f0-9]{32}$/u.test(registrationId)) {
      return unavailable();
    }
    const snapshot = await this.#dependencies.sessions.retrieve(registrationId, observedAt);
    if (snapshot === undefined) {
      return unavailable();
    }
    return snapshot;
  }

  async #commit(
    initial: RegistrationSnapshot,
    mutation: RegistrationMutation,
  ): Promise<RegistrationSnapshot> {
    let current = initial;
    for (;;) {
      let next: RegistrationSession;
      try {
        next = applyMutation(current.session, mutation);
      } catch (cause) {
        if (cause instanceof RegistrationSessionFailure) {
          return conflict();
        }
        throw cause;
      }
      if (next.kind === 'expired') {
        return expired();
      }
      if (next === current.session) {
        return current;
      }

      const committed = await this.#dependencies.sessions.commit(current, next);
      switch (committed.kind) {
        case 'registration-committed':
          return committed.snapshot;
        case 'registration-proof-replayed':
          return aidProofReplayed();
        case 'registration-concurrently-modified': {
          const latest = await this.#dependencies.sessions.retrieve(
            current.session.binding.registrationId,
            mutationInstant(mutation),
          );
          if (latest === undefined) {
            return unavailable();
          }
          current = latest;
          break;
        }
      }
    }
  }
}

export const registrationEnrollmentDefaults = {
  createRegistrationId: () => randomBytes(16).toString('hex'),
  now: () => Date.now(),
};

function applyMutation(
  session: RegistrationSession,
  mutation: RegistrationMutation,
): RegistrationSession {
  switch (mutation.kind) {
    case 'record-proof':
      return submitAidProof(session, {
        registrationId: session.binding.registrationId,
        sourceAid: session.binding.userAid,
        recipientAid: session.binding.issuerAid,
        challengeWords: session.binding.challengeWords,
        responseSaid: mutation.responseSaid,
        acceptedAt: mutation.acceptedAt,
      });
    case 'record-approval':
      return approveRegistration(session, {
        contactEmail: mutation.contactEmail,
        approvedAt: mutation.approvedAt,
      });
    case 'record-proof-rejection':
      return rejectRegistration(session, {
        rejection: {
          kind: 'proof-rejected',
          reason: 'Signify response did not match this Registration Session',
        },
        rejectedAt: mutation.rejectedAt,
      });
    case 'record-rejection':
      return rejectRegistration(session, {
        rejection: { kind: 'browser-declined' },
        rejectedAt: mutation.rejectedAt,
      });
  }
}

function mutationInstant(mutation: RegistrationMutation): number {
  switch (mutation.kind) {
    case 'record-proof':
      return mutation.acceptedAt;
    case 'record-approval':
      return mutation.approvedAt;
    case 'record-proof-rejection':
      return mutation.rejectedAt;
    case 'record-rejection':
      return mutation.rejectedAt;
  }
}

function recordedResponseSaid(session: RegistrationSession): string | undefined {
  switch (session.kind) {
    case 'pending-proof':
    case 'rejected':
    case 'expired':
      return undefined;
    case 'pending-approval':
    case 'approved':
    case 'issuing':
    case 'issued':
      return session.proof.responseSaid;
  }
}

function requireActive(session: RegistrationSession): void {
  if (session.kind === 'expired') {
    expired();
  }
  if (session.kind === 'rejected') {
    throw new RegistrationEnrollmentFailure({ kind: 'registration-rejected' });
  }
}

function invalidRequest(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'request-invalid' });
}

function unavailable(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'registration-unavailable' });
}

function conflict(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'registration-conflict' });
}

function aidProofRejected(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'aid-proof-rejected' });
}

function aidProofReplayed(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'aid-proof-replayed' });
}

function expired(): never {
  throw new RegistrationEnrollmentFailure({ kind: 'registration-expired' });
}
