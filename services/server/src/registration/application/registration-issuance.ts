import type {
  DevrandomUserCredentialDelivery,
  StableCredentialIssuance,
  StableGrantDelivery,
} from '@devrandom/identity';
import { IdentityFailure } from '@devrandom/identity';
import { credentialCapabilities } from '@devrandom/protocol';

import {
  beginIssuance,
  completeIssuance,
  recordCredentialSubmission,
  recordCredentialVerification,
  recordGrantPreparation,
  recordGrantSubmission,
  rejectRegistration,
  type RegistrationSession,
} from '../domain/registration-session.js';
import type { RegistrationSessions, RegistrationSnapshot } from './registration-enrollment.js';

export interface RegistrationIssuancePolicy {
  readonly issuerAlias: string;
  readonly registryId: string;
  readonly schemaId: string;
  readonly operationTimeoutMs: number;
}

export interface RegistrationIssuanceDependencies {
  readonly sessions: RegistrationSessions;
  readonly credentialDelivery: DevrandomUserCredentialDelivery;
  readonly now: () => number;
}

export class RegistrationIssuance {
  readonly #policy: RegistrationIssuancePolicy;
  readonly #dependencies: RegistrationIssuanceDependencies;
  readonly #activeAdvancements = new Map<string, Promise<RegistrationSnapshot>>();

  constructor(policy: RegistrationIssuancePolicy, dependencies: RegistrationIssuanceDependencies) {
    this.#policy = policy;
    this.#dependencies = dependencies;
  }

  advance(initial: RegistrationSnapshot): Promise<RegistrationSnapshot> {
    const registrationId = initial.session.binding.registrationId;
    const active = this.#activeAdvancements.get(registrationId);
    if (active !== undefined) {
      return active;
    }
    const advancement = this.#advance(initial);
    this.#activeAdvancements.set(registrationId, advancement);
    void advancement.then(
      () => {
        this.#retireAdvancement(registrationId, advancement);
      },
      () => {
        this.#retireAdvancement(registrationId, advancement);
      },
    );
    return advancement;
  }

  async #advance(initial: RegistrationSnapshot): Promise<RegistrationSnapshot> {
    let current = initial;
    for (;;) {
      switch (current.session.kind) {
        case 'pending-proof':
        case 'pending-approval':
        case 'issued':
        case 'rejected':
        case 'expired':
          return current;
        case 'approved':
          current = await this.#persist(
            current,
            beginIssuance(current.session, { issuedAt: this.#dependencies.now() }),
          );
          break;
        case 'issuing':
          try {
            current = await this.#advanceIssuing(current);
          } catch (cause) {
            if (!terminalIssuanceEvidenceFailure(cause)) {
              throw cause;
            }
            return this.#persist(
              current,
              rejectRegistration(current.session, {
                rejection: {
                  kind: 'issuance-failed',
                  reason: 'Issuer could not validate durable credential delivery evidence',
                },
                rejectedAt: this.#dependencies.now(),
              }),
            );
          }
          break;
      }
    }
  }

  #retireAdvancement(registrationId: string, advancement: Promise<RegistrationSnapshot>): void {
    if (this.#activeAdvancements.get(registrationId) === advancement) {
      this.#activeAdvancements.delete(registrationId);
    }
  }

  async #advanceIssuing(current: RegistrationSnapshot): Promise<RegistrationSnapshot> {
    if (current.session.kind !== 'issuing') {
      return current;
    }
    const progress = current.session.progress;
    switch (progress.kind) {
      case 'prepared': {
        const issuance = this.#credentialIssuance(current, progress.issuedAt);
        const reconciled =
          await this.#dependencies.credentialDelivery.reconcileCredential(issuance);
        const submission =
          reconciled.kind === 'credential-submitted'
            ? reconciled
            : await this.#dependencies.credentialDelivery.submitCredential(issuance);
        if (submission.kind !== 'credential-submitted') {
          throw new Error('credential submission returned no durable identity');
        }
        return this.#persist(
          current,
          recordCredentialSubmission(current.session, {
            credentialSaid: submission.credentialSaid,
            operationName: submission.operationName,
            recordedAt: this.#dependencies.now(),
          }),
        );
      }
      case 'credential-submitted': {
        await this.#dependencies.credentialDelivery.verifyCredential({
          ...this.#credentialIssuance(current, progress.issuedAt),
          credentialSaid: progress.credentialSaid,
          operationName: progress.operationName,
        });
        return this.#persist(
          current,
          recordCredentialVerification(current.session, {
            credentialSaid: progress.credentialSaid,
            verifiedAt: this.#dependencies.now(),
          }),
        );
      }
      case 'credential-verified': {
        const preparedAt = this.#dependencies.now();
        const prepared = await this.#dependencies.credentialDelivery.prepareGrant(
          this.#grantDelivery(current, progress.credentialSaid, preparedAt),
        );
        return this.#persist(
          current,
          recordGrantPreparation(current.session, {
            credentialSaid: progress.credentialSaid,
            grantSaid: prepared.grantSaid,
            preparedAt,
          }),
        );
      }
      case 'grant-prepared': {
        const delivery = this.#grantDelivery(current, progress.credentialSaid, progress.preparedAt);
        const prepared = await this.#dependencies.credentialDelivery.prepareGrant(delivery);
        if (prepared.grantSaid !== progress.grantSaid) {
          throw new Error('reconstructed IPEX grant does not match durable state');
        }
        const submissionInput = { ...delivery, grantSaid: progress.grantSaid };
        const reconciled =
          await this.#dependencies.credentialDelivery.reconcileGrant(submissionInput);
        const submission =
          reconciled.kind === 'grant-submitted'
            ? reconciled
            : await this.#dependencies.credentialDelivery.submitGrant(submissionInput);
        if (submission.kind !== 'grant-submitted') {
          throw new Error('grant submission returned no durable operation identity');
        }
        return this.#persist(
          current,
          recordGrantSubmission(current.session, {
            credentialSaid: progress.credentialSaid,
            grantSaid: progress.grantSaid,
            operationName: submission.operationName,
            recordedAt: this.#dependencies.now(),
          }),
        );
      }
      case 'grant-submitted': {
        await this.#dependencies.credentialDelivery.verifyGrant({
          ...this.#grantDelivery(current, progress.credentialSaid, progress.grantPreparedAt),
          grantSaid: progress.grantSaid,
          operationName: progress.grantOperationName,
        });
        return this.#persist(
          current,
          completeIssuance(current.session, {
            credentialSaid: progress.credentialSaid,
            grantSaid: progress.grantSaid,
            completedAt: this.#dependencies.now(),
          }),
        );
      }
    }
  }

  #credentialIssuance(current: RegistrationSnapshot, issuedAt: number): StableCredentialIssuance {
    return {
      issuerAlias: this.#policy.issuerAlias,
      issuerAid: current.session.binding.issuerAid,
      issueeAid: current.session.binding.userAid,
      registryId: this.#policy.registryId,
      schemaId: this.#policy.schemaId,
      issuedAt,
      claims: [...credentialCapabilities],
      operationTimeoutMs: this.#policy.operationTimeoutMs,
    };
  }

  #grantDelivery(
    current: RegistrationSnapshot,
    credentialSaid: string,
    preparedAt: number,
  ): StableGrantDelivery {
    return {
      issuerAlias: this.#policy.issuerAlias,
      issuerAid: current.session.binding.issuerAid,
      recipientAid: current.session.binding.userAid,
      credentialSaid,
      preparedAt,
      operationTimeoutMs: this.#policy.operationTimeoutMs,
    };
  }

  async #persist(
    current: RegistrationSnapshot,
    next: RegistrationSession,
  ): Promise<RegistrationSnapshot> {
    const committed = await this.#dependencies.sessions.commit(current, next);
    switch (committed.kind) {
      case 'registration-committed':
        return committed.snapshot;
      case 'registration-proof-replayed':
        throw new Error('issuance transition unexpectedly attempted proof replay');
      case 'registration-concurrently-modified': {
        const latest = await this.#dependencies.sessions.retrieve(
          current.session.binding.registrationId,
          this.#dependencies.now(),
        );
        if (latest === undefined) {
          throw new Error('Registration Session disappeared during issuance');
        }
        return latest;
      }
    }
  }
}

function terminalIssuanceEvidenceFailure(cause: unknown): cause is IdentityFailure {
  return (
    cause instanceof IdentityFailure &&
    (cause.detail.kind === 'credential-invalid' ||
      cause.detail.kind === 'credential-delivery-invalid' ||
      cause.detail.kind === 'ipex-evidence-invalid')
  );
}
