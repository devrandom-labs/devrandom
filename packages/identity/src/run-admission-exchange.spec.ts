import { Saider, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings, type RunAdmissionPayload } from '@devrandom/protocol';

import {
  connectLocalRunAdmissionExchange,
  decodeRunAdmissionExchangeEvidence,
  verifyRunAdmissionExchangeEvidence,
  type RunAdmissionExchangeEvidence,
} from './run-admission-exchange.js';
import { agentAid, controllerAid } from './keri-identifier.js';

const issuer = 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk';
const personalAgent = 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz';
const alternateController = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const said = (character: string) => `E${character.repeat(43)}`;

const payload: RunAdmissionPayload = {
  version: 1,
  kind: 'RunAdmission',
  commandId: 'aaf20f91-20a5-45dd-88e3-da9007f4b811',
  taskId: '4d45fc55-b687-4f9d-94f4-1b005b0d9bee',
  taskRevisionSaid: said('a'),
  harnessLineageId: '23c18c5f-cd32-4e5b-8ab6-b91f13d7e778',
  harnessRevisionSaid: said('b'),
  taskMandateSaid: said('c'),
  governorAid: said('d'),
  promotionMandateSaid: said('e'),
  purpose: { kind: 'Retained' },
  repository: { objectFormat: 'sha1', commit: 'f'.repeat(40), tree: '1'.repeat(40) },
  requestedBudget: taskBudgetCeilings,
};

function exchange(): RunAdmissionExchangeEvidence {
  const unsigned = {
    v: 'KERI10JSON000000_',
    t: 'exn',
    d: '',
    i: personalAgent,
    rp: issuer,
    p: '',
    dt: '2026-09-24T20:00:00.000000+00:00',
    r: '/devrandom/run/admission/1',
    q: {},
    a: { i: issuer, ...payload },
    e: {},
  };
  const identified: unknown = Saider.saidify(unsigned)[1];
  if (typeof identified !== 'object' || identified === null) {
    throw new Error('expected an identified exchange');
  }
  const decoded = decodeRunAdmissionExchangeEvidence(identified);
  if (decoded === undefined) {
    throw new Error('expected a decoded Run admission exchange');
  }
  return decoded;
}

describe('personal-agent Run admission exchange', () => {
  it('verifies the Signify SAID, route, recipient, source, and closed payload', () => {
    const evidence = exchange();

    expect(
      verifyRunAdmissionExchangeEvidence(evidence, {
        exchangeSaid: evidence.d,
        recipientAid: issuer,
      }),
    ).toEqual({ kind: 'Verified', sourceAid: personalAgent, payload });
  });

  it.each([
    ['route', (evidence: RunAdmissionExchangeEvidence) => ({ ...evidence, r: '/ipex/grant' })],
    ['recipient', (evidence: RunAdmissionExchangeEvidence) => ({ ...evidence, rp: personalAgent })],
    [
      'payload',
      (evidence: RunAdmissionExchangeEvidence) => ({
        ...evidence,
        a: { ...evidence.a, commandId: '06d5316b-383f-4778-9857-d7ca3626812e' },
      }),
    ],
  ])('rejects a changed %s', (_label, change) => {
    const evidence = exchange();

    expect(
      verifyRunAdmissionExchangeEvidence(change(evidence), {
        exchangeSaid: evidence.d,
        recipientAid: issuer,
      }).kind,
    ).toBe('Rejected');
  });

  it('connects Run signing only to the exact recovered controller and agent', async () => {
    const expectedControllerAid = controllerAid(issuer);
    const expectedAgentAid = agentAid(personalAgent);
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );

    await expect(
      connectLocalRunAdmissionExchange(
        {
          adminUrl: 'http://127.0.0.1:3901',
          bootUrl: 'http://127.0.0.1:3903',
          bran: '0123456789abcdefghijk',
          securityTier: 'low',
          expectedControllerAid,
          expectedAgentAid,
        },
        () =>
          Promise.resolve({
            client,
            controllerAid: expectedControllerAid,
            agentAid: expectedAgentAid,
            connection: 'existing-controller-connected',
          }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a recovered controller binding mismatch before exposing signing', async () => {
    const expectedControllerAid = controllerAid(issuer);
    const expectedAgentAid = agentAid(personalAgent);
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );

    await expect(
      connectLocalRunAdmissionExchange(
        {
          adminUrl: 'http://127.0.0.1:3901',
          bootUrl: 'http://127.0.0.1:3903',
          bran: '0123456789abcdefghijk',
          securityTier: 'low',
          expectedControllerAid,
          expectedAgentAid,
        },
        () =>
          Promise.resolve({
            client,
            controllerAid: controllerAid(alternateController),
            agentAid: expectedAgentAid,
            connection: 'existing-controller-connected',
          }),
      ),
    ).rejects.toMatchObject({ detail: { kind: 'controller-state-invalid' } });
  });
});
