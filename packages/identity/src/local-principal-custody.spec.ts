import { describe, expect, it, vi } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import {
  agentAid,
  controllerAid,
  governorAid,
  keyEventSaid,
  personalAgentAid,
  userAid,
  witnessAid,
} from './keri-identifier.js';
import {
  establishLocalPrincipals,
  GOVERNOR_ALIAS,
  PERSONAL_AGENT_ALIAS,
  verifyLocalPrincipalAgentOobiEvidence,
  type LocalPrincipalCustody,
  type WitnessedGovernorIdentifier,
  type WitnessedPersonalAgentIdentifier,
} from './local-principal-custody.js';

const controller = controllerAid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');
const keriaAgent = agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');
const user = userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const otherPersonalAgent = personalAgentAid('EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho');
const witness = witnessAid('BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha');
const witnessPolicy = {
  kind: 'witnessed' as const,
  witnessAids: [witness],
  threshold: 1,
};

function personalAgentIdentity(aid = personalAgent): WitnessedPersonalAgentIdentifier {
  return {
    alias: PERSONAL_AGENT_ALIAS,
    aid,
    kelSequence: 0,
    currentEventSaid: keyEventSaid(aid),
    witnessPolicy,
    receiptIndexes: [0],
    verifiedKeyEvents: [{ kind: 'Inception', sequence: 0, said: keyEventSaid(aid) }],
  };
}

function governorIdentity(aid = governor): WitnessedGovernorIdentifier {
  return {
    alias: GOVERNOR_ALIAS,
    aid,
    kelSequence: 0,
    currentEventSaid: keyEventSaid(aid),
    witnessPolicy,
    receiptIndexes: [0],
    verifiedKeyEvents: [{ kind: 'Inception', sequence: 0, said: keyEventSaid(aid) }],
  };
}

function custody(): LocalPrincipalCustody {
  return {
    controllerAid: controller,
    agentAid: keriaAgent,
    prepareWitnesses: vi.fn(() => Promise.resolve()),
    provisionPersonalAgent: vi.fn(() =>
      Promise.resolve({
        origin: 'principal-provisioned' as const,
        identifier: personalAgentIdentity(),
        agentOobi: `http://keria.test/oobi/${personalAgent}/agent/${keriaAgent}`,
      }),
    ),
    provisionGovernor: vi.fn(() =>
      Promise.resolve({
        origin: 'principal-provisioned' as const,
        identifier: governorIdentity(),
        agentOobi: `http://keria.test/oobi/${governor}/agent/${keriaAgent}`,
      }),
    ),
    recoverPersonalAgent: vi.fn(() =>
      Promise.resolve({
        origin: 'existing-principal-verified' as const,
        identifier: personalAgentIdentity(),
        agentOobi: `http://keria.test/oobi/${personalAgent}/agent/${keriaAgent}`,
      }),
    ),
    recoverGovernor: vi.fn(() =>
      Promise.resolve({
        origin: 'existing-principal-verified' as const,
        identifier: governorIdentity(),
        agentOobi: `http://keria.test/oobi/${governor}/agent/${keriaAgent}`,
      }),
    ),
  };
}

const common = {
  expectedControllerAid: controller,
  expectedAgentAid: keriaAgent,
  userAid: user,
  witnessPolicy,
};

describe('local principal custody', () => {
  it('provisions the exact personal-agent and Governor aliases under existing custody', async () => {
    const localCustody = custody();

    await expect(
      establishLocalPrincipals(localCustody, {
        kind: 'provision-local-principals',
        ...common,
      }),
    ).resolves.toMatchObject({
      controllerAid: controller,
      agentAid: keriaAgent,
      userAid: user,
      personalAgent: {
        origin: 'principal-provisioned',
        identifier: { alias: PERSONAL_AGENT_ALIAS, aid: personalAgent },
      },
      governor: {
        origin: 'principal-provisioned',
        identifier: { alias: GOVERNOR_ALIAS, aid: governor },
      },
    });

    expect(localCustody.prepareWitnesses).toHaveBeenCalledExactlyOnceWith(witnessPolicy);
    expect(localCustody.provisionPersonalAgent).toHaveBeenCalledExactlyOnceWith(witnessPolicy, [
      user,
      controller,
      keriaAgent,
    ]);
    expect(localCustody.provisionGovernor).toHaveBeenCalledExactlyOnceWith(witnessPolicy, [
      user,
      controller,
      keriaAgent,
      personalAgent,
    ]);
  });

  it('recovers the exact stored AIDs without invoking a provisioning path', async () => {
    const localCustody = custody();

    await expect(
      establishLocalPrincipals(localCustody, {
        kind: 'recover-local-principals',
        ...common,
        expectedPersonalAgentAid: personalAgent,
        expectedGovernorAid: governor,
      }),
    ).resolves.toMatchObject({
      personalAgent: { origin: 'existing-principal-verified' },
      governor: { origin: 'existing-principal-verified' },
    });
    expect(localCustody.provisionPersonalAgent).not.toHaveBeenCalled();
    expect(localCustody.provisionGovernor).not.toHaveBeenCalled();
  });

  it('rejects an alias/AID recovery mismatch without provisioning a replacement', async () => {
    const localCustody = custody();
    vi.mocked(localCustody.recoverPersonalAgent).mockResolvedValue({
      origin: 'existing-principal-verified',
      identifier: personalAgentIdentity(otherPersonalAgent),
      agentOobi: `http://keria.test/oobi/${otherPersonalAgent}/agent/${keriaAgent}`,
    });

    await expect(
      establishLocalPrincipals(localCustody, {
        kind: 'recover-local-principals',
        ...common,
        expectedPersonalAgentAid: personalAgent,
        expectedGovernorAid: governor,
      }),
    ).rejects.toThrow('personal-agent AID differs from the local profile');
    expect(localCustody.provisionPersonalAgent).not.toHaveBeenCalled();
  });

  it('rejects a same-AID collision between the two managed principals', async () => {
    const localCustody = custody();
    vi.mocked(localCustody.provisionGovernor).mockResolvedValue({
      origin: 'existing-principal-verified',
      identifier: governorIdentity(governorAid(personalAgent)),
      agentOobi: `http://keria.test/oobi/${personalAgent}/agent/${keriaAgent}`,
    });

    await expect(
      establishLocalPrincipals(localCustody, {
        kind: 'provision-local-principals',
        ...common,
      }),
    ).rejects.toThrow('user, personal-agent, and Governor AIDs must be distinct');
  });

  it.each(['witness mismatch', 'missing endpoint role', 'missing OOBI'])(
    'fails closed for %s and does not cross into replacement',
    async (reason) => {
      const localCustody = custody();
      vi.mocked(localCustody.recoverPersonalAgent).mockRejectedValue(
        new IdentityFailure({
          kind: 'identifier-conflict',
          alias: PERSONAL_AGENT_ALIAS,
          reason,
        }),
      );

      await expect(
        establishLocalPrincipals(localCustody, {
          kind: 'recover-local-principals',
          ...common,
          expectedPersonalAgentAid: personalAgent,
          expectedGovernorAid: governor,
        }),
      ).rejects.toThrow(reason);
      expect(localCustody.provisionPersonalAgent).not.toHaveBeenCalled();
    },
  );

  it('rejects a controller mismatch before touching either managed identifier', async () => {
    const localCustody = custody();
    const anotherController = controllerAid('EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho');

    await expect(
      establishLocalPrincipals(localCustody, {
        kind: 'provision-local-principals',
        ...common,
        expectedControllerAid: anotherController,
      }),
    ).rejects.toThrow('controller or KERIA agent differs from the local profile');
    expect(localCustody.provisionPersonalAgent).not.toHaveBeenCalled();
    expect(localCustody.provisionGovernor).not.toHaveBeenCalled();
  });

  it('accepts only the published OOBI binding the exact principal and KERIA agent', () => {
    const expected = `http://keria.test/oobi/${personalAgent}/agent/${keriaAgent}`;

    expect(
      verifyLocalPrincipalAgentOobiEvidence(
        { role: 'agent', oobis: [expected] },
        PERSONAL_AGENT_ALIAS,
        personalAgent,
        keriaAgent,
      ),
    ).toBe(expected);
    expect(() =>
      verifyLocalPrincipalAgentOobiEvidence(
        { role: 'agent', oobis: [] },
        PERSONAL_AGENT_ALIAS,
        personalAgent,
        keriaAgent,
      ),
    ).toThrow('OOBI response is absent');
  });
});
