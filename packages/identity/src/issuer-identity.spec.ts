import {
  credentialSchema,
  taskMandateV3Schema,
  promotionMandateV4Schema,
  promotionMandateV5Schema,
} from '@devrandom/protocol';
import { ready, SignifyClient, Tier } from 'signify-ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as registry from './credential-registry.js';
import { connectVerifiedIssuerInfrastructure } from './issuer-identity.js';
import * as identifiers from './keri-identifier.js';
import * as controller from './signify-controller.js';

beforeAll(ready);
afterEach(() => vi.restoreAllMocks());

describe('issuer immutable mandate schema capabilities', () => {
  it('verifies each new schema independently and rejects substituted schema documents', async () => {
    const client = new SignifyClient('http://keria.invalid', '0123456789abcdefghijk', Tier.low);
    const controllerAid = identifiers.controllerAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
    const agentAid = identifiers.agentAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
    const issuerAid = identifiers.issuerAid('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao');
    const registryId = identifiers.credentialRegistryId(issuerAid);
    vi.spyOn(controller, 'connectSignifyController').mockResolvedValue({
      client,
      controllerAid,
      agentAid,
      connection: 'existing-controller-connected',
    });
    vi.spyOn(identifiers, 'verifyNamedKeriIdentifier').mockResolvedValue({
      alias: 'issuer',
      aid: issuerAid,
    });
    vi.spyOn(registry, 'verifyNamedCredentialRegistry').mockResolvedValue({
      name: 'users',
      id: registryId,
      issuerAid,
    });
    const oobis = client.oobis();
    vi.spyOn(client, 'oobis').mockReturnValue(oobis);
    vi.spyOn(oobis, 'endroles').mockResolvedValue([
      { cid: issuerAid, role: 'agent', eid: agentAid },
    ]);
    let responseSchema: unknown = credentialSchema;
    vi.spyOn(client, 'fetch').mockImplementation((path) =>
      Promise.resolve(
        Response.json(
          path === '/identifiers/issuer/oobis?role=agent'
            ? { role: 'agent', oobis: [`http://issuer.test/oobi/${issuerAid}/agent/${agentAid}`] }
            : responseSchema,
        ),
      ),
    );
    vi.spyOn(oobis, 'resolve').mockResolvedValue({
      name: 'oobi.fixture',
      done: false,
      metadata: { oobi: 'http://issuer.test' },
    });
    const operations = client.operations();
    vi.spyOn(client, 'operations').mockReturnValue(operations);
    vi.spyOn(operations, 'get').mockResolvedValue({
      name: 'oobi.fixture',
      done: true,
      response: {},
    });
    vi.spyOn(operations, 'wait').mockResolvedValue({
      name: 'oobi.fixture',
      done: true,
      response: {},
    });
    vi.spyOn(operations, 'delete').mockResolvedValue(undefined);
    const schemas = client.schemas();
    vi.spyOn(client, 'schemas').mockReturnValue(schemas);
    const get = vi.spyOn(schemas, 'get');
    const infrastructure = await connectVerifiedIssuerInfrastructure(
      {
        adminUrl: 'http://keria.invalid',
        bootUrl: 'http://keria.invalid',
        bran: '0123456789abcdefghijk',
        securityTier: 'low',
        issuerAlias: 'issuer',
        registryName: 'users',
        witnessPolicy: { kind: 'unwitnessed' },
        registryPolicy: { kind: 'backerless' },
        operationTimeoutMs: 100,
        oobiAvailabilityTimeoutMs: 100,
      },
      credentialSchema,
    );
    for (const [availability, schema] of [
      [infrastructure.taskMandateV3SchemaAvailability, taskMandateV3Schema],
      [infrastructure.promotionMandateV4SchemaAvailability, promotionMandateV4Schema],
      [infrastructure.promotionMandateV5SchemaAvailability, promotionMandateV5Schema],
    ] as const) {
      expect(availability).toBeDefined();
      responseSchema = schema;
      await expect(availability.verify()).resolves.toBeUndefined();
      expect(get).toHaveBeenLastCalledWith(schema.$id);
      responseSchema = credentialSchema;
      await expect(availability.verify()).rejects.toThrow('exact credential schema');
      responseSchema = { ...schema, title: 'Substituted' };
      await expect(availability.verify()).rejects.toThrow('not bound by its SAID');
    }
  });
});
