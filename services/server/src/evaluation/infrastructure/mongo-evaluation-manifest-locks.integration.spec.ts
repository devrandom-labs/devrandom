import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  prepareEvaluationEvidenceBatch,
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  evaluationManifestLockReceiptSchema,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import { HostedEvaluationProtectedArtifacts } from '../../../../../apps/cli/src/harness/infrastructure/hosted-evaluation-protected-artifacts.js';
import { ServerEvaluationHttp } from '../../../../../apps/cli/src/harness/infrastructure/server-evaluation-http.js';
import { SqliteEvaluationEvidenceOutbox } from '../../../../../apps/cli/src/harness/infrastructure/sqlite-evaluation-evidence-outbox.js';
import { decodeDevrandomServerOrigin } from '../../../../../apps/cli/src/infrastructure/devrandom-server-http.js';

import {
  lockEvaluationManifest,
  inspectEvaluationManifest,
} from '../application/lock-evaluation-manifest.js';
import { acceptEvaluationEvidence } from '../application/accept-evaluation-evidence.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import type { EvidenceUsageDocument } from '../../evidence/infrastructure/evidence-usage-document.js';
import { MongoEvaluationBootstrap } from './mongo-evaluation-bootstrap.js';
import { MongoEvaluationEvidence } from './mongo-evaluation-evidence.js';
import {
  MongoEvaluationManifestLocks,
  type EvaluationManifestLockDocument,
} from './mongo-evaluation-manifest-locks.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = mongoUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const agentAid = said('a');
const allocation = {
  providerRequests: 1,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 1,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 20_000,
};

function fixture() {
  const evaluationId = randomUUID();
  const taskId = randomUUID();
  const originRunId = randomUUID();
  const leaseId = randomUUID();
  const now = new Date();
  const artifact = (
    purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
    objectSaid: string,
    segment: number,
    byte: number,
  ) => {
    const prepared = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose,
      segment,
      nonce: Buffer.alloc(12, byte).toString('base64url'),
      tag: Buffer.alloc(16, byte).toString('base64url'),
      ciphertext: Buffer.from([byte]).toString('base64url'),
      plaintextByteCount: 1,
    });
    if (prepared.kind !== 'Prepared') throw new Error('protected fixture invalid');
    return prepared.artifact;
  };
  const trialObject = said('q');
  const terminalObject = said('r');
  const protectedArtifacts = [
    artifact('TrialHoldout', trialObject, 0, 1),
    artifact('OracleObservation', trialObject, 0, 2),
    artifact('TerminalCase', terminalObject, 1, 3),
    artifact('OracleObservation', terminalObject, 1, 4),
  ] as const;
  const verifier = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid,
    personalAgentAid: agentAid,
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
    reviewedRecipeSaid: said('w'),
    toolchainSaid: said('u'),
    publicConditions: ['cesr-current', 'cesr-tamper', 'cesr-legacy'].map((id) => ({
      id,
      stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
      expected:
        id === 'cesr-tamper'
          ? { kind: 'Rejected' as const, error: 'AnyRejection' as const }
          : {
              kind: 'Parsed' as const,
              receipts: [{ version: 'Current' as const, payload: said('x') }],
            },
    })),
    protectedCase: {
      objectSaid: trialObject,
      stimulus: protectedArtifacts[0],
      expected: protectedArtifacts[1],
    },
    terminalCase: {
      objectSaid: terminalObject,
      stimulus: protectedArtifacts[2],
      expected: protectedArtifacts[3],
    },
  });
  if (verifier.kind !== 'Prepared') throw new Error('verifier fixture invalid');
  const encoded = encodeEvaluationVerifierBundle(verifier.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('verifier encoding invalid');
  const manifestInput = {
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    ownerAid,
    personalAgentAid: agentAid,
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('1'), C2: said('2'), C3: said('3') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('H'),
    verifierSaid: verifier.bundle.d,
    protectedCaseArtifactSaid: protectedArtifacts[0].d,
    finalCaseArtifactSaid: protectedArtifacts[2].d,
    publicConditionIds: ['cesr-current', 'cesr-tamper', 'cesr-legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allocation, perEntry: allocation, finalization: allocation },
  };
  const manifest = prepareEvaluationManifest(manifestInput);
  if (manifest.kind !== 'Prepared') throw new Error('manifest fixture invalid');
  const command = {
    version: 1 as const,
    commandId: randomUUID(),
    fingerprint: `sha256:${'f'.repeat(64)}`,
    expectedEvaluationVersion: 1,
    leaseId,
    manifest: manifest.manifest,
    verifierBundle: verifier.bundle,
    verifierBundleBytesBase64Url: Buffer.from(encoded.bytes).toString('base64url'),
    protectedArtifacts: [...protectedArtifacts],
  };
  const record: EvaluationDocument = {
    _id: evaluationId,
    ownerAid,
    command: {
      version: 1,
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      taskId,
      taskRevisionSaid: said('t'),
      originRunId,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      expectedActiveRevisionSaid: said('h'),
      personalAgentAid: agentAid,
      taskMandateSaid: said('m'),
      policySaid: said('p'),
      executionProfileSaid: said('e'),
      sourceInventorySaid: said('i'),
      allocation: manifestInput.allocation,
    },
    reserved: { ...allocation, evidencePlusArtifactsPerRunBytes: 20_000 },
    reservationSaid: said('r'),
    evidenceStreamId: randomUUID(),
    version: 1,
    lease: {
      evaluationId,
      leaseId,
      version: 1,
      serverTime: now.toISOString(),
      expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
    },
    acceptedThroughSequence: -1,
    chainHeadSaid: null,
    acceptedBytes: 0,
    activeOwnerSlot: ownerAid,
    acceptedAt: now,
  };
  return { evaluationId, command, record, manifestInput, protectedArtifacts, encoded };
}

describeMongo('immutable Evaluation M over listening Fastify and replica Mongo', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_manifest_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify();
  let address: string;
  const stateRoots: string[] = [];

  beforeAll(async () => {
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    await database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage).insertOne({
      _id: evidenceUsageDocumentId,
      version: 0,
      acceptedBytes: 0,
    });
    const locks = new MongoEvaluationManifestLocks(client, database);
    const batches = new MongoEvaluationEvidence(client, database);
    const authority = {
      inspect: () =>
        Promise.resolve({
          kind: 'Authorized' as const,
          taskRevisionSaid: said('t'),
          personalAgentAid: agentAid,
          taskMandateSaid: said('m'),
        }),
    };
    server.register(
      evaluationRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve(
              bearerSecret === 'b'.repeat(43)
                ? { kind: 'Authorized' as const, ownerAid }
                : { kind: 'Denied' as const },
            ),
        },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: {
          lock: (request) => lockEvaluationManifest(request, { authority, locks }),
          inspect: (request) => inspectEvaluationManifest(request, { authority, locks }),
        },
        evidence: {
          accept: (request) => acceptEvaluationEvidence(request, { batches }),
          close: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        now: () => new Date().toISOString(),
        newCorrelationId: randomUUID,
      }),
    );
    address = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await database.dropDatabase();
    await client.close();
    for (const root of stateRoots) rmSync(root, { recursive: true, force: true });
  });

  async function put(evaluationId: string, command: unknown, bearer = 'b'.repeat(43)) {
    return fetch(`${address}/api/evaluations/${evaluationId}/manifest`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
  }

  it('retains exact M, raw verifier bytes, and four ciphertexts atomically, then reconciles same-M retry', async () => {
    const fixtureValue = fixture();
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(fixtureValue.record);
    const first = await put(fixtureValue.evaluationId, fixtureValue.command);
    expect(first.status).toBe(201);
    const receipt: unknown = await first.json();
    if (!Value.Check(evaluationManifestLockReceiptSchema, receipt))
      throw new Error('manifest receipt invalid');
    expect(receipt).toMatchObject({
      kind: 'Locked',
      evaluationId: fixtureValue.evaluationId,
      manifestSaid: fixtureValue.command.manifest.d,
      ownerAid,
      policySaid: said('p'),
      leaseId: fixtureValue.command.leaseId,
      lockedAtLeaseVersion: 1,
      lockedAtEvaluationVersion: 2,
      currentLeaseVersion: 1,
      currentEvaluationVersion: 2,
    });
    const stored = await database
      .collection<EvaluationManifestLockDocument>(evaluationCollectionNames.manifests)
      .findOne({ _id: fixtureValue.evaluationId });
    if (stored === null) throw new Error('committed M missing');
    expect(Buffer.from(stored.verifierBytes.buffer)).toEqual(
      Buffer.from(fixtureValue.encoded.bytes),
    );
    expect(stored.manifest).toEqual(fixtureValue.command.manifest);
    expect(JSON.stringify(stored)).not.toContain('hidden plaintext');
    const artifacts = await database
      .collection<{ _id: string; evaluationId: string; custody: string; bytes?: unknown }>(
        evaluationCollectionNames.artifacts,
      )
      .find({ evaluationId: fixtureValue.evaluationId })
      .toArray();
    expect(artifacts).toHaveLength(4);
    expect(
      artifacts.every(
        (artifact) => artifact.custody === 'ProtectedCiphertext' && artifact.bytes === undefined,
      ),
    ).toBe(true);
    const accepted = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: fixtureValue.evaluationId });
    expect(accepted?.version).toBe(2);
    expect(accepted?.acceptedBytes).toBe(fixtureValue.encoded.bytes.byteLength + 4);

    const retry = await put(fixtureValue.evaluationId, {
      ...fixtureValue.command,
      commandId: randomUUID(),
      expectedEvaluationVersion: 1,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ...receipt, kind: 'AlreadyLocked' });
    const inspected = await fetch(
      `${address}/api/evaluations/${fixtureValue.evaluationId}/manifest/${fixtureValue.command.manifest.d}`,
      {
        headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      },
    );
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toEqual(receipt);
    const sourceBytes = new TextEncoder().encode('{"src/lib.rs":"frozen"}');
    const source = prepareEvidenceArtifact(sourceBytes, 'application/json');
    if (source.kind !== 'Prepared') throw new Error('source artifact invalid');
    const trialEvent = prepareEvaluationEvidenceEvent({
      evaluationId: fixtureValue.evaluationId,
      streamId: fixtureValue.record.evidenceStreamId,
      originRunId: fixtureValue.record.command.originRunId,
      taskId: fixtureValue.record.command.taskId,
      taskRevisionSaid: fixtureValue.record.command.taskRevisionSaid,
      personalAgentAid: agentAid,
      taskMandateSaid: said('m'),
      harnessRevisionSaid: fixtureValue.command.manifest.revisions.H1,
      phase: {
        kind: 'Trial',
        manifestSaid: fixtureValue.command.manifest.d,
        arm: 'H1',
        repetition: 1,
        attempt: 1,
      },
      sequence: 0,
      previous: { kind: 'Genesis' },
      occurredAt: '2026-09-26T05:00:00.000Z',
      detail: {
        kind: 'SourceRead',
        sourceSaid: source.artifact.d,
        rawArtifactSaid: source.artifact.d,
      },
    });
    if (trialEvent.kind !== 'Prepared') throw new Error('trial event invalid');
    const batch = prepareEvaluationEvidenceBatch([trialEvent.event]);
    if (batch.kind !== 'Prepared') throw new Error('trial batch invalid');
    const trial = await fetch(`${address}/api/evaluations/${fixtureValue.evaluationId}/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'b'.repeat(43)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        commandId: randomUUID(),
        fingerprint: `sha256:${'f'.repeat(64)}`,
        batch: batch.batch,
        events: [trialEvent.event],
        publicArtifacts: [
          {
            artifact: source.artifact,
            bytesBase64Url: Buffer.from(sourceBytes).toString('base64url'),
          },
        ],
        protectedArtifacts: [],
      }),
    });
    expect(trial.status).toBe(201);
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: fixtureValue.evaluationId }, { $inc: { version: 1, 'lease.version': 1 } });
    const afterRenewal = await fetch(
      `${address}/api/evaluations/${fixtureValue.evaluationId}/manifest/${fixtureValue.command.manifest.d}`,
      {
        headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      },
    );
    expect(afterRenewal.status).toBe(200);
    expect(await afterRenewal.json()).toEqual({
      ...receipt,
      currentLeaseVersion: 2,
      currentEvaluationVersion: 4,
    });
    expect(
      await database
        .collection<EvaluationManifestLockDocument>(evaluationCollectionNames.manifests)
        .countDocuments({ _id: fixtureValue.evaluationId }),
    ).toBe(1);
    expect(
      await database
        .collection(evaluationCollectionNames.artifacts)
        .countDocuments({ evaluationId: fixtureValue.evaluationId }),
    ).toBe(5);
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: fixtureValue.evaluationId }, { $unset: { activeOwnerSlot: '' } });
  });

  it('reconciles lost protected observation ACK through real localhost HTTP and replica Mongo', async () => {
    const given = fixture();
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(given.record);
    expect((await put(given.evaluationId, given.command)).status).toBe(201);
    const origin = decodeDevrandomServerOrigin(address);
    if (origin.kind !== 'Accepted') throw new Error('listening origin rejected');
    const http = new ServerEvaluationHttp(origin.origin, 'b'.repeat(43), fetch);
    const stateRoot = mkdtempSync(join(tmpdir(), 'devrandom-protected-http-'));
    stateRoots.push(stateRoot);
    const opening = SqliteEvaluationEvidenceOutbox.open(stateRoot, {
      ownerAid,
      evaluationId: given.evaluationId,
      streamId: given.record.evidenceStreamId,
      originRunId: given.record.command.originRunId,
      taskId: given.record.command.taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: agentAid,
      taskMandateSaid: said('m'),
    });
    if (opening.kind !== 'Opened') throw new Error('private outbox rejected');
    const outbox = opening.outbox;
    const phase = {
      kind: 'Trial' as const,
      manifestSaid: given.command.manifest.d,
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    };
    const stopped = prepareEvaluationEvidenceEvent({
      evaluationId: given.evaluationId,
      streamId: given.record.evidenceStreamId,
      originRunId: given.record.command.originRunId,
      taskId: given.record.command.taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: agentAid,
      taskMandateSaid: said('m'),
      harnessRevisionSaid: given.command.manifest.revisions.H1,
      phase,
      sequence: 0,
      previous: { kind: 'Genesis' },
      occurredAt: '2026-09-26T06:00:01.000Z',
      detail: { kind: 'TrialStopped', reason: 'Completed' },
    });
    if (stopped.kind !== 'Prepared') throw new Error('stopped event rejected');
    expect(
      outbox.stage({
        commandId: randomUUID(),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        events: [stopped.event],
        publicArtifacts: [],
        protectedArtifacts: [],
      }).kind,
    ).toBe('Staged');
    const pending = outbox.pending();
    if (pending.kind !== 'Pending') throw new Error('stopped batch missing');
    const initial = await http.appendEvidence(pending.upload);
    if (initial.kind !== 'Acknowledged') throw new Error(`stopped batch ${initial.kind}`);
    expect(outbox.acknowledge(initial.acknowledgement).kind).toBe('Recorded');

    const protectedCase = given.command.verifierBundle.protectedCase;
    const observation = prepareProtectedEvaluationArtifact({
      evaluationId: given.evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'OracleObservation',
      segment: 0,
      nonce: Buffer.alloc(12, 9).toString('base64url'),
      tag: Buffer.alloc(16, 9).toString('base64url'),
      ciphertext: Buffer.from([9]).toString('base64url'),
      plaintextByteCount: 1,
    });
    if (observation.kind !== 'Prepared') throw new Error('observation artifact rejected');
    let loseReply = true;
    const captureStatuses: number[] = [];
    const lossyHttp = new ServerEvaluationHttp(origin.origin, 'b'.repeat(43), async (url, init) => {
      const response = await fetch(url, init);
      const path =
        typeof url === 'string'
          ? new URL(url).pathname
          : url instanceof URL
            ? url.pathname
            : new URL(url.url).pathname;
      if (init?.method === 'POST' && path.endsWith('/batches'))
        captureStatuses.push(response.status);
      if (loseReply && init?.method === 'POST' && path.endsWith('/batches')) {
        loseReply = false;
        throw new Error('simulated response loss after Mongo commit');
      }
      return response;
    });
    const adapter = new HostedEvaluationProtectedArtifacts(
      lossyHttp,
      { open: () => Promise.resolve({ kind: 'Opened', bytes: given.encoded.bytes }) },
      outbox,
      () => '2026-09-26T06:00:02.000Z',
    );
    const input = {
      binding: {
        kind: 'Evaluation' as const,
        evaluationId: given.evaluationId,
        taskId: given.record.command.taskId,
        taskRevisionSaid: said('t'),
        originRunId: given.record.command.originRunId,
        personalAgentAid: agentAid,
        taskMandateSaid: said('m'),
        harnessRevisionSaid: given.command.manifest.revisions.H1,
        evaluationLeaseId: given.record.lease.leaseId,
        evidenceStreamId: given.record.evidenceStreamId,
        phase,
      },
      manifest: given.command.manifest,
      lease: given.record.lease,
      expectedHeadSaid: stopped.event.d,
      artifacts: [protectedCase.stimulus, protectedCase.expected, observation.artifact] as const,
    };
    expect(await adapter.retain(input)).toEqual({ kind: 'Unavailable' });
    expect(outbox.pending().kind).toBe('Pending');
    expect(
      await database.collection(evaluationCollectionNames.artifacts).countDocuments({
        evaluationId: given.evaluationId,
      }),
    ).toBe(5);
    const retained = await adapter.retain(input);
    expect(retained).toMatchObject({
      kind: 'Acknowledged',
      artifactSaids: [protectedCase.stimulus.d, protectedCase.expected.d, observation.artifact.d],
      throughSequence: 1,
    });
    expect(captureStatuses).toEqual([201, 200]);
    expect(outbox.pending()).toEqual({ kind: 'Empty' });
    expect(
      await database.collection(evaluationCollectionNames.batches).countDocuments({
        evaluationId: given.evaluationId,
      }),
    ).toBe(2);
    expect(
      await database.collection(evaluationCollectionNames.artifacts).countDocuments({
        evaluationId: given.evaluationId,
      }),
    ).toBe(5);
    outbox.close();
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: given.evaluationId }, { $unset: { activeOwnerSlot: '' } });
  });

  it('rejects substituted M, absent ciphertext, wrong lease, and expired lease without retaining custody', async () => {
    const changed = fixture();
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(changed.record);
    const altered = prepareEvaluationManifest({
      ...changed.manifestInput,
      revisions: { ...changed.manifestInput.revisions, H1: said('z') },
    });
    if (altered.kind !== 'Prepared') throw new Error('altered manifest fixture invalid');
    expect(
      (await put(changed.evaluationId, { ...changed.command, manifest: altered.manifest })).status,
    ).toBe(409);
    expect(
      (
        await put(changed.evaluationId, {
          ...changed.command,
          protectedArtifacts: changed.command.protectedArtifacts.slice(0, 3),
        })
      ).status,
    ).toBe(400);
    expect(
      (await put(changed.evaluationId, { ...changed.command, leaseId: randomUUID() })).status,
    ).toBe(409);
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne(
        { _id: changed.evaluationId },
        { $set: { 'lease.expiresAt': new Date(Date.now() - 1_000).toISOString() } },
      );
    expect((await put(changed.evaluationId, changed.command)).status).toBe(409);
    expect(
      await database
        .collection<EvaluationManifestLockDocument>(evaluationCollectionNames.manifests)
        .countDocuments({ _id: changed.evaluationId }),
    ).toBe(0);
    expect(
      await database
        .collection(evaluationCollectionNames.artifacts)
        .countDocuments({ evaluationId: changed.evaluationId }),
    ).toBe(0);
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: changed.evaluationId }, { $unset: { activeOwnerSlot: '' } });
  });

  it('rolls back all five custody writes when the admitted evidence allowance is too small', async () => {
    const limited = fixture();
    await database.collection<EvaluationDocument>(evaluationCollectionNames.evaluations).insertOne({
      ...limited.record,
      reserved: { ...limited.record.reserved, evidencePlusArtifactsPerRunBytes: 1 },
    });
    expect((await put(limited.evaluationId, limited.command)).status).toBe(413);
    expect(
      await database
        .collection<EvaluationManifestLockDocument>(evaluationCollectionNames.manifests)
        .countDocuments({ _id: limited.evaluationId }),
    ).toBe(0);
    expect(
      await database
        .collection(evaluationCollectionNames.artifacts)
        .countDocuments({ evaluationId: limited.evaluationId }),
    ).toBe(0);
    const evaluation = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: limited.evaluationId });
    expect(evaluation?.version).toBe(1);
    expect(evaluation?.acceptedBytes).toBe(0);
  });
});
