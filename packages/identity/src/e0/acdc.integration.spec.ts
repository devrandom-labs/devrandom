import {
  credentialCapabilities,
  credentialSchema,
  type CredentialCapability,
} from '@devrandom/protocol';
import {
  randomPasscode,
  ready,
  Serder,
  SignifyClient,
  Tier,
  type CredentialResult,
} from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { verifyNamedCredentialRegistry } from '../credential-registry.js';
import { issueCredential, verifyCredential, type CredentialExpectation } from '../credential.js';
import {
  credentialSchemaId,
  issuerAid,
  userAid,
  verifyNamedKeriIdentifier,
  type UserAid,
} from '../keri-identifier.js';
import { connectSignifyController } from '../signify-controller.js';
import { completeSignifyOperation } from '../signify-operation.js';

const keriaAdminUrl = process.env.DEVRANDOM_KERIA_ADMIN_URL;
const keriaBootUrl = process.env.DEVRANDOM_KERIA_BOOT_URL;
const issuerBran = process.env.DEVRANDOM_ISSUER_BRAN;
const credentialSchemaOobiUrl = process.env.DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL;
const liveCredentialStackConfigured =
  keriaAdminUrl !== undefined &&
  keriaBootUrl !== undefined &&
  issuerBran !== undefined &&
  credentialSchemaOobiUrl !== undefined;
const describeWithCredentialStack = liveCredentialStackConfigured ? describe : describe.skip;

const issuerAlias = 'devrandom-issuer';
const registryName = 'devrandom-credentials';
const operationTimeoutMs = 30_000;
const credentialSchemaSaid = credentialSchemaId(credentialSchema.$id);

interface TestUser {
  readonly alias: string;
  readonly aid: UserAid;
  readonly agentOobi: string;
}

interface GrantNotification {
  readonly id: string;
  readonly grantSaid: string;
}

const notificationPageSchema = Type.Object(
  {
    notes: Type.Array(
      Type.Object(
        {
          i: Type.String({ minLength: 1 }),
          r: Type.Boolean(),
          a: Type.Object(
            {
              r: Type.String({ minLength: 1 }),
              d: Type.String({ minLength: 1 }),
            },
            { additionalProperties: true },
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const agentOobiSchema = Type.Object(
  {
    role: Type.Literal('agent'),
    oobis: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 1 }),
  },
  { additionalProperties: false },
);

async function createClient(): Promise<SignifyClient> {
  const client = new SignifyClient(
    keriaAdminUrl ?? 'http://127.0.0.1:3901',
    randomPasscode(),
    Tier.low,
    keriaBootUrl ?? 'http://127.0.0.1:3903',
  );
  const bootResponse = await client.boot();
  if (!bootResponse.ok) {
    throw new Error('KERIA rejected user client boot');
  }
  await client.connect();
  return client;
}

async function availableAgentOobi(client: SignifyClient, alias: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const untrusted: unknown = await client.oobis().get(alias, 'agent');
      if (Value.Check(agentOobiSchema, untrusted)) {
        const oobi = untrusted.oobis[0];
        if (oobi !== undefined) {
          return oobi;
        }
      }
    } catch {
      // The end-role operation can complete before its OOBI is query-visible.
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${alias} did not publish one agent OOBI`);
}

async function createUser(client: SignifyClient, alias: string): Promise<TestUser> {
  const inception = await client.identifiers().create(alias);
  if (inception.sigs.length === 0) {
    throw new Error('user inception was not signed at the edge');
  }
  await completeSignifyOperation(
    client,
    await inception.op(),
    'user AID inception',
    operationTimeoutMs,
  );

  const identifier = await client.identifiers().get(alias);
  const agent = client.agent?.pre;
  if (agent === undefined) {
    throw new Error('connected user client has no agent AID');
  }
  const endRole = await client.identifiers().addEndRole(alias, 'agent', agent);
  await completeSignifyOperation(
    client,
    await endRole.op(),
    'user agent end role',
    operationTimeoutMs,
  );

  return {
    alias,
    aid: userAid(identifier.prefix),
    agentOobi: await availableAgentOobi(client, alias),
  };
}

async function resolveOobi(client: SignifyClient, oobi: string, alias: string): Promise<void> {
  await completeSignifyOperation(
    client,
    await client.oobis().resolve(oobi, alias),
    `resolve ${alias}`,
    operationTimeoutMs,
  );
}

async function waitForGrant(client: SignifyClient): Promise<GrantNotification> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const untrusted: unknown = await client.notifications().list();
    if (!Value.Check(notificationPageSchema, untrusted)) {
      throw new Error('KERIA returned an invalid notification page');
    }
    const notification = untrusted.notes.find((note) => note.a.r === '/exn/ipex/grant' && !note.r);
    if (notification !== undefined) {
      return { id: notification.i, grantSaid: notification.a.d };
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('user did not receive the IPEX grant notification');
}

async function waitForCredential(client: SignifyClient, said: string): Promise<CredentialResult> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await client.credentials().get(said);
    } catch {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`credential ${said} was not available to the user`);
}

async function persistentIssuer() {
  const controller = await connectSignifyController({
    adminUrl: keriaAdminUrl ?? 'http://127.0.0.1:3901',
    bootUrl: keriaBootUrl ?? 'http://127.0.0.1:3903',
    bran: issuerBran ?? '',
    securityTier: 'low',
  });
  const identifier = await verifyNamedKeriIdentifier(controller.client, issuerAlias, {
    kind: 'unwitnessed',
  });
  const registry = await verifyNamedCredentialRegistry(
    controller.client,
    issuerAlias,
    identifier.aid,
    registryName,
    { kind: 'backerless' },
  );
  const untrustedOobi: unknown = await controller.client.oobis().get(issuerAlias, 'agent');
  if (!Value.Check(agentOobiSchema, untrustedOobi)) {
    throw new Error('persistent issuer did not return one agent OOBI');
  }
  const oobi = untrustedOobi.oobis[0];
  if (oobi === undefined) {
    throw new Error('persistent issuer agent OOBI disappeared');
  }
  return { client: controller.client, aid: identifier.aid, registry: registry.id, oobi };
}

describeWithCredentialStack('E0 Devrandom Credential contract', () => {
  it('uses the persistent issuer and locally verifies the user credential evidence', async () => {
    await ready();
    const issuer = await persistentIssuer();
    const userClient = await createClient();
    const user = await createUser(userClient, 'devrandom-e0-user');

    await Promise.all([
      resolveOobi(issuer.client, user.agentOobi, 'user'),
      resolveOobi(userClient, issuer.oobi, 'issuer'),
      resolveOobi(issuer.client, credentialSchemaOobiUrl ?? '', 'devrandom-credential-schema'),
      resolveOobi(userClient, credentialSchemaOobiUrl ?? '', 'devrandom-credential-schema'),
    ]);

    const issued = await issueCredential(issuer.client, {
      issuerAlias,
      issuerAid: issuer.aid,
      issueeAid: user.aid,
      registryId: issuer.registry,
      schemaId: credentialSchemaSaid,
      payloadSchema: credentialSchema,
      claims: {
        capabilities: [...credentialCapabilities] satisfies CredentialCapability[],
      },
      operationTimeoutMs,
    });

    const [grant, grantSignatures, grantAttachment] = await issuer.client.ipex().grant({
      senderName: issuerAlias,
      acdc: new Serder(issued.record.sad),
      anc: new Serder(issued.record.anc),
      iss: new Serder(issued.record.iss),
      ancAttachment: issued.record.ancatc,
      recipient: user.aid,
    });
    const grantOperation = await issuer.client
      .ipex()
      .submitGrant(issuerAlias, grant, grantSignatures, grantAttachment, [user.aid]);
    await completeSignifyOperation(
      issuer.client,
      grantOperation,
      'issuer IPEX grant',
      operationTimeoutMs,
    );

    const grantNotification = await waitForGrant(userClient);
    const [admit, admitSignatures, admitAttachment] = await userClient.ipex().admit({
      senderName: user.alias,
      message: '',
      grantSaid: grantNotification.grantSaid,
      recipient: issuer.aid,
    });
    const admitOperation = await userClient
      .ipex()
      .submitAdmit(user.alias, admit, admitSignatures, admitAttachment, [issuer.aid]);
    await completeSignifyOperation(
      userClient,
      admitOperation,
      'user IPEX admit',
      operationTimeoutMs,
    );
    await userClient.notifications().mark(grantNotification.id);
    await userClient.notifications().delete(grantNotification.id);

    await waitForCredential(userClient, issued.credentialSaid);
    const expected = {
      issuerAid: issuer.aid,
      issueeAid: user.aid,
      registryId: issuer.registry,
      schemaId: credentialSchemaSaid,
      payloadSchema: credentialSchema,
    } satisfies CredentialExpectation<typeof credentialSchema>;
    const verified = await verifyCredential(userClient, issued.credentialSaid, expected);
    expect(verified.credentialSaid).toBe(issued.credentialSaid);
    expect(verified.payload.a.capabilities).toEqual(credentialCapabilities);

    await expect(
      verifyCredential(userClient, issued.credentialSaid, {
        ...expected,
        issuerAid: issuerAid(user.aid),
      }),
    ).rejects.toThrow('credential issuer does not match expected state');
  }, 180_000);
});
