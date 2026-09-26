import {
  GOVERNOR_ALIAS,
  MANDATE_REGISTRY_NAME,
  PERSONAL_AGENT_ALIAS,
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  keyEventSaid,
  personalAgentAid,
  userAid,
  witnessAid,
  type CredentialRegistryOutcome,
  type EstablishedLocalPrincipals,
} from '@devrandom/identity';
import { describe, expect, it, vi } from 'vitest';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import { LocalGovernance } from './local-governance.js';

const controller = controllerAid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');
const keriaAgent = agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');
const user = userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const registryId = credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK');
const changedRegistryId = credentialRegistryId('EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho');
const witness = witnessAid('BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha');
const witnessPolicy = { kind: 'witnessed' as const, witnessAids: [witness], threshold: 1 };

function principals(
  origin: 'principal-provisioned' | 'existing-principal-verified',
): EstablishedLocalPrincipals {
  return {
    controllerAid: controller,
    agentAid: keriaAgent,
    userAid: user,
    personalAgent: {
      origin,
      identifier: {
        alias: PERSONAL_AGENT_ALIAS,
        aid: personalAgent,
        kelSequence: 0,
        currentEventSaid: keyEventSaid(personalAgent),
        witnessPolicy,
        receiptIndexes: [0],
        verifiedKeyEvents: [{ kind: 'Inception', sequence: 0, said: keyEventSaid(personalAgent) }],
      },
      agentOobi: `http://keria.test/oobi/${personalAgent}/agent/${keriaAgent}`,
    },
    governor: {
      origin,
      identifier: {
        alias: GOVERNOR_ALIAS,
        aid: governor,
        kelSequence: 0,
        currentEventSaid: keyEventSaid(governor),
        witnessPolicy,
        receiptIndexes: [0],
        verifiedKeyEvents: [{ kind: 'Inception', sequence: 0, said: keyEventSaid(governor) }],
      },
      agentOobi: `http://keria.test/oobi/${governor}/agent/${keriaAgent}`,
    },
  };
}

function profile(): LocalGovernanceProfile {
  return {
    version: 1,
    revision: 0,
    userAid: user,
    controllerAid: controller,
    keriaAgentAid: keriaAgent,
    personalAgentAid: personalAgent,
    governorAid: governor,
    mandateRegistryId: registryId,
  };
}

function registry(id = registryId): CredentialRegistryOutcome<typeof user> {
  return {
    kind: 'existing-credential-registry-verified',
    registry: { name: MANDATE_REGISTRY_NAME, id, issuerAid: user },
  };
}

const currentUser = {
  alias: 'devrandom-user',
  userAid: user,
  controllerAid: controller,
  keriaAgentAid: keriaAgent,
  witnessPolicy,
};

describe('local governance establishment', () => {
  it('provisions distinct principals and one user-owned registry before recording expectations', async () => {
    const commit = vi.fn(() => Promise.resolve());
    const establishPrincipals = vi.fn(() => Promise.resolve(principals('principal-provisioned')));
    const provisionRegistry = vi.fn(() => Promise.resolve(registry()));
    const governance = new LocalGovernance({
      profiles: { read: () => Promise.resolve(undefined), commit },
      establishPrincipals,
      registry: { controllerAid: controller, agentAid: keriaAgent, provisionRegistry },
      operationTimeoutMs: 30_000,
    });

    await expect(governance.establish(currentUser)).resolves.toMatchObject({
      kind: 'Ready',
      recovery: 'GovernanceProvisioned',
      profile: profile(),
    });
    expect(establishPrincipals).toHaveBeenCalledExactlyOnceWith({
      kind: 'provision-local-principals',
      expectedControllerAid: controller,
      expectedAgentAid: keriaAgent,
      userAid: user,
      witnessPolicy,
    });
    expect(provisionRegistry).toHaveBeenCalledExactlyOnceWith({
      userAlias: 'devrandom-user',
      userAid: user,
      policy: { kind: 'backerless' },
      operationTimeoutMs: 30_000,
    });
    expect(commit).toHaveBeenCalledExactlyOnceWith(undefined, profile());
  });

  it('recovers exact recorded AIDs and does not rewrite durable state', async () => {
    const commit = vi.fn(() => Promise.resolve());
    const establishPrincipals = vi.fn(() =>
      Promise.resolve(principals('existing-principal-verified')),
    );
    const governance = new LocalGovernance({
      profiles: { read: () => Promise.resolve(profile()), commit },
      establishPrincipals,
      registry: {
        controllerAid: controller,
        agentAid: keriaAgent,
        provisionRegistry: () => Promise.resolve(registry()),
      },
      operationTimeoutMs: 30_000,
    });

    await expect(governance.establish(currentUser)).resolves.toMatchObject({
      kind: 'Ready',
      recovery: 'ExistingGovernanceVerified',
    });
    expect(establishPrincipals).toHaveBeenCalledExactlyOnceWith({
      kind: 'recover-local-principals',
      expectedControllerAid: controller,
      expectedAgentAid: keriaAgent,
      expectedPersonalAgentAid: personalAgent,
      expectedGovernorAid: governor,
      userAid: user,
      witnessPolicy,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when the named registry no longer has its recorded identity', async () => {
    const governance = new LocalGovernance({
      profiles: { read: () => Promise.resolve(profile()), commit: vi.fn() },
      establishPrincipals: () => Promise.resolve(principals('existing-principal-verified')),
      registry: {
        controllerAid: controller,
        agentAid: keriaAgent,
        provisionRegistry: () => Promise.resolve(registry(changedRegistryId)),
      },
      operationTimeoutMs: 30_000,
    });

    await expect(governance.establish(currentUser)).resolves.toEqual({
      kind: 'RecoveryRejected',
      reason: 'MandateRegistryChanged',
    });
  });
});
