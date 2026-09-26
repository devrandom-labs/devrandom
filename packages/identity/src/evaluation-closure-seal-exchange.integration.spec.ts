import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  exchange as createUnsignedExchange,
  randomPasscode,
  ready,
  SignifyClient,
  Tier,
} from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  evaluationClosureSealExchangeRoute,
  evaluationClosureSealPayload,
  prepareEvaluationClosure,
} from '@devrandom/protocol';

import {
  connectLocalEvaluationClosureSealExchange,
  evaluationClosureSealExchangeEvidenceSchema,
  matchEvaluationClosureSealExchange,
  signifyIssuerEvaluationClosureSealExchange,
} from './evaluation-closure-seal-exchange.js';
import { issuerAid, personalAgentAid } from './keri-identifier.js';
import { connectSignifyController } from './signify-controller.js';
import { completeSignifyOperation } from './signify-operation.js';

const adminUrl = process.env.DEVRANDOM_KERIA_ADMIN_URL;
const bootUrl = process.env.DEVRANDOM_KERIA_BOOT_URL;
const describeKeria = adminUrl !== undefined && bootUrl !== undefined ? describe : describe.skip;
const agentOobiSchema = Type.Object(
  { role: Type.Literal('agent'), oobis: Type.Array(Type.String(), { minItems: 1 }) },
  { additionalProperties: false },
);
const said = (character: string): string => `E${character.repeat(43)}`;

async function newController(bran: string): Promise<SignifyClient> {
  const client = new SignifyClient(
    adminUrl ?? 'http://127.0.0.1:3901',
    bran,
    Tier.low,
    bootUrl ?? 'http://127.0.0.1:3903',
  );
  const booted = await client.boot();
  if (!booted.ok) throw new Error('KERIA controller boot rejected');
  await client.connect();
  return client;
}

async function createAgentBoundIdentifier(client: SignifyClient, alias: string) {
  const inception = await client.identifiers().create(alias);
  expect(inception.sigs.length).toBeGreaterThan(0);
  await completeSignifyOperation(client, await inception.op(), `${alias} inception`, 60_000);
  const identifier = await client.identifiers().get(alias);
  const agent = client.agent?.pre;
  if (agent === undefined) throw new Error('KERIA agent AID absent');
  const endRole = await client.identifiers().addEndRole(alias, 'agent', agent);
  await completeSignifyOperation(client, await endRole.op(), `${alias} agent end role`, 60_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const untrusted: unknown = await client.oobis().get(alias, 'agent');
      if (Value.Check(agentOobiSchema, untrusted) && untrusted.oobis[0] !== undefined)
        return { aid: identifier.prefix, oobi: untrusted.oobis[0] };
    } catch {
      // KERIA may complete the end-role operation before OOBI visibility.
    }
    await delay(250);
  }
  throw new Error(`${alias} agent OOBI absent`);
}

async function resolve(client: SignifyClient, oobi: string, alias: string): Promise<void> {
  await completeSignifyOperation(client, await client.oobis().resolve(oobi, alias), alias, 60_000);
}

function closureClaim() {
  const prepared = prepareEvaluationClosure({
    evaluationId: randomUUID(),
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    manifestSaid: said('m'),
    evidenceIndexSaid: said('i'),
    acceptedEventCount: 39,
    acceptedHeadSaid: said('h'),
    observationSaids: Array.from({ length: 18 }, (_, index) =>
      said(String.fromCharCode(65 + index)),
    ),
    measurementSaids: Array.from({ length: 15 }, (_, index) =>
      said(String.fromCharCode(97 + index)),
    ),
    sharedAuditSaid: said('s'),
    armAuditSaids: {
      H1: said('1'),
      C1: said('2'),
      C2: said('3'),
      C3: said('4'),
      H1TaskSearch: said('5'),
    },
    protectedCustodySaid: said('p'),
    agentSealSaid: said('g'),
  });
  if (prepared.kind !== 'Prepared') throw new Error('Closure claim fixture rejected');
  return evaluationClosureSealPayload(prepared.closure);
}

describeKeria('real KERIA Evaluation closure exchange custody', () => {
  it('accepts only the recovered personal-agent signed claim materialized to issuer KERIA', async () => {
    await ready();
    const senderBran = randomPasscode();
    const issuerBran = randomPasscode();
    const senderClient = await newController(senderBran);
    const issuerClient = await newController(issuerBran);
    const sender = await createAgentBoundIdentifier(senderClient, 'prd03-closure-agent');
    const recipient = await createAgentBoundIdentifier(issuerClient, 'prd03-closure-issuer');
    await resolve(senderClient, recipient.oobi, 'prd03-closure-issuer');
    await resolve(issuerClient, sender.oobi, 'prd03-closure-agent');

    const recovered = await connectSignifyController({
      adminUrl: adminUrl ?? 'http://127.0.0.1:3901',
      bootUrl: bootUrl ?? 'http://127.0.0.1:3903',
      bran: senderBran,
      securityTier: 'low',
    });
    const sourceAid = personalAgentAid(sender.aid);
    const recipientAid = issuerAid(recipient.aid);
    const local = await connectLocalEvaluationClosureSealExchange({
      adminUrl: adminUrl ?? 'http://127.0.0.1:3901',
      bootUrl: bootUrl ?? 'http://127.0.0.1:3903',
      bran: senderBran,
      securityTier: 'low',
      expectedControllerAid: recovered.controllerAid,
      expectedAgentAid: recovered.agentAid,
    });
    const stable = {
      senderAlias: 'prd03-closure-agent',
      sourceAid,
      recipientAid,
      payload: closureClaim(),
      preparedAt: Date.now(),
    };
    const prepared = await local.prepare(stable);
    const expected = { ...prepared, sourceAid, recipientAid, payload: stable.payload };
    const inspector = signifyIssuerEvaluationClosureSealExchange(issuerClient);
    await expect(inspector.inspect(expected)).resolves.toEqual({ kind: 'Pending' });
    await expect(local.deliver({ ...stable, ...prepared })).resolves.toEqual(prepared);

    let materialized: Awaited<ReturnType<typeof inspector.inspect>> = { kind: 'Pending' };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      materialized = await inspector.inspect(expected);
      if (materialized.kind === 'Verified') break;
      if (materialized.kind !== 'Pending')
        throw new Error(`Exchange rejected: ${materialized.kind}`);
      await delay(500);
    }
    expect(materialized).toMatchObject({
      kind: 'Verified',
      exchangeSaid: prepared.exchangeSaid,
      sourceAid,
      payload: stable.payload,
    });
    const issuerCustody = await issuerClient.exchanges().get(prepared.exchangeSaid);
    const fetched: unknown = issuerCustody.exn;
    if (!Value.Check(evaluationClosureSealExchangeEvidenceSchema, fetched))
      throw new Error('Issuer KERIA returned malformed exchange');
    expect(fetched.d).toBe(prepared.exchangeSaid);
    expect(fetched.i).toBe(sourceAid);
    expect(fetched.rp).toBe(recipientAid);
    expect(
      matchEvaluationClosureSealExchange(
        {
          ...fetched,
          a: { ...fetched.a, claim: { ...stable.payload.claim, acceptedEventCount: 40 } },
        },
        expected,
      ),
    ).toMatchObject({ kind: 'Rejected' });
    await expect(
      inspector.inspect({ ...expected, sourceAid: personalAgentAid(recipient.aid) }),
    ).resolves.toMatchObject({ kind: 'Rejected' });
    await expect(
      inspector.inspect({ ...expected, recipientAid: issuerAid(sender.aid) }),
    ).resolves.toMatchObject({ kind: 'Rejected' });

    const signer = await recovered.client.identifiers().get(stable.senderAlias);
    const datetime = new Date(stable.preparedAt).toISOString().replace('Z', '000+00:00');
    const [, signatures, attachment] = await recovered.client
      .exchanges()
      .createExchangeMessage(
        signer,
        evaluationClosureSealExchangeRoute,
        stable.payload,
        {},
        recipientAid,
        datetime,
      );
    const forgedPayload = {
      ...stable.payload,
      claim: { ...stable.payload.claim, acceptedEventCount: 40 },
    };
    const [forged] = createUnsignedExchange(
      evaluationClosureSealExchangeRoute,
      forgedPayload,
      sourceAid,
      recipientAid,
      datetime,
    );
    expect(forged.said).not.toBe(prepared.exchangeSaid);
    try {
      await recovered.client
        .exchanges()
        .sendFromEvents(
          stable.senderAlias,
          'evaluation-closure-forged-signature',
          forged,
          signatures,
          attachment,
          [recipientAid],
        );
    } catch {
      // KERIA may reject the mismatched EXN signature at POST rather than retrieval.
    }
    await delay(500);
    await expect(
      inspector.inspect({ ...expected, exchangeSaid: forged.said, payload: forgedPayload }),
    ).resolves.toEqual({ kind: 'Pending' });
  }, 240_000);
});
