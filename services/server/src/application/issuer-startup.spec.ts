import { describe, expect, it, vi } from 'vitest';

import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  issuerAid,
  issuerOobi,
  type VerifiedIssuerIdentity,
  type VerifiedIssuerInfrastructure,
} from '@devrandom/identity';
import { credentialSchema } from '@devrandom/protocol';

import { issuerProfileFixture } from '../../test/issuer-profile-fixture.js';
import type { IssuerBootstrapConfiguration } from '../domain/issuer-configuration.js';
import { issuerBran, issuerProfilePath, keriaUrl } from '../domain/issuer-configuration.js';
import { startDevrandomIssuer } from './issuer-startup.js';

const configuration: IssuerBootstrapConfiguration = {
  bran: issuerBran('0123456789abcdefghijk'),
  keriaAdminUrl: keriaUrl('http://keria:3901'),
  keriaBootUrl: keriaUrl('http://keria:3903'),
  profilePath: issuerProfilePath('/var/lib/devrandom/issuer-profile.json'),
  securityTier: 'low',
  witnessPolicy: { kind: 'unwitnessed' },
  registryPolicy: { kind: 'backerless' },
  operationTimeoutMs: 30_000,
  oobiAvailabilityTimeoutMs: 10_000,
};

function verifiedIdentity(): VerifiedIssuerIdentity {
  const profile = issuerProfileFixture();
  return {
    controllerAid: profile.controllerAid,
    agentAid: profile.agentAid,
    issuerAid: profile.issuerAid,
    registryId: profile.registryId,
    issuerOobi: profile.issuerOobi,
  };
}

function verifiedInfrastructure(
  identity: VerifiedIssuerIdentity = verifiedIdentity(),
): VerifiedIssuerInfrastructure {
  return {
    identity,
    challengeProof: {
      createChallenge: () => Promise.resolve(['amber', 'cabin', 'delta']),
      verifyResponse: (input) => Promise.resolve({ responseSaid: input.responseSaid }),
    },
    asynchronousChallengeProof: {
      createChallenge: () =>
        Promise.resolve(Array.from({ length: 24 }, (_, index) => `word-${String(index)}`)),
      startVerification: () => Promise.resolve({ operationName: 'challenge.operation' }),
      observeVerification: () => Promise.resolve({ kind: 'Pending' }),
      acknowledgeResponse: () => Promise.resolve(),
      cleanupVerification: () => Promise.resolve(),
    },
    userOobiResolution: {
      resolve: (input) => Promise.resolve({ ...input, agentAid: identity.agentAid }),
    },
    credentialDelivery: {
      reconcileCredential: () => Promise.resolve({ kind: 'credential-not-found' }),
      submitCredential: () => Promise.resolve({ kind: 'credential-not-found' }),
      verifyCredential: () => Promise.resolve(),
      prepareGrant: () => Promise.resolve({ kind: 'grant-prepared', grantSaid: 'EGrant' }),
      reconcileGrant: () => Promise.resolve({ kind: 'grant-not-found' }),
      submitGrant: () => Promise.resolve({ kind: 'grant-not-found' }),
      verifyGrant: () => Promise.resolve(),
    },
    currentUserCredentialVerification: {
      verify: (input) =>
        Promise.resolve({
          kind: 'Current',
          userAid: input.userAid,
          credentialSaid: input.credentialSaid,
          attributeSaid: 'EAttributeSaid',
          issuedAt: '2026-09-24T17:00:00.000Z',
          issuerAnchorEventSaid: 'EIssuerAnchorEventSaid',
          eligibilityClaims: [
            'CreateAgent',
            'CreateTask',
            'RunPrivateTask',
            'PublishHarness',
            'ReceiveTaskResults',
          ],
        }),
    },
    credentialSchema: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    taskMandateSchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    taskMandateV2SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    promotionMandateSchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    promotionMandateV2SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    promotionMandateV3SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    taskMandateV3SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    promotionMandateV4SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    promotionMandateV5SchemaAvailability: {
      resolve: () => Promise.resolve(),
      verify: () => Promise.resolve(),
    },
    mandateAdmission: {
      inspect: () => Promise.resolve({ kind: 'Unavailable', dependency: 'Keria' }),
      begin: () => Promise.resolve({ kind: 'Unavailable', dependency: 'Keria' }),
      observe: () => Promise.resolve({ kind: 'Unavailable', dependency: 'Keria' }),
    },
    runAdmissionExchange: {
      inspect: () => Promise.resolve({ kind: 'Pending' }),
    },
    evidenceSealExchange: {
      inspect: () => Promise.resolve({ kind: 'Pending' }),
    },
    evaluationClosureSealExchange: {
      inspect: () => Promise.resolve({ kind: 'Pending' }),
    },
    promotionExchanges: {
      inspect: () => Promise.resolve({ kind: 'Pending' }),
    },
    publicationSignatures: {
      sign: () => Promise.resolve({ kind: 'Rejected' }),
      verify: () => Promise.resolve('Rejected'),
    },
    activationReceiptExchange: {
      sign: () => Promise.resolve({ kind: 'Pending' }),
      inspect: () => Promise.resolve({ kind: 'Pending' }),
    },
    readiness: { verify: () => Promise.resolve() },
  };
}

async function startupError(identity: VerifiedIssuerIdentity) {
  const profile = issuerProfileFixture();
  const result = await startDevrandomIssuer(configuration, {
    readIssuerProfile: vi.fn(() => Promise.resolve(profile)),
    connectIssuerInfrastructure: vi.fn(() => Promise.resolve(verifiedInfrastructure(identity))),
  });
  if (result.kind !== 'issuer-startup-rejected') {
    throw new Error('mismatched identity was unexpectedly accepted');
  }
  return result.error;
}

describe('issuer startup application', () => {
  it('rejects an absent profile before contacting KERIA', async () => {
    const verifyIdentity = vi.fn(() => Promise.resolve(verifiedInfrastructure()));

    await expect(
      startDevrandomIssuer(configuration, {
        readIssuerProfile: vi.fn(() => Promise.resolve(undefined)),
        connectIssuerInfrastructure: verifyIdentity,
      }),
    ).resolves.toEqual({
      kind: 'issuer-startup-rejected',
      error: { kind: 'issuer-not-bootstrapped' },
    });
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('constructs verified issuer state only after the live identity matches the profile', async () => {
    const profile = issuerProfileFixture();
    const connectIssuerInfrastructure = vi.fn(() => Promise.resolve(verifiedInfrastructure()));
    const result = await startDevrandomIssuer(configuration, {
      readIssuerProfile: vi.fn(() => Promise.resolve(profile)),
      connectIssuerInfrastructure,
    });

    expect(result.kind).toBe('issuer-startup-verified');
    if (result.kind === 'issuer-startup-verified') {
      expect(result.issuer.profile).toEqual(profile);
      expect(result.issuer.identity).toEqual(verifiedIdentity());
      expect(typeof result.infrastructure.evidenceSealExchange.inspect).toBe('function');
      expect(typeof result.infrastructure.evaluationClosureSealExchange.inspect).toBe('function');
    }
    expect(connectIssuerInfrastructure).toHaveBeenCalledWith(
      expect.objectContaining({ issuerAlias: 'devrandom-issuer' }),
      credentialSchema,
    );
  });

  it('rejects a controller that differs from the recorded profile', async () => {
    const profile = issuerProfileFixture();
    const actualControllerAid = controllerAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');

    await expect(
      startDevrandomIssuer(configuration, {
        readIssuerProfile: vi.fn(() => Promise.resolve(profile)),
        connectIssuerInfrastructure: vi.fn(() =>
          Promise.resolve(
            verifiedInfrastructure({
              ...verifiedIdentity(),
              controllerAid: actualControllerAid,
            }),
          ),
        ),
      }),
    ).resolves.toEqual({
      kind: 'issuer-startup-rejected',
      error: {
        kind: 'controller-mismatch',
        expectedControllerAid: profile.controllerAid,
        actualControllerAid,
      },
    });
  });

  it('rejects an agent that differs from the recorded profile', async () => {
    const profile = issuerProfileFixture();
    const actualAgentAid = agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');

    await expect(
      startupError({ ...verifiedIdentity(), agentAid: actualAgentAid }),
    ).resolves.toEqual({
      kind: 'agent-mismatch',
      expectedAgentAid: profile.agentAid,
      actualAgentAid,
    });
  });

  it('rejects an issuer that differs from the recorded profile', async () => {
    const profile = issuerProfileFixture();
    const actualIssuerAid = issuerAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');

    await expect(
      startupError({ ...verifiedIdentity(), issuerAid: actualIssuerAid }),
    ).resolves.toEqual({
      kind: 'issuer-mismatch',
      expectedIssuerAid: profile.issuerAid,
      actualIssuerAid,
    });
  });

  it('rejects a registry that differs from the recorded profile', async () => {
    const profile = issuerProfileFixture();
    const actualRegistryId = credentialRegistryId('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');

    await expect(
      startupError({ ...verifiedIdentity(), registryId: actualRegistryId }),
    ).resolves.toEqual({
      kind: 'registry-mismatch',
      expectedRegistryId: profile.registryId,
      actualRegistryId,
    });
  });

  it('rejects an OOBI that differs from the recorded profile', async () => {
    const profile = issuerProfileFixture();
    const actualIssuerOobi = issuerOobi(
      `http://other-keria:3902/oobi/${profile.issuerAid}/agent/${profile.agentAid}`,
    );

    await expect(
      startupError({ ...verifiedIdentity(), issuerOobi: actualIssuerOobi }),
    ).resolves.toEqual({
      kind: 'issuer-oobi-invalid',
      expectedIssuerOobi: profile.issuerOobi,
      actualIssuerOobi,
    });
  });
});
