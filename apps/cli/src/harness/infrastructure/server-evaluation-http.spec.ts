import { expect, it } from 'vitest';
import {
  prepareEvaluationEvidenceBatch,
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  prepareEvaluationClosure,
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
} from '@devrandom/protocol';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvaluationHttp } from './server-evaluation-http.js';

const said = (value: string): string => `E${value.repeat(43)}`;
const id = (value: string): string =>
  `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 200,
  runWallTimeSeconds: 20,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 10,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 20000,
};
const command = {
  version: 1 as const,
  commandId: id('1'),
  fingerprint: `sha256:${'a'.repeat(64)}`,
  taskId: id('2'),
  taskRevisionSaid: said('t'),
  originRunId: id('3'),
  retainedCheckpointSaid: said('c'),
  retainedSealSaid: said('s'),
  expectedActiveRevisionSaid: said('h'),
  personalAgentAid: said('p'),
  taskMandateSaid: said('m'),
  policySaid: said('l'),
  executionProfileSaid: said('e'),
  sourceInventorySaid: said('i'),
  allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
};

function origin() {
  const decoded = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
  if (decoded.kind !== 'Accepted') throw new Error('origin rejected');
  return decoded.origin;
}

it('prepares exact SAID-verified source and Linux profile documents over the public route', async () => {
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
    sourceGitCommit: 'a'.repeat(40),
    sourceGitTree: 'b'.repeat(40),
    h1InstructionSaid: said('h'),
    h1RuntimePromptDigest: `sha256:${'d'.repeat(64)}`,
    effectiveLimitsReceiptSaid: said('l'),
    parentDeathCleanupReceiptSaid: said('p'),
    modelProvider: 'concentrate',
    modelId: 'deepinfra/deepseek-v4-flash-0731',
    thinkingLevel: 'low',
    maximumOutputTokens: 8192,
    limits: {
      cpuCount: 2,
      memoryBytes: 1073741824,
      processCount: 64,
      scratchBytes: 67108864,
      outputBytes: 524288,
      wallTimeSeconds: 3600,
    },
    containment: {
      nonRoot: true,
      readOnlyRuntime: true,
      networkDisabled: true,
      privilegesDropped: true,
      restrictedIpc: true,
      parentDeathCleanup: true,
    },
  });
  const inventory = prepareEvaluationSourceInventory({
    taskId: command.taskId,
    taskRevisionSaid: command.taskRevisionSaid,
    ownerAid: said('o'),
    repositoryResourceSaid: said('r'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('m'),
    sources: [
      {
        episodeSaid: said('e'),
        rawEvidenceSaid: said('f'),
        ownerAid: said('o'),
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (profile.kind !== 'Prepared' || inventory.kind !== 'Prepared')
    throw new Error('invalid test documents');
  const preparation = {
    version: 1 as const,
    commandId: command.commandId,
    fingerprint: command.fingerprint,
    taskId: command.taskId,
    taskRevisionSaid: command.taskRevisionSaid,
    sourceInventory: inventory.inventory,
    executionProfile: profile.profile,
  };
  let requests = 0;
  const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
    expect(url).toBe('http://127.0.0.1:3211/api/evaluations/prepare');
    expect(init?.body).toBe(JSON.stringify(preparation));
    requests += 1;
    const prepared = requests === 1;
    return Promise.resolve(
      new Response(JSON.stringify({ kind: prepared ? 'Prepared' : 'AlreadyPrepared' }), {
        status: prepared ? 201 : 200,
        headers: { 'cache-control': 'no-store' },
      }),
    );
  });
  expect(await http.prepare(preparation)).toEqual({ kind: 'Prepared' });
  expect(await http.prepare(preparation)).toEqual({ kind: 'AlreadyPrepared' });
});

it('uses the exact Work Access bearer and maps a hosted budget denial without admitting a trial', async () => {
  let requested = false;
  const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
    expect(url).toBe('http://127.0.0.1:3211/api/evaluations');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`);
    expect(init?.body).toBe(JSON.stringify(command));
    requested = true;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          code: 'EvaluationBlockedBudget',
          correlationId: id('4'),
          status: 422,
          title: 'EvaluationBlockedBudget',
          type: 'https://devrandom.example/problems/evaluationblockedbudget',
        }),
        { status: 422, headers: { 'cache-control': 'no-store' } },
      ),
    );
  });
  expect(await http.admit(command)).toEqual({ kind: 'Blocked', gate: 'Budget' });
  expect(requested).toBe(true);
});

it('rejects a changed admission identity or missing no-store before exposing the receipt', async () => {
  const receipt = {
    kind: 'Admitted',
    evaluationId: id('5'),
    version: 1,
    lease: {
      evaluationId: id('5'),
      leaseId: id('6'),
      version: 1,
      serverTime: '2026-09-26T05:00:00.000Z',
      expiresAt: '2026-09-26T05:00:45.000Z',
    },
    evidenceStreamId: id('7'),
    reservationSaid: said('r'),
  };
  const changed = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ ...receipt, lease: { ...receipt.lease, evaluationId: id('8') } }),
        {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        },
      ),
    ),
  );
  expect(await changed.admit(command)).toEqual({ kind: 'ResponseInvalid' });
  const cacheable = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(new Response(JSON.stringify(receipt), { status: 201 })),
  );
  expect(await cacheable.admit(command)).toEqual({ kind: 'ResponseInvalid' });
});

it('does not treat malformed hosted conflicts as an authoritative command conflict', async () => {
  const malformed = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(JSON.stringify({ code: 'Conflict', status: 201 }), {
        status: 409,
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  );
  expect(await malformed.admit(command)).toEqual({ kind: 'ResponseInvalid' });
});

it('sends exact raw Evaluation bytes and accepts only the matching ordered acknowledgement', async () => {
  const bytes = new TextEncoder().encode('raw model exchange');
  const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
  const evaluationId = id('5');
  const streamId = id('6');
  const event = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId,
    originRunId: command.originRunId,
    taskId: command.taskId,
    taskRevisionSaid: command.taskRevisionSaid,
    personalAgentAid: command.personalAgentAid,
    taskMandateSaid: command.taskMandateSaid,
    harnessRevisionSaid: command.expectedActiveRevisionSaid,
    phase: { kind: 'Research', policySaid: command.policySaid, role: 'DiagnosticRefiner' },
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail: { kind: 'ModelExchange', rawArtifactSaid: artifact.artifact.d },
  });
  if (event.kind !== 'Prepared') throw new Error(event.reason);
  const batch = prepareEvaluationEvidenceBatch([event.event]);
  if (batch.kind !== 'Prepared') throw new Error(batch.reason);
  const upload = {
    version: 1 as const,
    commandId: id('7'),
    fingerprint: command.fingerprint,
    batch: batch.batch,
    events: [event.event],
    publicArtifacts: [
      { artifact: artifact.artifact, bytesBase64Url: Buffer.from(bytes).toString('base64url') },
    ],
    protectedArtifacts: [],
  };
  const acknowledgement = {
    version: 1 as const,
    disposition: 'Accepted' as const,
    evaluationId,
    streamId,
    batchSaid: batch.batch.d,
    acceptedThroughSequence: 0,
    chainHeadSaid: event.event.d,
  };
  const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
    expect(url).toBe(`http://127.0.0.1:3211/api/evaluations/${evaluationId}/batches`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`);
    expect(init?.body).toBe(JSON.stringify(upload));
    return Promise.resolve(
      new Response(JSON.stringify(acknowledgement), {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      }),
    );
  });
  expect(await http.appendEvidence(upload)).toEqual({ kind: 'Acknowledged', acknowledgement });

  const forged = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(JSON.stringify({ ...acknowledgement, batchSaid: said('f') }), {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  );
  expect(await forged.appendEvidence(upload)).toEqual({ kind: 'ResponseInvalid' });
  const mismatchedRetry = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(JSON.stringify(acknowledgement), {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  );
  expect(await mismatchedRetry.appendEvidence(upload)).toEqual({ kind: 'ResponseInvalid' });
});

it('binds a lease renewal receipt to the exact Evaluation and lease identities', async () => {
  const evaluationId = id('5');
  const leaseId = id('6');
  const renewal = {
    version: 1 as const,
    commandId: id('7'),
    fingerprint: command.fingerprint,
    evaluationId,
    leaseId,
    expectedEvaluationVersion: 1,
  };
  const receipt = {
    kind: 'Renewed' as const,
    evaluationId,
    version: 2,
    lease: {
      evaluationId,
      leaseId,
      version: 2,
      serverTime: '2026-09-26T05:00:00.000Z',
      expiresAt: '2026-09-26T05:00:45.000Z',
    },
  };
  const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
    expect(url).toBe(`http://127.0.0.1:3211/api/evaluations/${evaluationId}/lease`);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify(renewal));
    return Promise.resolve(
      new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      }),
    );
  });
  expect(await http.renewLease(renewal)).toEqual({ kind: 'Renewed', receipt });
  const forged = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(JSON.stringify({ ...receipt, lease: { ...receipt.lease, leaseId: id('8') } }), {
        status: 200,
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  );
  expect(await forged.renewLease(renewal)).toEqual({ kind: 'ResponseInvalid' });
});

it('sends a prepared closure without creating a local seal and verifies the committed SAID', async () => {
  const evaluationId = id('5');
  const indexBytes = new TextEncoder().encode(
    '{"version":1,"kind":"EvaluationClosureEvidenceIndex"}',
  );
  const index = prepareEvidenceArtifact(indexBytes, 'application/json');
  if (index.kind !== 'Prepared') throw new Error(index.reason);
  const prepared = prepareEvaluationClosure({
    evaluationId,
    evidenceStreamId: id('6'),
    originRunId: command.originRunId,
    manifestSaid: said('M'),
    evidenceIndexSaid: index.artifact.d,
    acceptedEventCount: 1,
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
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  const closureCommand = {
    version: 1 as const,
    commandId: id('7'),
    fingerprint: command.fingerprint,
    expectedEvaluationVersion: 1,
    closure: prepared.closure,
    evidenceIndex: {
      artifact: index.artifact,
      bytesBase64Url: Buffer.from(indexBytes).toString('base64url'),
    },
  };
  const http = new ServerEvaluationHttp(origin(), 'b'.repeat(43), (url, init) => {
    expect(url).toBe(`http://127.0.0.1:3211/api/evaluations/${evaluationId}/closure`);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify(closureCommand));
    return Promise.resolve(
      new Response(JSON.stringify({ kind: 'Closed', closureSaid: prepared.closure.d }), {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      }),
    );
  });
  expect(await http.closeEvidence(closureCommand)).toEqual({
    kind: 'Closed',
    closureSaid: prepared.closure.d,
  });
  const forged = new ServerEvaluationHttp(origin(), 'b'.repeat(43), () =>
    Promise.resolve(
      new Response(JSON.stringify({ kind: 'Closed', closureSaid: said('x') }), {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  );
  expect(await forged.closeEvidence(closureCommand)).toEqual({ kind: 'ResponseInvalid' });
  expect(
    await http.closeEvidence({
      ...closureCommand,
      evidenceIndex: { ...closureCommand.evidenceIndex, bytesBase64Url: 'AA' },
    }),
  ).toEqual({ kind: 'Rejected' });
});
