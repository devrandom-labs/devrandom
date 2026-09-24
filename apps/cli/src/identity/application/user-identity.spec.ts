import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentAid,
  challengeResponseSaid,
  controllerAid,
  credentialSaid,
  credentialRegistryId,
  credentialSchemaId,
  issuerAid,
  issuerOobi,
  IdentityFailure,
  keyEventSaid,
  type LocalUserInfrastructure,
  userAid,
  witnessAid,
} from '@devrandom/identity';
import Value from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';

import type { UserIdentityConfiguration } from '../domain/user-configuration.js';
import type { UserProfile } from '../domain/user-profile.js';
import { IdentityFiles } from '../infrastructure/identity-files.js';
import { IssuerRegistrationHttp } from '../infrastructure/issuer-registration-http.js';
import { UserIdentityApplication, type UserIdentityDependencies } from './user-identity.js';

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all([
    ...directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveServer, rejectServer) => {
          server.close((error) => {
            if (error === undefined) {
              resolveServer();
            } else {
              rejectServer(error);
            }
          });
        }),
    ),
  ]);
});

const expectedIssuerAid = issuerAid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');
const expectedIssuerOobi = issuerOobi(
  'http://keria.test/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4/agent/ELSG3CytxWcqG5gYBFcr9_6-cG3j08iC7o21ctXUqSoU',
);
const expectedRegistryId = credentialRegistryId('EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs');
const expectedSchemaId = credentialSchemaId('EH0pPEOR9SgXnsMmTJX12mh_H7WMRZxcM9h12GdZRvCQ');
const expectedWitnessAid = witnessAid('BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha');
const rotatedEventSaid = keyEventSaid('EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs');
const expectedCredentialSaid = credentialSaid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');

function configuration(stateDirectory: string): UserIdentityConfiguration {
  return {
    stateDirectory,
    keriaAdminUrl: 'http://keria.test:3901',
    keriaBootUrl: 'http://keria.test:3903',
    issuerUrl: 'http://issuer.test:3211',
    registrationSiteUrl: 'http://site.test',
    issuerAid: expectedIssuerAid,
    issuerOobi: expectedIssuerOobi,
    registryId: expectedRegistryId,
    schemaId: expectedSchemaId,
    schemaOobi: `http://issuer.test:3211/oobi/${expectedSchemaId}`,
    witnessAid: expectedWitnessAid,
    witnessOobi: 'http://witness.test:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
    operationTimeoutMs: 30_000,
    registrationTimeoutMs: 360_000,
  };
}

function profile(): UserProfile {
  return {
    version: 1,
    revision: 0,
    alias: 'devrandom-user',
    controllerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
    userAgentOobi:
      'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    witnessPolicy: { witnessAids: [expectedWitnessAid], threshold: 1 },
    receiptEvidence: {
      kelSequence: 0,
      currentEventSaid: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
      receiptIndexes: [0],
    },
    issuer: {
      aid: expectedIssuerAid,
      oobi: expectedIssuerOobi,
      registryId: expectedRegistryId,
      schemaSaid: expectedSchemaId,
    },
    provenance: { kind: 'live' },
    custodyReference: 'signify-bran-v1',
  };
}

function admittedProfile(): UserProfile {
  const current = profile();
  return {
    ...current,
    credential: {
      credentialSaid: expectedCredentialSaid,
      attributeSaid: expectedSchemaId,
      issuerAnchorEventSaid: expectedRegistryId,
      issuedAt: '2025-01-01T00:00:00.000Z',
    },
  };
}

function recoveredInfrastructure(
  current: UserProfile,
  kelSequence: number,
  currentEventSaid: string,
  rotate: LocalUserInfrastructure['rotate'],
): LocalUserInfrastructure {
  return {
    identity: {
      controllerAid: controllerAid(current.controllerAid),
      agentAid: agentAid(current.keriaAgentAid),
      user: {
        alias: current.alias,
        aid: userAid(current.userAid),
        kelSequence,
        currentEventSaid: keyEventSaid(currentEventSaid),
        witnessPolicy: {
          kind: 'witnessed',
          witnessAids: [expectedWitnessAid],
          threshold: 1,
        },
        receiptIndexes: [0],
      },
      userAgentOobi: current.userAgentOobi,
    },
    challengeProof: {
      prepare: () => Promise.reject(new Error('challenge proof is outside this regression')),
      deliver: () => Promise.reject(new Error('challenge proof is outside this regression')),
    },
    credentialReception: {
      verify(input) {
        return Promise.resolve({
          credentialSaid: input.credentialSaid,
          attributeSaid: expectedSchemaId,
          issuedAt: '2025-01-01T00:00:00.000Z',
          issuerAnchorEventSaid: expectedRegistryId,
          payload: Value.Parse(input.payloadSchema, {
            v: 'ACDC10JSON000197_',
            d: input.credentialSaid,
            i: input.issuerAid,
            ri: input.registryId,
            s: input.schemaId,
            a: {
              d: expectedSchemaId,
              i: input.issueeAid,
              dt: '2025-01-01T00:00:00.000Z',
              capabilities: [
                'CreateAgent',
                'CreateTask',
                'RunPrivateTask',
                'PublishHarness',
                'ReceiveTaskResults',
              ],
            },
          }),
        });
      },
      admitAndVerify: () =>
        Promise.reject(new Error('credential admission is outside this regression')),
    },
    resolveIssuer: () => Promise.reject(new Error('issuer resolution is outside this regression')),
    resolveCredentialSchema: () =>
      Promise.reject(new Error('credential schema resolution is outside this regression')),
    rotate,
  };
}

function registrationInfrastructure(
  current: UserProfile,
  resolveCredentialSchema: LocalUserInfrastructure['resolveCredentialSchema'] = () =>
    Promise.resolve(),
): LocalUserInfrastructure {
  return {
    ...recoveredInfrastructure(current, 0, current.receiptEvidence.currentEventSaid, () =>
      Promise.reject(new Error('rotation is outside this regression')),
    ),
    challengeProof: {
      prepare: () =>
        Promise.resolve({
          responseSaid: challengeResponseSaid(rotatedEventSaid),
        }),
      deliver: () =>
        Promise.resolve({
          responseSaid: challengeResponseSaid(rotatedEventSaid),
        }),
    },
    resolveIssuer: () => Promise.resolve(),
    resolveCredentialSchema,
  };
}

async function ambiguousCreationIssuer(): Promise<{
  readonly origin: string;
  readonly creationKeys: readonly string[];
}> {
  const creationKeys: string[] = [];
  let creations = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/registrations') {
      creations += 1;
      const creationKey = request.headers['idempotency-key'];
      if (typeof creationKey === 'string') {
        creationKeys.push(creationKey);
      }
      response.statusCode = creations === 1 ? 201 : 200;
      response.setHeader('content-type', 'application/json');
      if (creations > 1) {
        response.setHeader('cache-control', 'no-store');
      }
      response.end(
        JSON.stringify({
          registrationId: 'a'.repeat(32),
          cliCapability: `cli_${'c'.repeat(43)}`,
          browserUrl: `http://site.test/#/registration/${'a'.repeat(32)}?capability=browser_${'b'.repeat(43)}`,
          challengeWords: ['amber', 'cabin', 'delta'],
          issuerAid: expectedIssuerAid,
          issuerOobi: expectedIssuerOobi,
          expiresAt: '2026-09-24T12:05:00.000Z',
          pollIntervalMs: 1_000,
        }),
      );
      return;
    }
    if (request.method === 'POST' && request.url === `/registrations/${'a'.repeat(32)}/aid-proof`) {
      response.statusCode = 202;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      response.end(
        JSON.stringify({
          kind: 'pending-approval',
          registrationId: 'a'.repeat(32),
          userAid: profile().userAid,
          expiresAt: '2026-09-24T12:05:00.000Z',
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test issuer did not bind an IP port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    creationKeys,
  };
}

async function pendingRegistrationIssuer(): Promise<string> {
  const registrationId = 'a'.repeat(32);
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST' && request.url === '/registrations') {
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          registrationId,
          cliCapability: `cli_${'c'.repeat(43)}`,
          browserUrl: `http://site.test/#/registration/${registrationId}?capability=browser_${'b'.repeat(43)}`,
          challengeWords: ['amber', 'cabin', 'delta'],
          issuerAid: expectedIssuerAid,
          issuerOobi: expectedIssuerOobi,
          expiresAt: '2026-09-24T12:05:00.000Z',
          pollIntervalMs: 1_000,
        }),
      );
      return;
    }
    if (request.method === 'POST' && request.url === `/registrations/${registrationId}/aid-proof`) {
      response.statusCode = 202;
      response.end(
        JSON.stringify({
          kind: 'pending-approval',
          registrationId,
          userAid: profile().userAid,
          expiresAt: '2026-09-24T12:05:00.000Z',
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  servers.push(server);
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test issuer did not bind an IP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function expiredRegistrationIssuer(): Promise<string> {
  const registrationId = 'a'.repeat(32);
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST' && request.url === `/registrations/${registrationId}/aid-proof`) {
      response.statusCode = 410;
      response.end(JSON.stringify({ error: 'registration-expired' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'registration-unavailable' }));
  });
  servers.push(server);
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test issuer did not bind an IP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function untrustedBrowserIssuer(): Promise<string> {
  const registrationId = 'a'.repeat(32);
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'POST' && request.url === '/registrations') {
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          registrationId,
          cliCapability: `cli_${'c'.repeat(43)}`,
          browserUrl: `http://untrusted.test/#/registration/${registrationId}?capability=browser_${'b'.repeat(43)}`,
          challengeWords: ['amber', 'cabin', 'delta'],
          issuerAid: expectedIssuerAid,
          issuerOobi: expectedIssuerOobi,
          expiresAt: '2026-09-24T12:05:00.000Z',
          pollIntervalMs: 1_000,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'registration-unavailable' }));
  });
  servers.push(server);
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test issuer did not bind an IP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('user identity application', () => {
  it.each(['whoami', 'rotate'] as const)(
    '%s on clean state performs no provisioning or persistence',
    async (command) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-readonly-'));
      directories.push(stateDirectory);
      const files = new IdentityFiles(stateDirectory);
      let generated = false;
      let connected = false;
      const dependencies: UserIdentityDependencies = {
        generateBran: () => {
          generated = true;
          return Promise.resolve('0123456789abcdefghijk');
        },
        createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
        connectInfrastructure: () => {
          connected = true;
          return Promise.reject(new Error('must not connect'));
        },
        presentBrowserUrl: () => Promise.resolve(),
        now: () => 1_790_220_000_000,
        wait: () => Promise.resolve(),
      };
      const application = new UserIdentityApplication(
        configuration(stateDirectory),
        files,
        new IssuerRegistrationHttp('http://issuer.test:3211'),
        dependencies,
      );

      await expect(application[command]()).resolves.toEqual({
        kind: 'RecoveryRequired',
        reason: 'ProfileUnavailable',
      });
      expect(generated).toBe(false);
      expect(connected).toBe(false);
      await expect(files.readCustody()).resolves.toBeUndefined();
      await expect(files.readProfile()).resolves.toBeUndefined();
    },
  );

  it('requires recovery without generating or connecting when a profile has lost custody', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    await files.commitProfile(undefined, profile());
    let generated = false;
    let connected = false;
    const dependencies: UserIdentityDependencies = {
      generateBran: () => {
        generated = true;
        return Promise.resolve('0123456789abcdefghijk');
      },
      createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
      connectInfrastructure: () => {
        connected = true;
        return Promise.reject(new Error('must not connect'));
      },
      presentBrowserUrl: () => Promise.resolve(),
      now: () => 1_790_220_000_000,
      wait: () => Promise.resolve(),
    };
    const application = new UserIdentityApplication(
      configuration(stateDirectory),
      files,
      new IssuerRegistrationHttp('http://issuer.test:3211'),
      dependencies,
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'RecoveryRequired',
      reason: 'CustodyUnavailable',
    });
    expect(generated).toBe(false);
    expect(connected).toBe(false);
  });

  it('preserves the exact identity when KERIA is unavailable during recovery', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-offline-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    const currentCustody = { version: 1 as const, bran: '0123456789abcdefghijk' };
    const currentProfile = profile();
    await files.createCustody(currentCustody);
    await files.commitProfile(undefined, currentProfile);
    let generated = false;
    const connectionKinds: string[] = [];
    const dependencies: UserIdentityDependencies = {
      generateBran: () => {
        generated = true;
        return Promise.resolve('replacement-custody-is-forbidden');
      },
      createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
      connectInfrastructure: (connection) => {
        connectionKinds.push(connection.kind);
        return Promise.reject(
          new IdentityFailure({
            kind: 'keria-unavailable',
            stage: 'existing identity recovery',
            reason: 'network unreachable',
          }),
        );
      },
      presentBrowserUrl: () => Promise.resolve(),
      now: () => 1_790_220_000_000,
      wait: () => Promise.resolve(),
    };
    const application = new UserIdentityApplication(
      configuration(stateDirectory),
      files,
      new IssuerRegistrationHttp('http://issuer.test:3211'),
      dependencies,
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'InfrastructureUnavailable',
      dependency: 'Keria',
    });
    expect(generated).toBe(false);
    expect(connectionKinds).toEqual(['recover-local-user']);
    await expect(files.readCustody()).resolves.toEqual(currentCustody);
    await expect(files.readProfile()).resolves.toEqual(currentProfile);
  });

  it.each([
    {
      corruptedFile: 'signify-custody.json',
      expectedReason: 'CustodyUnavailable',
    },
    {
      corruptedFile: 'user-profile.json',
      expectedReason: 'ProfileUnavailable',
    },
  ] as const)(
    'reports the unavailable state owner when $corruptedFile is corrupt',
    async ({ corruptedFile, expectedReason }) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-corrupt-'));
      directories.push(stateDirectory);
      const files = new IdentityFiles(stateDirectory);
      await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
      await files.commitProfile(undefined, profile());
      await writeFile(join(stateDirectory, corruptedFile), '{not-json}\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      let connected = false;
      const dependencies: UserIdentityDependencies = {
        generateBran: () => Promise.reject(new Error('must not generate custody')),
        createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
        connectInfrastructure: () => {
          connected = true;
          return Promise.reject(new Error('must not connect'));
        },
        presentBrowserUrl: () => Promise.resolve(),
        now: () => 1_790_220_000_000,
        wait: () => Promise.resolve(),
      };
      const application = new UserIdentityApplication(
        configuration(stateDirectory),
        files,
        new IssuerRegistrationHttp('http://issuer.test:3211'),
        dependencies,
      );

      await expect(application.whoami()).resolves.toMatchObject({
        kind: 'RecoveryRequired',
        reason: expectedReason,
      });
      expect(connected).toBe(false);
    },
  );

  it('reconciles one completed pending rotation without rotating a second time', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-rotation-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    const prior = admittedProfile();
    const pending: UserProfile = {
      ...prior,
      rotation: {
        kind: 'rotation-pending',
        priorKelSequence: prior.receiptEvidence.kelSequence,
        priorEventSaid: prior.receiptEvidence.currentEventSaid,
      },
    };
    await files.commitProfile(undefined, pending);
    let rotationCalls = 0;
    const infrastructure = recoveredInfrastructure(pending, 1, rotatedEventSaid, () => {
      rotationCalls += 1;
      return Promise.reject(new Error('a reconciled retry must not rotate again'));
    });
    const dependencies: UserIdentityDependencies = {
      generateBran: () => Promise.reject(new Error('must not generate custody')),
      createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
      connectInfrastructure: () => Promise.resolve(infrastructure),
      presentBrowserUrl: () => Promise.resolve(),
      now: () => Date.parse('2025-01-02T00:00:00.000Z'),
      wait: () => Promise.resolve(),
    };
    const application = new UserIdentityApplication(
      configuration(stateDirectory),
      files,
      new IssuerRegistrationHttp('http://issuer.test:3211'),
      dependencies,
    );

    const outcome = await application.rotate();

    expect(outcome.kind).toBe('Ready');
    expect(rotationCalls).toBe(0);
    await expect(files.readProfile()).resolves.toMatchObject({
      revision: 1,
      receiptEvidence: {
        kelSequence: 1,
        currentEventSaid: rotatedEventSaid,
        receiptIndexes: [0],
      },
    });
    expect((await files.readProfile())?.rotation).toBeUndefined();
  });

  it('does not resubmit an ambiguous pending rotation while KERIA still reports the prior event', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-identity-rotation-ambiguous-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    const prior = admittedProfile();
    const pending: UserProfile = {
      ...prior,
      rotation: {
        kind: 'rotation-pending',
        priorKelSequence: prior.receiptEvidence.kelSequence,
        priorEventSaid: prior.receiptEvidence.currentEventSaid,
      },
    };
    await files.commitProfile(undefined, pending);
    let rotationCalls = 0;
    const infrastructure = recoveredInfrastructure(
      pending,
      pending.receiptEvidence.kelSequence,
      pending.receiptEvidence.currentEventSaid,
      () => {
        rotationCalls += 1;
        return Promise.reject(new Error('an ambiguous rotation must not be submitted again'));
      },
    );
    const application = new UserIdentityApplication(
      configuration(stateDirectory),
      files,
      new IssuerRegistrationHttp('http://issuer.test:3211'),
      {
        generateBran: () => Promise.reject(new Error('must not generate custody')),
        createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
        connectInfrastructure: () => Promise.resolve(infrastructure),
        presentBrowserUrl: () => Promise.resolve(),
        now: () => Date.parse('2025-01-02T00:00:00.000Z'),
        wait: () => Promise.resolve(),
      },
    );

    await expect(application.rotate()).resolves.toEqual({
      kind: 'RecoveryRequired',
      reason: 'IdentityConflict',
    });
    expect(rotationCalls).toBe(0);
    await expect(files.readProfile()).resolves.toEqual(pending);
  });

  it('reuses one durable creation key after an ambiguous Registration Session response', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-registration-retry-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    const current = profile();
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    await files.commitProfile(undefined, current);
    const issuer = await ambiguousCreationIssuer();
    const schemaOobis: string[] = [];
    let clockReads = 0;
    const dependencies: UserIdentityDependencies = {
      generateBran: () => Promise.reject(new Error('must not replace custody')),
      createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
      connectInfrastructure: () =>
        Promise.resolve(
          registrationInfrastructure(current, (schemaOobi) => {
            schemaOobis.push(schemaOobi);
            return Promise.resolve();
          }),
        ),
      presentBrowserUrl: () => Promise.resolve(),
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? 0 : 1_000_000;
      },
      wait: () => Promise.resolve(),
    };
    const application = new UserIdentityApplication(
      {
        ...configuration(stateDirectory),
        issuerUrl: issuer.origin,
        registrationTimeoutMs: 0,
      },
      files,
      new IssuerRegistrationHttp(issuer.origin),
      dependencies,
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'InfrastructureUnavailable',
      dependency: 'Issuer',
    });
    await expect(files.readRegistrationSecrets()).resolves.toEqual({
      version: 1,
      kind: 'registration-create-pending',
      creationKey: `registration_${'r'.repeat(43)}`,
    });

    await expect(application.initialize()).resolves.toMatchObject({
      kind: 'RegistrationRequired',
      browserUrl: `http://site.test/#/registration/${'a'.repeat(32)}?capability=browser_${'b'.repeat(43)}`,
    });
    expect(issuer.creationKeys).toEqual([
      `registration_${'r'.repeat(43)}`,
      `registration_${'r'.repeat(43)}`,
    ]);
    expect(schemaOobis).toEqual([`http://issuer.test:3211/oobi/${expectedSchemaId}`]);
    await expect(files.readRegistrationSecrets()).resolves.toMatchObject({
      kind: 'registration-active',
      registrationId: 'a'.repeat(32),
      proof: {
        kind: 'challenge-response-prepared',
        responseSaid: rotatedEventSaid,
      },
    });
    await expect(files.readProfile()).resolves.toMatchObject({
      registration: { kind: 'registration-pending', registrationId: 'a'.repeat(32) },
    });
  });

  it('does not create a second challenge response after an ambiguous delivery', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-proof-retry-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    const current = profile();
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    await files.commitProfile(undefined, current);
    const issuerOrigin = await pendingRegistrationIssuer();
    let responsePreparations = 0;
    let responseDeliveries = 0;
    const infrastructure: LocalUserInfrastructure = {
      ...registrationInfrastructure(current),
      challengeProof: {
        prepare: () => {
          responsePreparations += 1;
          return Promise.resolve({ responseSaid: challengeResponseSaid(rotatedEventSaid) });
        },
        deliver: () => {
          responseDeliveries += 1;
          if (responseDeliveries === 1) {
            return Promise.reject(
              new IdentityFailure({
                kind: 'keria-unavailable',
                stage: 'challenge response submission',
                reason: 'connection closed after acceptance',
              }),
            );
          }
          return Promise.resolve({ responseSaid: challengeResponseSaid(rotatedEventSaid) });
        },
      },
    };
    const dependencies: UserIdentityDependencies = {
      generateBran: () => Promise.reject(new Error('must not replace custody')),
      createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
      connectInfrastructure: () => Promise.resolve(infrastructure),
      presentBrowserUrl: () => Promise.resolve(),
      now: () => 1_790_220_000_000,
      wait: () => Promise.resolve(),
    };
    const application = new UserIdentityApplication(
      {
        ...configuration(stateDirectory),
        issuerUrl: issuerOrigin,
        registrationTimeoutMs: 0,
      },
      files,
      new IssuerRegistrationHttp(issuerOrigin),
      dependencies,
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'InfrastructureUnavailable',
      dependency: 'Keria',
    });
    await expect(application.initialize()).resolves.toMatchObject({
      kind: 'RegistrationRequired',
    });
    expect(responsePreparations).toBe(1);
    expect(responseDeliveries).toBe(2);
  });

  it('retires an expired resumed Registration Session without replacing local identity', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-registration-expired-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    const current: UserProfile = {
      ...profile(),
      registration: {
        kind: 'registration-pending',
        registrationId: 'a'.repeat(32),
        expiresAt: '2026-09-24T12:05:00.000Z',
      },
    };
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    await files.commitProfile(undefined, current);
    await files.writeRegistrationSecrets({
      version: 1,
      kind: 'registration-active',
      registrationId: 'a'.repeat(32),
      cliCapability: `cli_${'c'.repeat(43)}`,
      browserUrl: `http://site.test/#/registration/${'a'.repeat(32)}?capability=browser_${'b'.repeat(43)}`,
      challengeWords: ['amber', 'cabin', 'delta'],
      issuerAid: expectedIssuerAid,
      issuerOobi: expectedIssuerOobi,
      expiresAt: '2026-09-24T12:05:00.000Z',
      pollIntervalMs: 1_000,
      proof: {
        kind: 'challenge-response-prepared',
        responseSaid: rotatedEventSaid,
        preparedAt: 1_790_220_000_000,
      },
    });
    const issuerOrigin = await expiredRegistrationIssuer();
    const application = new UserIdentityApplication(
      {
        ...configuration(stateDirectory),
        issuerUrl: issuerOrigin,
        registrationTimeoutMs: 0,
      },
      files,
      new IssuerRegistrationHttp(issuerOrigin),
      {
        generateBran: () => Promise.reject(new Error('must not replace custody')),
        createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
        connectInfrastructure: () => Promise.resolve(registrationInfrastructure(current)),
        presentBrowserUrl: () => Promise.resolve(),
        now: () => 1_790_220_000_000,
        wait: () => Promise.resolve(),
      },
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'RegistrationRejected',
      disposition: 'Expired',
    });
    await expect(files.readRegistrationSecrets()).resolves.toBeUndefined();
    await expect(files.readProfile()).resolves.toEqual({
      ...profile(),
      revision: 1,
    });
    await expect(files.readCustody()).resolves.toEqual({
      version: 1,
      bran: '0123456789abcdefghijk',
    });
  });

  it('refuses to persist or present a browser capability for an untrusted site origin', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'devrandom-registration-origin-'));
    directories.push(stateDirectory);
    const files = new IdentityFiles(stateDirectory);
    const current = profile();
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    await files.commitProfile(undefined, current);
    const issuerOrigin = await untrustedBrowserIssuer();
    let presented = false;
    const application = new UserIdentityApplication(
      { ...configuration(stateDirectory), issuerUrl: issuerOrigin },
      files,
      new IssuerRegistrationHttp(issuerOrigin),
      {
        generateBran: () => Promise.reject(new Error('must not replace custody')),
        createRegistrationKey: () => `registration_${'r'.repeat(43)}`,
        connectInfrastructure: () => Promise.resolve(registrationInfrastructure(current)),
        presentBrowserUrl: () => {
          presented = true;
          return Promise.resolve();
        },
        now: () => 1_790_220_000_000,
        wait: () => Promise.resolve(),
      },
    );

    await expect(application.initialize()).resolves.toEqual({
      kind: 'RecoveryRequired',
      reason: 'IdentityConflict',
    });
    expect(presented).toBe(false);
    await expect(files.readRegistrationSecrets()).resolves.toEqual({
      version: 1,
      kind: 'registration-create-pending',
      creationKey: `registration_${'r'.repeat(43)}`,
    });
  });
});
