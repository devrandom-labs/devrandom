import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prepareEvaluationClosure,
  prepareEvaluationEvidenceBatch,
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  type EvidenceArtifact,
} from '@devrandom/protocol';

import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import { acceptEvaluationEvidence } from '../application/accept-evaluation-evidence.js';
import { renewHostedEvaluationLease } from '../application/renew-evaluation-lease.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import {
  evaluationCollectionNames,
  MongoEvaluationReservations,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';
import {
  evaluationEvidenceIndexes,
  MongoEvaluationEvidence,
  replayEvaluationBudgetCoverage,
} from './mongo-evaluation-evidence.js';
import { MongoEvaluationBootstrap } from './mongo-evaluation-bootstrap.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeWithMongo = mongoUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = randomUUID();
const originRunId = randomUUID();
const evaluationId = randomUUID();
const streamId = randomUUID();
const budget = {
  providerRequests: 2,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 100,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 64 * 1024,
};
const missingIndexBytes = new TextEncoder().encode('{}');
const missingIndexArtifact = prepareEvidenceArtifact(missingIndexBytes, 'application/json');
if (missingIndexArtifact.kind !== 'Prepared') throw new Error('index fixture invalid');
const missingIndexCustody = {
  artifact: missingIndexArtifact.artifact,
  bytes: missingIndexBytes,
};

function event(
  sequence: number,
  previous: { kind: 'Genesis' } | { kind: 'Previous'; eventSaid: string },
  detail:
    | {
        kind: 'UsageDebited';
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        spendMicroUsd: number;
        elapsedMilliseconds: number;
      }
    | { kind: 'ModelExchange'; rawArtifactSaid: string }
    | {
        kind: 'ProviderUsageVerified';
        modelExchangeEventSaid: string;
        receiptArtifactSaid: string;
        providerReportArtifactSaid: string;
        requestOrdinal: number;
      }
    | {
        kind: 'ToolProposed';
        proposalIndex: number;
        toolCallId: string;
        inputArtifactSaid: string;
      }
    | {
        kind: 'EvaluationBudgetDebited';
        budget: Exclude<keyof typeof budget, 'evidencePlusArtifactsPerRunBytes'>;
        amount: number;
        consumed: number;
        receiptArtifactSaid: string;
        sourceEventSaid: string;
      }
    | { kind: 'SourceRead'; sourceSaid: string; rawArtifactSaid: string }
    | {
        kind: 'ArtifactCaptured';
        artifactSaid: string;
        custody: 'Public' | 'ProtectedCiphertext';
      }
    | {
        kind: 'EvaluationBudgetCovered';
        throughSequence: number;
        throughHeadSaid: string;
        totals: {
          providerRequests: number;
          providerInputTokens: number;
          providerOutputTokens: number;
          providerSpendMicroUsd: number;
          runWallTimeSeconds: number;
          toolProposals: number;
          aggregateChildCommandTimeSeconds: number;
          changedFiles: number;
          changedWorktreeBytes: number;
        };
        providerUsageEventSaids: string[];
      },
  phase?: { kind: 'Trial'; manifestSaid: string; arm: 'H1'; repetition: 1; attempt: 1 },
) {
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId,
    originRunId,
    taskId,
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: phase ?? { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence,
    previous,
    occurredAt: '2026-09-26T04:00:00.000Z',
    detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return prepared.event;
}

it('rejects a final zero-coverage claim after an acknowledged provider request debit', () => {
  const zeroTotals = {
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerSpendMicroUsd: 0,
    runWallTimeSeconds: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
  };
  const exchange = event(
    0,
    { kind: 'Genesis' },
    { kind: 'ModelExchange', rawArtifactSaid: said('x') },
  );
  const debit = event(
    1,
    { kind: 'Previous', eventSaid: exchange.d },
    {
      kind: 'EvaluationBudgetDebited',
      budget: 'providerRequests',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('u'),
      sourceEventSaid: exchange.d,
    },
  );
  const coverage = event(
    2,
    { kind: 'Previous', eventSaid: debit.d },
    {
      kind: 'EvaluationBudgetCovered',
      throughSequence: 1,
      throughHeadSaid: debit.d,
      totals: zeroTotals,
      providerUsageEventSaids: [],
    },
  );
  expect(
    replayEvaluationBudgetCoverage({ events: [exchange, debit, coverage], reserved: budget }),
  ).toEqual({
    kind: 'Incomplete',
    reason: 'TotalsMismatch',
  });
  const omittedDimensions = event(
    2,
    { kind: 'Previous', eventSaid: debit.d },
    {
      kind: 'EvaluationBudgetCovered',
      throughSequence: 1,
      throughHeadSaid: debit.d,
      totals: { ...zeroTotals, providerRequests: 1 },
      providerUsageEventSaids: [said('v')],
    },
  );
  expect(
    replayEvaluationBudgetCoverage({
      events: [exchange, debit, omittedDimensions],
      reserved: budget,
    }),
  ).toEqual({ kind: 'Incomplete', reason: 'MissingDimension' });
  expect(
    replayEvaluationBudgetCoverage({
      events: [exchange, debit, omittedDimensions],
      reserved: { ...budget, providerRequests: 0 },
    }),
  ).toEqual({ kind: 'Incomplete', reason: 'BudgetExceeded' });
  const misboundDebit = event(
    1,
    { kind: 'Previous', eventSaid: exchange.d },
    {
      kind: 'EvaluationBudgetDebited',
      budget: 'providerRequests',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('u'),
      sourceEventSaid: said('z'),
    },
  );
  const misboundCoverage = event(
    2,
    { kind: 'Previous', eventSaid: misboundDebit.d },
    {
      kind: 'EvaluationBudgetCovered',
      throughSequence: 1,
      throughHeadSaid: misboundDebit.d,
      totals: { ...zeroTotals, providerRequests: 1 },
      providerUsageEventSaids: [],
    },
  );
  expect(
    replayEvaluationBudgetCoverage({
      events: [exchange, misboundDebit, misboundCoverage],
      reserved: budget,
    }),
  ).toEqual({ kind: 'Incomplete', reason: 'SourceMissing' });
});

it('replays each of the nine budget dimensions but does not attest its measurements', () => {
  const names = [
    'providerRequests',
    'providerInputTokens',
    'providerOutputTokens',
    'providerSpendMicroUsd',
    'runWallTimeSeconds',
    'toolProposals',
    'aggregateChildCommandTimeSeconds',
    'changedFiles',
    'changedWorktreeBytes',
  ] as const;
  const exchange = event(
    0,
    { kind: 'Genesis' },
    { kind: 'ModelExchange', rawArtifactSaid: said('x') },
  );
  const proposal = event(
    1,
    { kind: 'Previous', eventSaid: exchange.d },
    { kind: 'ToolProposed', proposalIndex: 0, toolCallId: 'tool-1', inputArtifactSaid: said('i') },
  );
  const events = [exchange, proposal];
  for (const [index, name] of names.entries()) {
    const predecessor = events.at(-1);
    if (predecessor === undefined) throw new Error('fixture predecessor missing');
    events.push(
      event(
        index + 2,
        { kind: 'Previous', eventSaid: predecessor.d },
        {
          kind: 'EvaluationBudgetDebited',
          budget: name,
          amount: 1,
          consumed: 1,
          receiptArtifactSaid: said(String(index)),
          sourceEventSaid: name === 'toolProposals' ? proposal.d : exchange.d,
        },
      ),
    );
  }
  const head = events.at(-1);
  if (head === undefined) throw new Error('fixture head missing');
  events.push(
    event(
      events.length,
      { kind: 'Previous', eventSaid: head.d },
      {
        kind: 'EvaluationBudgetCovered',
        throughSequence: head.sequence,
        throughHeadSaid: head.d,
        totals: Object.fromEntries(names.map((name) => [name, 1])) as Record<
          (typeof names)[number],
          number
        >,
        providerUsageEventSaids: [said('u')],
      },
    ),
  );
  expect(replayEvaluationBudgetCoverage({ events, reserved: budget })).toEqual({
    kind: 'Incomplete',
    reason: 'ProviderUsageUnlinked',
  });
  // A claimed provider SAID without an accepted source-bound event cannot close E3.
});

it.each([1, 51])(
  'replays %i provider witnesses within the accepted reservation, preserving narrower reservations',
  (count) => {
    const trialEvent = (
      sequence: number,
      previous: Parameters<typeof event>[1],
      detail: Parameters<typeof event>[2],
    ) =>
      event(sequence, previous, detail, {
        kind: 'Trial',
        manifestSaid: said('m'),
        arm: 'H1',
        repetition: 1,
        attempt: 1,
      });
    const names = [
      'providerRequests',
      'providerInputTokens',
      'providerOutputTokens',
      'providerSpendMicroUsd',
      'runWallTimeSeconds',
      'toolProposals',
      'aggregateChildCommandTimeSeconds',
      'changedFiles',
      'changedWorktreeBytes',
    ] as const;
    const events: ReturnType<typeof event>[] = [];
    const witnesses: string[] = [];
    const append = (detail: Parameters<typeof event>[2]) => {
      const previous = events.at(-1);
      const next = trialEvent(
        events.length,
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
        detail,
      );
      events.push(next);
      return next;
    };
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const exchange = append({ kind: 'ModelExchange', rawArtifactSaid: said('x') });
      append({ kind: 'ArtifactCaptured', artifactSaid: said('r'), custody: 'Public' });
      append({ kind: 'ArtifactCaptured', artifactSaid: said('u'), custody: 'Public' });
      const verified = append({
        kind: 'ProviderUsageVerified',
        modelExchangeEventSaid: exchange.d,
        receiptArtifactSaid: said('u'),
        providerReportArtifactSaid: said('r'),
        requestOrdinal: ordinal,
      });
      witnesses.push(verified.d);
      const proposal = append({
        kind: 'ToolProposed',
        proposalIndex: ordinal,
        toolCallId: `tool-${String(ordinal)}`,
        inputArtifactSaid: said('i'),
      });
      for (const name of names)
        append({
          kind: 'EvaluationBudgetDebited',
          budget: name,
          amount: 1,
          consumed: ordinal + 1,
          receiptArtifactSaid: name.startsWith('provider') ? said('u') : said('z'),
          sourceEventSaid: name === 'toolProposals' ? proposal.d : exchange.d,
        });
    }
    const head = events.at(-1);
    if (head === undefined) throw new Error('fixture head missing');
    events.push(
      trialEvent(
        events.length,
        { kind: 'Previous', eventSaid: head.d },
        {
          kind: 'EvaluationBudgetCovered',
          throughSequence: head.sequence,
          throughHeadSaid: head.d,
          totals: Object.fromEntries(names.map((name) => [name, count])) as Record<
            (typeof names)[number],
            number
          >,
          providerUsageEventSaids: witnesses,
        },
      ),
    );
    expect(
      replayEvaluationBudgetCoverage({ events, reserved: { ...budget, providerRequests: count } }),
    ).toMatchObject({
      kind: 'StructurallyConsistent',
      totals: Object.fromEntries(names.map((name) => [name, count])),
    });
    expect(
      replayEvaluationBudgetCoverage({
        events,
        reserved: { ...budget, providerRequests: count - 1 },
      }),
    ).toEqual({ kind: 'Incomplete', reason: 'BudgetExceeded' });
  },
);

function upload(events: ReturnType<typeof event>[]) {
  const prepared = prepareEvaluationEvidenceBatch(events);
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return {
    version: 1 as const,
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    batch: prepared.batch,
    events,
    publicArtifacts: [],
    protectedArtifacts: [],
  };
}

describeWithMongo('Mongo native Evaluation evidence boundary', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_evaluation_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let repository: MongoEvaluationEvidence;
  let address: string;

  beforeAll(async () => {
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    await database
      .collection<{ _id: string; version: number; acceptedBytes: number }>(
        evidenceCollectionNames.usage,
      )
      .insertOne({
        _id: evidenceUsageDocumentId,
        version: 0,
        acceptedBytes: 0,
      });
    expect(evaluationEvidenceIndexes()).toHaveLength(3);
    const now = new Date();
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
        personalAgentAid: said('a'),
        taskMandateSaid: said('m'),
        policySaid: said('p'),
        executionProfileSaid: said('e'),
        sourceInventorySaid: said('i'),
        allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
      },
      reserved: budget,
      reservationSaid: said('r'),
      evidenceStreamId: streamId,
      version: 1,
      lease: {
        evaluationId,
        leaseId: randomUUID(),
        version: 1,
        serverTime: now.toISOString(),
        expiresAt: new Date(now.valueOf() + 45000).toISOString(),
      },
      acceptedThroughSequence: -1,
      chainHeadSaid: null,
      acceptedBytes: 0,
      activeOwnerSlot: ownerAid,
      acceptedAt: now,
    };
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(record);
    repository = new MongoEvaluationEvidence(client, database);
    const reservations = new MongoEvaluationReservations(client, database);
    server.register(
      evaluationRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve({
              kind: 'Authorized',
              ownerAid: bearerSecret === 'b'.repeat(43) ? said('x') : ownerAid,
            }),
        },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: {
          lock: () => Promise.resolve({ kind: 'Unavailable' }),
          inspect: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        leases: {
          renew: (input) =>
            renewHostedEvaluationLease(input, {
              authority: { inspect: () => Promise.resolve({ kind: 'Authorized' }) },
              leases: reservations,
            }),
        },
        evidence: {
          accept: (input) => acceptEvaluationEvidence(input, { batches: repository }),
          close: (input) => repository.close(input),
        },
        reading: repository,
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
  });

  it('accepts one ordered batch, reconciles exact retry and rejects a gap without writes', async () => {
    const first = event(
      0,
      { kind: 'Genesis' },
      {
        kind: 'UsageDebited',
        providerRequests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 1,
        elapsedMilliseconds: 1,
      },
    );
    const firstUpload = upload([first]);
    const endpoint = `${address}/api/evaluations/${evaluationId}/batches`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(firstUpload),
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { disposition: string }).disposition).toBe('Accepted');
    expect(
      await repository.accept({
        ownerAid,
        upload: {
          ...firstUpload,
          batch: {
            ...firstUpload.batch,
            encodedByteCount: firstUpload.batch.encodedByteCount + 1,
          },
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'InvalidBatch' });
    const replay = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(firstUpload),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { disposition: string }).disposition).toBe('AlreadyAccepted');
    expect(
      (
        await acceptEvaluationEvidence(
          { ownerAid: said('x'), upload: firstUpload },
          { batches: repository },
        )
      ).kind,
    ).toBe('Conflict');
    const skipped = event(
      2,
      { kind: 'Previous', eventSaid: first.d },
      {
        kind: 'UsageDebited',
        providerRequests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 1,
        elapsedMilliseconds: 1,
      },
    );
    const gap = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upload([skipped])),
    });
    expect(gap.status).toBe(409);
    expect(await database.collection(evaluationCollectionNames.events).countDocuments()).toBe(1);
    expect(await database.collection(evaluationCollectionNames.batches).countDocuments()).toBe(1);
  });

  it('reads only the owner current Evaluation cursor and rejects stale lease or substituted head', async () => {
    const endpoint = `${address}/api/evaluations/${evaluationId}/position`;
    const authorized = { authorization: `Bearer ${'a'.repeat(43)}` };
    const current = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId, ownerAid });
    if (current === null || current.chainHeadSaid === null)
      throw new Error('accepted fixture missing');
    const read = await fetch(endpoint, { headers: authorized });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      version: 1,
      evaluationId,
      ownerAid,
      currentEvaluationVersion: current.version,
      commandId: current.command.commandId,
      streamId,
      reservationSaid: current.reservationSaid,
      acceptedThroughSequence: current.acceptedThroughSequence,
      chainHeadSaid: current.chainHeadSaid,
    });
    expect(
      (await fetch(endpoint, { headers: { authorization: `Bearer ${'b'.repeat(43)}` } })).status,
    ).toBe(403);
    const evaluations = database.collection<EvaluationDocument>(
      evaluationCollectionNames.evaluations,
    );
    await evaluations.updateOne(
      { _id: evaluationId },
      { $set: { 'lease.expiresAt': '2026-09-26T00:00:00.000Z' } },
    );
    expect((await fetch(endpoint, { headers: authorized })).status).toBe(409);
    await evaluations.updateOne(
      { _id: evaluationId },
      { $set: { lease: current.lease, chainHeadSaid: said('z') } },
    );
    expect((await fetch(endpoint, { headers: authorized })).status).toBe(409);
    await evaluations.updateOne(
      { _id: evaluationId },
      { $set: { chainHeadSaid: current.chainHeadSaid } },
    );
  });

  it('rolls back missing raw bytes and rejects incomplete evidence-only closure', async () => {
    const state = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    if (state?.chainHeadSaid === null || state?.chainHeadSaid === undefined)
      throw new Error('missing first batch');
    const second = event(
      1,
      { kind: 'Previous', eventSaid: state.chainHeadSaid },
      {
        kind: 'ModelExchange',
        rawArtifactSaid: said('z'),
      },
    );
    expect(
      (
        await acceptEvaluationEvidence(
          { ownerAid, upload: upload([second]) },
          { batches: repository },
        )
      ).kind,
    ).toBe('Rejected');
    expect(await database.collection(evaluationCollectionNames.events).countDocuments()).toBe(1);
    const closure = prepareEvaluationClosure({
      evaluationId,
      evidenceStreamId: streamId,
      originRunId,
      manifestSaid: said('M'),
      evidenceIndexSaid: said('I'),
      acceptedEventCount: 1,
      acceptedHeadSaid: state.chainHeadSaid,
      observationSaids: Array.from({ length: 18 }, (_, index) =>
        said(String.fromCharCode(65 + index)),
      ),
      measurementSaids: Array.from({ length: 15 }, (_, index) =>
        said(String.fromCharCode(97 + index)),
      ),
      sharedAuditSaid: said('u'),
      armAuditSaids: {
        H1: said('1'),
        C1: said('2'),
        C2: said('3'),
        C3: said('4'),
        H1TaskSearch: said('5'),
      },
      protectedCustodySaid: said('q'),
      agentSealSaid: said('g'),
    });
    if (closure.kind !== 'Prepared') throw new Error(closure.reason);
    expect(
      (
        await repository.close({
          ownerAid,
          expectedEvaluationVersion: state.version,
          closure: closure.closure,
          evidenceIndex: missingIndexCustody,
        })
      ).kind,
    ).toBe('Incomplete');
    expect(
      (
        await database
          .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
          .findOne({ _id: evaluationId })
      )?.closure,
    ).toBeUndefined();
    const rawBytes = new TextEncoder().encode('{"observation":"legacy rejected"}');
    const artifact = prepareEvidenceArtifact(rawBytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
    const complete = event(
      1,
      { kind: 'Previous', eventSaid: state.chainHeadSaid },
      {
        kind: 'ModelExchange',
        rawArtifactSaid: artifact.artifact.d,
      },
    );
    const completeUpload = {
      ...upload([complete]),
      publicArtifacts: [
        {
          artifact: artifact.artifact,
          bytesBase64Url: Buffer.from(rawBytes).toString('base64url'),
        },
      ],
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/batches`;
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json' },
      body: JSON.stringify(completeUpload),
    });
    expect(accepted.status).toBe(201);
    expect(
      await database
        .collection(evaluationCollectionNames.artifacts)
        .countDocuments({ 'artifact.d': artifact.artifact.d }),
    ).toBe(1);
  });

  it('rejects a Trial source read before an immutable M is in custody', async () => {
    const state = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId, ownerAid });
    if (state === null || state.chainHeadSaid === null)
      throw new Error('accepted Evaluation stream missing');
    const bytes = new TextEncoder().encode(
      JSON.stringify({ version: 1, files: [{ path: 'src/lib.rs', length: 5, digest: 'abc' }] }),
    );
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('source manifest preparation failed');
    const phase = {
      kind: 'Trial' as const,
      manifestSaid: said('M'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    };
    const source = event(
      state.acceptedThroughSequence + 1,
      { kind: 'Previous', eventSaid: state.chainHeadSaid },
      {
        kind: 'SourceRead',
        sourceSaid: prepared.artifact.d,
        rawArtifactSaid: prepared.artifact.d,
      },
      phase,
    );
    const withBytes = {
      ...upload([source]),
      publicArtifacts: [
        { artifact: prepared.artifact, bytesBase64Url: Buffer.from(bytes).toString('base64url') },
      ],
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/batches`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const refused = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(withBytes),
    });
    expect(refused.status).toBe(400);
    expect(
      await database.collection(evaluationCollectionNames.artifacts).countDocuments({
        evaluationId,
        'artifact.d': prepared.artifact.d,
      }),
    ).toBe(0);
    expect(
      (
        await database
          .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
          .findOne({ _id: evaluationId, ownerAid })
      )?.acceptedThroughSequence,
    ).toBe(state.acceptedThroughSequence);
  });

  it('renews only the current lease and reconciles one exact command across a lost reply', async () => {
    const evaluations = database.collection<EvaluationDocument>(
      evaluationCollectionNames.evaluations,
    );
    const state = await evaluations.findOne({ _id: evaluationId });
    if (state === null) throw new Error('evaluation missing');
    const now = Date.now();
    await evaluations.updateOne(
      { _id: evaluationId },
      {
        $set: {
          lease: {
            ...state.lease,
            serverTime: new Date(now - 35_000).toISOString(),
            expiresAt: new Date(now + 10_000).toISOString(),
          },
        },
      },
    );
    const command = {
      version: 1,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      evaluationId,
      leaseId: state.lease.leaseId,
      expectedEvaluationVersion: state.version,
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/lease`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const renewed = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(command),
    });
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { kind: string }).kind).toBe('Renewed');
    const replay = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(command) });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { kind: string }).kind).toBe('AlreadyRenewed');
    expect(await database.collection(evaluationCollectionNames.renewals).countDocuments()).toBe(1);
    expect((await evaluations.findOne({ _id: evaluationId }))?.version).toBe(state.version + 1);
    const stale = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...command, commandId: randomUUID() }),
    });
    expect(stale.status).toBe(409);
    const fresh = await fetch(`${address}/api/evaluations/${evaluationId}/position`, { headers });
    const position = (await fresh.json()) as { version: number; currentEvaluationVersion: number };
    expect(position.version).toBe(1);
    expect(position.currentEvaluationVersion).toBe(state.version + 1);
    const racedState = await evaluations.findOne({ _id: evaluationId });
    if (racedState === null || racedState.chainHeadSaid === null) throw new Error('race cursor');
    const concurrentBytes = Buffer.from('actual concurrent Research capture');
    const concurrentArtifact = prepareEvidenceArtifact(
      concurrentBytes,
      'text/plain; charset=utf-8',
    );
    if (concurrentArtifact.kind !== 'Prepared') throw new Error('race artifact');
    const concurrentEvent = event(
      racedState.acceptedThroughSequence + 1,
      { kind: 'Previous', eventSaid: racedState.chainHeadSaid },
      { kind: 'ModelExchange', rawArtifactSaid: concurrentArtifact.artifact.d },
    );
    const appended = await fetch(`${address}/api/evaluations/${evaluationId}/batches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...upload([concurrentEvent]),
        publicArtifacts: [
          {
            artifact: concurrentArtifact.artifact,
            bytesBase64Url: concurrentBytes.toString('base64url'),
          },
        ],
      }),
    });
    expect(appended.status).toBe(201);
    const raced = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...command,
        commandId: randomUUID(),
        expectedEvaluationVersion: position.currentEvaluationVersion,
      }),
    });
    expect(raced.status).toBe(409);
    const afterAppend = await fetch(`${address}/api/evaluations/${evaluationId}/position`, {
      headers,
    });
    const freshVersion = (await afterAppend.json()) as { currentEvaluationVersion: number };
    expect(freshVersion.currentEvaluationVersion).toBe(position.currentEvaluationVersion + 1);
    const secondAt = Date.now();
    await evaluations.updateOne(
      { _id: evaluationId },
      {
        $set: {
          'lease.serverTime': new Date(secondAt - 35000).toISOString(),
          'lease.expiresAt': new Date(secondAt + 10000).toISOString(),
        },
      },
    );
    const second = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...command,
        commandId: randomUUID(),
        expectedEvaluationVersion: freshVersion.currentEvaluationVersion,
      }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      kind: 'Renewed',
      version: state.version + 3,
      lease: { version: state.lease.version + 2 },
    });
  });

  it('reads a prior reservation by exact owner and command before any new allocation', async () => {
    const existing = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    if (existing === null) throw new Error('evaluation fixture missing');
    const reservations = new MongoEvaluationReservations(client, database);
    expect(await reservations.reconcile({ ownerAid, command: existing.command })).toMatchObject({
      kind: 'Admitted',
      evaluationId,
      evidenceStreamId: existing.evidenceStreamId,
      reservationSaid: existing.reservationSaid,
    });
    expect(
      await reservations.reconcile({
        ownerAid,
        command: { ...existing.command, fingerprint: `sha256:${'b'.repeat(64)}` },
      }),
    ).toEqual({ kind: 'Conflict' });
    expect(
      await reservations.reconcile({ ownerAid: said('z'), command: existing.command }),
    ).toEqual({ kind: 'NotFound' });
  });

  it('keeps an otherwise byte-complete closure active until all budget consumption is proven', async () => {
    const evaluations = database.collection<EvaluationDocument>(
      evaluationCollectionNames.evaluations,
    );
    const before = await evaluations.findOne({ _id: evaluationId, ownerAid });
    if (before === null || before.chainHeadSaid === null)
      throw new Error('accepted Evaluation stream missing');
    const required: { artifact: EvidenceArtifact; bytes: Uint8Array }[] = [];
    for (let index = 0; index < 39; index++) {
      const bytes = new TextEncoder().encode(JSON.stringify({ closureEvidence: index }));
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared') throw new Error('closure artifact preparation failed');
      required.push({ artifact: prepared.artifact, bytes });
    }
    const protectedArtifact = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid: said('q'),
      purpose: 'OracleObservation',
      segment: 0,
      nonce: 'A'.repeat(16),
      tag: 'B'.repeat(22),
      ciphertext: 'AA',
      plaintextByteCount: 1,
    });
    if (protectedArtifact.kind !== 'Prepared') throw new Error('protected artifact rejected');
    const captured = [
      ...required.map(({ artifact }) => ({
        kind: 'ArtifactCaptured' as const,
        artifactSaid: artifact.d,
        custody: 'Public' as const,
      })),
      {
        kind: 'ArtifactCaptured' as const,
        artifactSaid: protectedArtifact.artifact.d,
        custody: 'ProtectedCiphertext' as const,
      },
    ];
    let sequence = before.acceptedThroughSequence + 1;
    let head = before.chainHeadSaid;
    for (const [index, detail] of captured.entries()) {
      const accepted = event(sequence, { kind: 'Previous', eventSaid: head }, detail);
      sequence++;
      head = accepted.d;
      const publicArtifact = required[index];
      const admitted = await repository.accept({
        ownerAid,
        upload: {
          ...upload([accepted]),
          publicArtifacts:
            publicArtifact === undefined
              ? []
              : [
                  {
                    artifact: publicArtifact.artifact,
                    bytesBase64Url: Buffer.from(publicArtifact.bytes).toString('base64url'),
                  },
                ],
          protectedArtifacts: publicArtifact === undefined ? [protectedArtifact.artifact] : [],
        },
      });
      expect(admitted.kind).toBe('Accepted');
    }
    const current = await evaluations.findOne({ _id: evaluationId, ownerAid });
    if (current === null || current.chainHeadSaid === null)
      throw new Error('accepted Evaluation artifacts missing');
    const saids = [...required.map(({ artifact }) => artifact.d), protectedArtifact.artifact.d];
    const at = (index: number) => {
      const value = saids[index];
      if (value === undefined) throw new Error('closure artifact missing');
      return value;
    };
    const closureInput = {
      evaluationId,
      evidenceStreamId: streamId,
      originRunId,
      manifestSaid: said('M'),
      evidenceIndexSaid: said('I'),
      acceptedEventCount: current.acceptedThroughSequence + 1,
      acceptedHeadSaid: current.chainHeadSaid,
      observationSaids: Array.from({ length: 18 }, (_, index) => at(index)),
      measurementSaids: Array.from({ length: 15 }, (_, index) => at(18 + index)),
      sharedAuditSaid: at(33),
      armAuditSaids: {
        H1: at(34),
        C1: at(35),
        C2: at(36),
        C3: at(37),
        H1TaskSearch: at(38),
      },
      protectedCustodySaid: at(39),
      agentSealSaid: said('g'),
    };
    const closure = prepareEvaluationClosure(closureInput);
    if (closure.kind !== 'Prepared') throw new Error('closure preparation failed');
    expect(
      await repository.close({
        ownerAid,
        expectedEvaluationVersion: current.version,
        closure: closure.closure,
        evidenceIndex: missingIndexCustody,
      }),
    ).toEqual({ kind: 'Incomplete' });
    const unchanged = await evaluations.findOne({ _id: evaluationId, ownerAid });
    expect(unchanged).toMatchObject({
      version: current.version,
      activeOwnerSlot: ownerAid,
      acceptedThroughSequence: current.acceptedThroughSequence,
    });
    expect(unchanged?.closure).toBeUndefined();
    expect(
      await database
        .collection<{ _id: string }>(evaluationCollectionNames.evaluations)
        .countDocuments({ _id: evaluationId, settledDebit: { $exists: true } }),
    ).toBe(0);

    const forgedCoverage = event(
      current.acceptedThroughSequence + 1,
      { kind: 'Previous', eventSaid: current.chainHeadSaid },
      {
        kind: 'EvaluationBudgetCovered',
        throughSequence: current.acceptedThroughSequence,
        throughHeadSaid: current.chainHeadSaid,
        totals: {
          providerRequests: 0,
          providerInputTokens: 0,
          providerOutputTokens: 0,
          providerSpendMicroUsd: 0,
          runWallTimeSeconds: 0,
          toolProposals: 0,
          aggregateChildCommandTimeSeconds: 0,
          changedFiles: 0,
          changedWorktreeBytes: 0,
        },
        providerUsageEventSaids: [],
      },
    );
    expect(
      (
        await repository.accept({
          ownerAid,
          upload: upload([forgedCoverage]),
        })
      ).kind,
    ).toBe('Accepted');
    const afterCoverage = await evaluations.findOne({ _id: evaluationId, ownerAid });
    if (afterCoverage === null || afterCoverage.chainHeadSaid === null)
      throw new Error('forged coverage did not append');
    const forgedClosure = prepareEvaluationClosure({
      ...closureInput,
      acceptedEventCount: afterCoverage.acceptedThroughSequence + 1,
      acceptedHeadSaid: afterCoverage.chainHeadSaid,
    });
    if (forgedClosure.kind !== 'Prepared') throw new Error('forged closure preparation failed');
    expect(
      await repository.close({
        ownerAid,
        expectedEvaluationVersion: afterCoverage.version,
        closure: forgedClosure.closure,
        evidenceIndex: missingIndexCustody,
      }),
    ).toEqual({ kind: 'Incomplete' });
    expect(await evaluations.findOne({ _id: evaluationId, ownerAid })).toMatchObject({
      version: afterCoverage.version,
      activeOwnerSlot: ownerAid,
    });
  });
});
