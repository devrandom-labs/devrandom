import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import {
  harnessCommandFingerprint,
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeHarnessDocument } from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';
import { activationCollectionNames, MongoActivationCommits } from './mongo-activation-commits.js';
import { commitActivation } from '../application/commit-activation.js';
import { activationRoutes } from '../route/activation-routes.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = mongoUri === undefined ? describe.skip : describe;
const said = (character: string): string => `E${character.repeat(43)}`;

describeMongo('atomic activation pointer over replica Mongo', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_activation_${randomUUID().replaceAll('-', '')}`);
  const storage = new MongoActivationCommits(client, database);
  const ownerAid = harnessTask.ownerAid;
  const harnessCommand = baselineHarnessCommandFixture();

  beforeAll(async () => {
    await client.connect();
    const document = encodeHarnessDocument(
      {
        version: 1,
        ownerAid,
        commandId: harnessCommand.commandId,
        acceptedAt: '2026-09-26T06:00:00.000Z',
        revision: harnessCommand.revision,
      },
      harnessCommandFingerprint(harnessCommand),
    );
    await database
      .collection<{ _id: string; activation: unknown }>(harnessRevisionsCollectionName)
      .insertOne({
        ...document,
        activation: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId: harnessCommand.revision.task.harnessLineageId,
          harnessRevisionSaid: harnessCommand.revision.d,
          runId: randomUUID(),
          acceptedAt: new Date('2026-09-26T06:01:00.000Z'),
        },
      });
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('keeps H1 active while receipt is pending, then commits one append-only transition', async () => {
    const selection = preparePromotionSelectionRecord({
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      harnessLineageId: harnessCommand.revision.task.harnessLineageId,
      expectedIncumbentRevisionSaid: harnessCommand.revision.d,
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const prepared = prepareActivationCommitCommand({
      version: 1,
      commandId: randomUUID(),
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 1,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: said('p'),
      governorDecisionExchangeSaid: said('g'),
      selectionRecord: selection.record,
      disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const command = prepared.command;
    const input = { ownerAid, command, recipientAid: said('A') };
    const reserved = await storage.reserve(input);
    expect(reserved.kind).toBe('Reserved');
    const pointerBefore = await database
      .collection<{
        _id: string;
        version: number;
        activeRevisionSaid: string;
        pendingCommandId?: string;
      }>(activationCollectionNames.pointers)
      .findOne({ _id: command.taskId });
    expect(pointerBefore).toMatchObject({
      version: 1,
      activeRevisionSaid: command.expectedIncumbentRevisionSaid,
      pendingCommandId: command.commandId,
    });
    expect(await storage.inspect({ ownerAid, command })).toEqual({ kind: 'Pending' });
    expect(
      await storage.reserve({
        ...input,
        command: { ...command, commandId: randomUUID(), fingerprint: command.fingerprint },
      }),
    ).toEqual({ kind: 'Conflict' });
    const finalized = await storage.finalize({ ...input, receiptSaid: said('R') });
    expect(finalized).toMatchObject({
      kind: 'Committed',
      receipt: {
        activeRevisionSaid: command.expectedIncumbentRevisionSaid,
        pointerVersion: 2,
        decisionReceiptSaid: said('R'),
      },
    });
    const pointerAfter = await database
      .collection<{
        _id: string;
        version: number;
        activeRevisionSaid: string;
        pendingCommandId?: string;
      }>(activationCollectionNames.pointers)
      .findOne({ _id: command.taskId });
    expect(pointerAfter).toMatchObject({
      version: 2,
      activeRevisionSaid: command.expectedIncumbentRevisionSaid,
    });
    expect(pointerAfter?.pendingCommandId).toBeUndefined();
    expect(
      await database
        .collection(activationCollectionNames.transitions)
        .countDocuments({ taskId: command.taskId }),
    ).toBe(1);
    expect(await storage.finalize({ ...input, receiptSaid: said('R') })).toEqual(finalized);
    expect(
      await database
        .collection(activationCollectionNames.transitions)
        .countDocuments({ taskId: command.taskId }),
    ).toBe(1);
    expect(await storage.inspect({ ownerAid, command })).toMatchObject({ kind: 'Committed' });
  });

  it('serves signed-only commit and exact retry through Fastify with the real pointer transaction', async () => {
    const selection = preparePromotionSelectionRecord({
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      harnessLineageId: harnessCommand.revision.task.harnessLineageId,
      expectedIncumbentRevisionSaid: harnessCommand.revision.d,
      expectedPointerVersion: 2,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const prepared = prepareActivationCommitCommand({
      version: 1,
      commandId: randomUUID(),
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 2,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: said('p'),
      governorDecisionExchangeSaid: said('g'),
      selectionRecord: selection.record,
      disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const command = prepared.command;
    const server = Fastify();
    server.register(
      activationRoutes({
        access: { authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid }) },
        activation: {
          commit: (input) =>
            commitActivation(input, {
              authority: {
                verify: () =>
                  Promise.resolve({
                    kind: 'Authorized',
                    personalAgentAid: said('A'),
                    governorAid: said('G'),
                  }),
              },
              storage,
              receipts: {
                sign: () => Promise.resolve({ kind: 'Signed', receiptSaid: said('R') }),
                inspect: () => Promise.resolve('Verified'),
              },
            }),
        },
        now: () => '2026-09-26T10:00:00.000Z',
        newCorrelationId: randomUUID,
      }),
    );
    try {
      const request = {
        method: 'PUT' as const,
        url: `/api/tasks/${command.taskId}/activation`,
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
        payload: command,
      };
      const first = await server.inject(request);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        kind: 'Committed',
        pointerVersion: 3,
        decisionReceiptSaid: said('R'),
      });
      const retry = await server.inject(request);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        kind: 'AlreadyCommitted',
        pointerVersion: 3,
        decisionReceiptSaid: said('R'),
      });
      expect(
        await database
          .collection(activationCollectionNames.transitions)
          .countDocuments({ taskId: command.taskId }),
      ).toBe(2);
    } finally {
      await server.close();
    }
  });
});
