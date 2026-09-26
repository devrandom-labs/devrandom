import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { randomPasscode, ready, SignifyClient, Tier } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  activationReceiptPayload,
  governorPromotionDecisionExchangeRoute,
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
  promotionProposalExchangeRoute,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
} from '@devrandom/protocol';

import { signifyIssuerActivationReceiptExchange } from './activation-receipt-exchange.js';
import { governorAid, issuerAid, personalAgentAid } from './keri-identifier.js';
import {
  signifyLocalPromotionExchanges,
  type StablePromotionExchange,
} from './local-promotion-exchanges.js';
import { GOVERNOR_ALIAS, PERSONAL_AGENT_ALIAS } from './local-principal-custody.js';
import { signifyIssuerPromotionExchanges } from './promotion-exchange-inspection.js';
import { completeSignifyOperation } from './signify-operation.js';

const adminUrl = process.env.DEVRANDOM_KERIA_ADMIN_URL;
const bootUrl = process.env.DEVRANDOM_KERIA_BOOT_URL;
const describeKeria = adminUrl !== undefined && bootUrl !== undefined ? describe : describe.skip;
const agentOobiSchema = Type.Object(
  { role: Type.Literal('agent'), oobis: Type.Array(Type.String(), { minItems: 1 }) },
  { additionalProperties: false },
);
const said = (letter: string): string => `E${letter.repeat(43)}`;

async function controller(): Promise<SignifyClient> {
  const client = new SignifyClient(
    adminUrl ?? 'http://127.0.0.1:3901',
    randomPasscode(),
    Tier.low,
    bootUrl ?? 'http://127.0.0.1:3903',
  );
  const booted = await client.boot();
  if (!booted.ok) throw new Error('KERIA controller boot rejected');
  await client.connect();
  return client;
}

async function identifier(client: SignifyClient, alias: string) {
  const inception = await client.identifiers().create(alias);
  await completeSignifyOperation(client, await inception.op(), `${alias} inception`, 60_000);
  const aid = (await client.identifiers().get(alias)).prefix;
  const agent = client.agent?.pre;
  if (agent === undefined) throw new Error('KERIA agent AID absent');
  const endRole = await client.identifiers().addEndRole(alias, 'agent', agent);
  await completeSignifyOperation(client, await endRole.op(), `${alias} end role`, 60_000);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const found: unknown = await client.oobis().get(alias, 'agent');
      if (Value.Check(agentOobiSchema, found) && found.oobis[0] !== undefined)
        return { aid, oobi: found.oobis[0] };
    } catch {
      // KERIA can report the end role before the agent OOBI is indexed.
    }
    await delay(250);
  }
  throw new Error('agent OOBI absent');
}

async function resolve(client: SignifyClient, oobi: string, alias: string): Promise<void> {
  await completeSignifyOperation(client, await client.oobis().resolve(oobi, alias), alias, 60_000);
}

async function signedExchange(
  client: SignifyClient,
  alias: string,
  recipientAid: string,
  route: string,
  payload: PromotionProposalPayload | GovernorPromotionDecisionPayload,
): Promise<string> {
  const sender = await client.identifiers().get(alias);
  const [message, signatures, attachment] = await client
    .exchanges()
    .createExchangeMessage(sender, route, payload, {}, recipientAid);
  await client
    .exchanges()
    .sendFromEvents(alias, `prd03-${randomUUID()}`, message, signatures, attachment, [
      recipientAid,
    ]);
  return message.said;
}

describeKeria('real KERIA promotion signatures and issuer activation receipt', () => {
  it('delivers exact local personal-agent and distinct Governor EXNs through recovered managed aliases', async () => {
    await ready();
    const localClient = await controller();
    const issuerClient = await controller();
    const localAgent = await identifier(localClient, PERSONAL_AGENT_ALIAS);
    const localGovernor = await identifier(localClient, GOVERNOR_ALIAS);
    const remoteIssuer = await identifier(
      issuerClient,
      `prd03-local-promotion-issuer-${randomUUID()}`,
    );
    await resolve(localClient, remoteIssuer.oobi, 'promotion-issuer');
    await resolve(issuerClient, localAgent.oobi, 'promotion-agent');
    await resolve(issuerClient, localGovernor.oobi, 'promotion-governor');

    const selection = preparePromotionSelectionRecord({
      taskId: randomUUID(),
      taskRevisionSaid: said('t'),
      harnessLineageId: randomUUID(),
      expectedIncumbentRevisionSaid: said('h'),
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const common = {
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 1,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      disposition: { kind: 'RetainIncumbent' as const, selectionEvidenceSaid: selection.record.d },
    };
    const recipientAid = issuerAid(remoteIssuer.aid);
    const proposal = {
      version: 1 as const,
      kind: 'PromotionProposal' as const,
      ...common,
      hypothesisSaid: selection.record.hypothesisSaid,
    };
    const local = signifyLocalPromotionExchanges(localClient);
    const proposalInput = {
      kind: 'Proposal' as const,
      senderAlias: PERSONAL_AGENT_ALIAS,
      sourceAid: personalAgentAid(localAgent.aid),
      recipientAid,
      preparedAt: Date.now(),
      payload: proposal,
    } satisfies StablePromotionExchange;
    const preparedProposal = await local.prepare(proposalInput);
    const deliveredProposal = await local.deliver({ ...proposalInput, ...preparedProposal });
    expect(deliveredProposal.exchangeSaid).toBe(preparedProposal.exchangeSaid);
    const decision = {
      version: 1 as const,
      kind: 'GovernorPromotionDecision' as const,
      ...common,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: deliveredProposal.exchangeSaid,
    };
    const decisionInput = {
      kind: 'GovernorDecision' as const,
      senderAlias: GOVERNOR_ALIAS,
      sourceAid: governorAid(localGovernor.aid),
      recipientAid,
      preparedAt: Date.now(),
      payload: decision,
    } satisfies StablePromotionExchange;
    const preparedDecision = await local.prepare(decisionInput);
    const deliveredDecision = await local.deliver({ ...decisionInput, ...preparedDecision });
    expect(deliveredDecision.exchangeSaid).toBe(preparedDecision.exchangeSaid);
    expect(await local.deliver({ ...decisionInput, ...preparedDecision })).toEqual(
      preparedDecision,
    );

    const expected = {
      proposal: {
        exchangeSaid: deliveredProposal.exchangeSaid,
        sourceAid: proposalInput.sourceAid,
        recipientAid,
        payload: proposal,
      },
      decision: {
        exchangeSaid: deliveredDecision.exchangeSaid,
        sourceAid: decisionInput.sourceAid,
        recipientAid,
        payload: decision,
      },
    };
    const inspector = signifyIssuerPromotionExchanges(issuerClient);
    let inspected: Awaited<ReturnType<typeof inspector.inspect>> = { kind: 'Pending' };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      inspected = await inspector.inspect(expected);
      if (inspected.kind === 'Verified') break;
      if (inspected.kind !== 'Pending') throw new Error(`local EXN rejected: ${inspected.kind}`);
      await delay(500);
    }
    expect(inspected).toMatchObject({
      kind: 'Verified',
      agentAid: proposalInput.sourceAid,
      governorAid: decisionInput.sourceAid,
    });
    await expect(
      inspector.inspect({
        ...expected,
        decision: { ...expected.decision, sourceAid: governorAid(localAgent.aid) },
      }),
    ).resolves.toMatchObject({ kind: 'Rejected' });
  }, 300_000);

  it('verifies distinct signed agent/Governor sources and the exact issuer receipt', async () => {
    await ready();
    const agentClient = await controller();
    const governorClient = await controller();
    const issuerClient = await controller();
    const agentAlias = 'prd03-promotion-agent';
    const governorAlias = 'prd03-promotion-governor';
    const issuerAlias = 'prd03-promotion-issuer';
    const agent = await identifier(agentClient, agentAlias);
    const governor = await identifier(governorClient, governorAlias);
    const issuer = await identifier(issuerClient, issuerAlias);
    await resolve(agentClient, issuer.oobi, issuerAlias);
    await resolve(governorClient, issuer.oobi, issuerAlias);
    await resolve(issuerClient, agent.oobi, agentAlias);
    await resolve(issuerClient, governor.oobi, governorAlias);

    const selection = preparePromotionSelectionRecord({
      taskId: randomUUID(),
      taskRevisionSaid: said('t'),
      harnessLineageId: randomUUID(),
      expectedIncumbentRevisionSaid: said('h'),
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const common = {
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 1,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      disposition: { kind: 'RetainIncumbent' as const, selectionEvidenceSaid: selection.record.d },
    };
    const proposal = {
      version: 1 as const,
      kind: 'PromotionProposal' as const,
      ...common,
      hypothesisSaid: selection.record.hypothesisSaid,
    };
    const agentProposalExchangeSaid = await signedExchange(
      agentClient,
      agentAlias,
      issuer.aid,
      promotionProposalExchangeRoute,
      proposal,
    );
    const decision = {
      version: 1 as const,
      kind: 'GovernorPromotionDecision' as const,
      ...common,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid,
    };
    const governorDecisionExchangeSaid = await signedExchange(
      governorClient,
      governorAlias,
      issuer.aid,
      governorPromotionDecisionExchangeRoute,
      decision,
    );
    const prepared = prepareActivationCommitCommand({
      version: 1,
      commandId: randomUUID(),
      ...common,
      exactPromotionMandateSaid: decision.exactPromotionMandateSaid,
      agentProposalExchangeSaid,
      governorDecisionExchangeSaid,
      selectionRecord: selection.record,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const sourceAid = personalAgentAid(agent.aid);
    const governorSourceAid = governorAid(governor.aid);
    const recipientAid = issuerAid(issuer.aid);
    const expected = {
      proposal: {
        exchangeSaid: agentProposalExchangeSaid,
        sourceAid,
        recipientAid,
        payload: proposal,
      },
      decision: {
        exchangeSaid: governorDecisionExchangeSaid,
        sourceAid: governorSourceAid,
        recipientAid,
        payload: decision,
      },
    };
    const inspector = signifyIssuerPromotionExchanges(issuerClient);
    let inspected: Awaited<ReturnType<typeof inspector.inspect>> = { kind: 'Pending' };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      inspected = await inspector.inspect(expected);
      if (inspected.kind === 'Verified') break;
      if (inspected.kind !== 'Pending') throw new Error(`promotion rejected: ${inspected.kind}`);
      await delay(500);
    }
    expect(inspected).toMatchObject({
      kind: 'Verified',
      agentAid: sourceAid,
      governorAid: governorSourceAid,
    });
    await expect(
      inspector.inspect({
        ...expected,
        proposal: { ...expected.proposal, sourceAid: personalAgentAid(governor.aid) },
      }),
    ).resolves.toMatchObject({ kind: 'Rejected' });

    const payload = activationReceiptPayload(prepared.command);
    const receipts = signifyIssuerActivationReceiptExchange(issuerClient);
    const receiptInput = {
      senderAlias: issuerAlias,
      sourceAid: recipientAid,
      recipientAid: sourceAid,
      payload,
      preparedAt: Date.now(),
    };
    let receipt: Awaited<ReturnType<typeof receipts.sign>> = { kind: 'Pending' };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      receipt = await receipts.sign(receiptInput);
      if (receipt.kind === 'Verified') break;
      if (receipt.kind !== 'Pending') throw new Error(`issuer receipt rejected: ${receipt.kind}`);
      await delay(500);
    }
    expect(receipt.kind).toBe('Verified');
    if (receipt.kind !== 'Verified') return;
    await expect(
      receipts.inspect({
        exchangeSaid: receipt.exchangeSaid,
        sourceAid: recipientAid,
        recipientAid: sourceAid,
        payload,
      }),
    ).resolves.toMatchObject({ kind: 'Verified', exchangeSaid: receipt.exchangeSaid });
    await expect(
      receipts.inspect({
        exchangeSaid: receipt.exchangeSaid,
        sourceAid: recipientAid,
        recipientAid: sourceAid,
        payload: { ...payload, pointerVersion: 3 },
      }),
    ).resolves.toMatchObject({ kind: 'Rejected' });
  }, 300_000);
});
