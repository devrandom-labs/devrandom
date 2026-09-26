import { describe, expect, it, vi } from 'vitest';
import type {
  CredentialReconciliation,
  DevrandomUserCredentialDelivery,
  GrantPreparation,
  GrantReconciliation,
} from '@devrandom/identity';
import { IdentityFailure } from '@devrandom/identity';

import {
  approveRegistration,
  createRegistrationSession,
  submitAidProof,
  type RegistrationSession,
} from '../domain/registration-session.js';
import type {
  RegistrationCommit,
  RegistrationSessions,
  RegistrationSnapshot,
} from './registration-enrollment.js';
import { RegistrationIssuance } from './registration-issuance.js';

const createdAt = Date.parse('2026-09-24T12:00:00.000Z');

function approved(): RegistrationSession {
  const pending = createRegistrationSession({
    registrationId: 'a'.repeat(32),
    protocolVersion: '1',
    userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
    userAgentOobi: 'http://keria.test/oobi/user/agent/agent',
    issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    challengeWords: ['amber', 'cabin', 'delta'],
    cliCapabilityHash: '1'.repeat(64),
    browserCapabilityHash: '2'.repeat(64),
    createdAt,
    expiresAt: createdAt + 300_000,
  });
  const proved = submitAidProof(pending, {
    registrationId: pending.binding.registrationId,
    sourceAid: pending.binding.userAid,
    recipientAid: pending.binding.issuerAid,
    challengeWords: pending.binding.challengeWords,
    responseSaid: 'EResponse',
    acceptedAt: createdAt + 1_000,
  });
  return approveRegistration(proved, {
    contactEmail: 'Private+Demo@example.com',
    approvedAt: createdAt + 2_000,
  });
}

class MemoryRegistrationSessions implements RegistrationSessions {
  #snapshot: RegistrationSnapshot = { revision: 0, session: approved() };

  create(session: RegistrationSession) {
    this.#snapshot = { revision: 0, session };
    return Promise.resolve({ kind: 'registration-created', ...this.#snapshot } as const);
  }

  retrieveByCreationKeyHash(): Promise<RegistrationSnapshot> {
    return Promise.resolve(this.#snapshot);
  }

  retrieve(): Promise<RegistrationSnapshot> {
    return Promise.resolve(this.#snapshot);
  }

  commit(current: RegistrationSnapshot, next: RegistrationSession): Promise<RegistrationCommit> {
    if (current.revision !== this.#snapshot.revision) {
      return Promise.resolve({ kind: 'registration-concurrently-modified' });
    }
    this.#snapshot = { revision: current.revision + 1, session: next };
    return Promise.resolve({ kind: 'registration-committed', snapshot: this.#snapshot });
  }
}

function delivery(
  reconcileCredential = vi.fn((): Promise<CredentialReconciliation> =>
    Promise.resolve({ kind: 'credential-not-found' }),
  ),
) {
  const submitCredential = vi.fn<DevrandomUserCredentialDelivery['submitCredential']>(() =>
    Promise.resolve<CredentialReconciliation>({
      kind: 'credential-submitted',
      credentialSaid: 'ECredential',
      operationName: 'credential.EOperation',
    }),
  );
  const submitGrant = vi.fn(() =>
    Promise.resolve<GrantReconciliation>({
      kind: 'grant-submitted',
      operationName: 'exchange.EOperation',
    }),
  );
  const capability: DevrandomUserCredentialDelivery = {
    reconcileCredential,
    submitCredential,
    verifyCredential: vi.fn(() => Promise.resolve()),
    prepareGrant: vi.fn(() =>
      Promise.resolve<GrantPreparation>({ kind: 'grant-prepared', grantSaid: 'EGrant' }),
    ),
    reconcileGrant: vi.fn((): Promise<GrantReconciliation> =>
      Promise.resolve({ kind: 'grant-not-found' }),
    ),
    submitGrant,
    verifyGrant: vi.fn(() => Promise.resolve()),
  };
  return { capability, submitCredential, submitGrant };
}

describe('durable Registration Session issuance', () => {
  it('records every external identity and never supplies contact email as a credential claim', async () => {
    const sessions = new MemoryRegistrationSessions();
    const deliveryFixture = delivery();
    let now = createdAt + 3_000;
    const issuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => (now += 1_000),
      },
    );

    const issued = await issuance.advance(await sessions.retrieve());

    expect(issued.session).toMatchObject({
      kind: 'issued',
      credentialSaid: 'ECredential',
      grantSaid: 'EGrant',
      credentialOperationName: 'credential.EOperation',
      grantOperationName: 'exchange.EOperation',
    });
    const submitCredential = deliveryFixture.submitCredential;
    expect(submitCredential).toHaveBeenCalledOnce();
    const [credentialInput] = submitCredential.mock.calls[0] ?? [];
    expect(credentialInput).toMatchObject({
      issueeAid: approved().binding.userAid,
      issuerAid: approved().binding.issuerAid,
      claims: [
        'CreateAgent',
        'CreateTask',
        'RunPrivateTask',
        'PublishHarness',
        'ReceiveTaskResults',
      ],
    });
    expect(JSON.stringify(credentialInput)).not.toContain('Private+Demo@example.com');
  });

  it('reconciles an existing stable credential instead of issuing a second one', async () => {
    const sessions = new MemoryRegistrationSessions();
    const deliveryFixture = delivery(
      vi.fn(() =>
        Promise.resolve<CredentialReconciliation>({
          kind: 'credential-submitted',
          credentialSaid: 'EExistingCredential',
          operationName: 'credential.EExistingOperation',
        }),
      ),
    );
    const issuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => createdAt + 3_000,
      },
    );

    const issued = await issuance.advance(await sessions.retrieve());

    expect(issued.session).toMatchObject({
      kind: 'issued',
      credentialSaid: 'EExistingCredential',
    });
    expect(deliveryFixture.submitCredential).not.toHaveBeenCalled();
  });

  it('coalesces concurrent advances before any credential or grant side effect', async () => {
    const sessions = new MemoryRegistrationSessions();
    let releaseReconciliation: (() => void) | undefined;
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const reconcileCredential = vi.fn(async (): Promise<CredentialReconciliation> => {
      await reconciliationGate;
      return { kind: 'credential-not-found' };
    });
    const deliveryFixture = delivery(reconcileCredential);
    const issuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => createdAt + 3_000,
      },
    );
    const initial = await sessions.retrieve();

    const first = issuance.advance(initial);
    const concurrent = issuance.advance(initial);
    await vi.waitFor(() => {
      expect(reconcileCredential).toHaveBeenCalledTimes(1);
    });
    releaseReconciliation?.();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);

    expect(firstResult.session.kind).toBe('issued');
    expect(concurrentResult).toEqual(firstResult);
    expect(deliveryFixture.submitCredential).toHaveBeenCalledOnce();
    expect(deliveryFixture.submitGrant).toHaveBeenCalledOnce();
  });

  it('reconciles an interrupted grant submission without submitting another grant', async () => {
    const sessions = new MemoryRegistrationSessions();
    const deliveryFixture = delivery();
    const submitGrant = vi
      .spyOn(deliveryFixture.capability, 'submitGrant')
      .mockRejectedValueOnce(new Error('connection closed after grant submission'));
    const issuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => createdAt + 3_000,
      },
    );

    await expect(issuance.advance(await sessions.retrieve())).rejects.toThrow(
      'connection closed after grant submission',
    );
    expect((await sessions.retrieve()).session).toMatchObject({
      kind: 'issuing',
      progress: { kind: 'grant-prepared', grantSaid: 'EGrant' },
    });
    vi.spyOn(deliveryFixture.capability, 'reconcileGrant').mockResolvedValue({
      kind: 'grant-submitted',
      operationName: 'exchange.ERecoveredOperation',
    });

    const recoveredIssuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => createdAt + 4_000,
      },
    );
    const recovered = await recoveredIssuance.advance(await sessions.retrieve());

    expect(recovered.session).toMatchObject({
      kind: 'issued',
      grantOperationName: 'exchange.ERecoveredOperation',
    });
    expect(submitGrant).toHaveBeenCalledOnce();
  });

  it('durably rejects invalid credential evidence as issuance-failed', async () => {
    const sessions = new MemoryRegistrationSessions();
    const deliveryFixture = delivery();
    vi.spyOn(deliveryFixture.capability, 'verifyCredential').mockRejectedValue(
      new IdentityFailure({ kind: 'credential-invalid', reason: 'issuer anchor mismatched' }),
    );
    const issuance = new RegistrationIssuance(
      {
        issuerAlias: 'devrandom-issuer',
        registryId: 'ERegistry',
        schemaId: 'ESchema',
        operationTimeoutMs: 30_000,
      },
      {
        sessions,
        credentialDelivery: deliveryFixture.capability,
        now: () => createdAt + 3_000,
      },
    );

    const rejected = await issuance.advance(await sessions.retrieve());

    expect(rejected.session).toMatchObject({
      kind: 'rejected',
      rejection: { kind: 'issuance-failed' },
    });
  });
});
