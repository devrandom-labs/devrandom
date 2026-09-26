import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeEvaluationVerifierBundle,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import { afterEach, expect, it, vi } from 'vitest';

import { HostedEvaluationProtectedArtifacts } from './hosted-evaluation-protected-artifacts.js';
import { SqliteEvaluationEvidenceOutbox } from './sqlite-evaluation-evidence-outbox.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const evaluationId = randomUUID();
  const taskId = randomUUID();
  const originRunId = randomUUID();
  const evidenceStreamId = randomUUID();
  const leaseId = randomUUID();
  const encrypted = (
    purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
    segment: number,
    objectSaid: string,
    nonce: string,
  ) => {
    const prepared = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose,
      segment,
      nonce: nonce.repeat(16),
      tag: 'a'.repeat(22),
      ciphertext: 'aa',
      plaintextByteCount: 1,
    });
    if (prepared.kind !== 'Prepared') throw new Error('fixture artifact invalid');
    return prepared.artifact;
  };
  const protectedCase = {
    objectSaid: said('q'),
    stimulus: encrypted('TrialHoldout', 0, said('q'), 'a'),
    expected: encrypted('OracleObservation', 0, said('q'), 'b'),
  };
  const terminalCase = {
    objectSaid: said('f'),
    stimulus: encrypted('TerminalCase', 1, said('f'), 'c'),
    expected: encrypted('OracleObservation', 1, said('f'), 'd'),
  };
  const observation = encrypted('OracleObservation', 0, said('q'), 'e');
  const preparedBundle = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'1'.repeat(64)}`,
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('g'),
    publicConditions: [
      {
        id: 'cesr-current',
        stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
        expected: { kind: 'Parsed', receipts: [{ version: 'Current', payload: said('x') }] },
      },
    ],
    protectedCase,
    terminalCase,
  });
  if (preparedBundle.kind !== 'Prepared') throw new Error('fixture bundle invalid');
  const encoded = encodeEvaluationVerifierBundle(preparedBundle.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('fixture bundle encoding invalid');
  const budget = {
    providerRequests: 2,
    providerInputTokens: 2000,
    providerOutputTokens: 200,
    providerSpendMicroUsd: 100,
    runWallTimeSeconds: 30,
    toolProposals: 20,
    aggregateChildCommandTimeSeconds: 30,
    changedFiles: 2,
    changedWorktreeBytes: 2000,
    evidencePlusArtifactsPerRunBytes: 10000,
  };
  const preparedManifest = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('l') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('v'),
    verifierSaid: preparedBundle.bundle.d,
    protectedCaseArtifactSaid: protectedCase.stimulus.d,
    finalCaseArtifactSaid: terminalCase.stimulus.d,
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
  });
  if (preparedManifest.kind !== 'Prepared') throw new Error(preparedManifest.reason);
  const manifest = preparedManifest.manifest;
  const binding = {
    kind: 'Evaluation' as const,
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('k'),
    evaluationLeaseId: leaseId,
    evidenceStreamId,
    phase: {
      kind: 'Trial' as const,
      manifestSaid: manifest.d,
      arm: 'C2' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const lease = {
    evaluationId,
    leaseId,
    version: 1,
    serverTime: '2026-09-26T06:00:00.000Z',
    expiresAt: '2026-09-26T06:00:45.000Z',
  };
  const stopped = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId: evidenceStreamId,
    originRunId,
    taskId,
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('k'),
    phase: binding.phase,
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T06:00:01.000Z',
    detail: { kind: 'TrialStopped', reason: 'Completed' },
  });
  if (stopped.kind !== 'Prepared') throw new Error('fixture event invalid');
  const stateRoot = mkdtempSync(join(tmpdir(), 'devrandom-protected-artifacts-'));
  roots.push(stateRoot);
  const opening = SqliteEvaluationEvidenceOutbox.open(stateRoot, {
    ownerAid: manifest.ownerAid,
    evaluationId,
    streamId: evidenceStreamId,
    originRunId,
    taskId,
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
  });
  if (opening.kind !== 'Opened') throw new Error('fixture outbox invalid');
  const outbox = opening.outbox;
  const staged = outbox.stage({
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    events: [stopped.event],
    publicArtifacts: [],
    protectedArtifacts: [],
  });
  if (staged.kind !== 'Staged') throw new Error('fixture stage invalid');
  const pending = outbox.pending();
  if (pending.kind !== 'Pending') throw new Error('fixture pending invalid');
  const acknowledged = outbox.acknowledge({
    version: 1,
    disposition: 'Accepted',
    evaluationId,
    streamId: evidenceStreamId,
    batchSaid: pending.upload.batch.d,
    acceptedThroughSequence: 0,
    chainHeadSaid: stopped.event.d,
  });
  if (acknowledged.kind !== 'Recorded') throw new Error('fixture ACK invalid');
  return {
    stateRoot,
    manifest,
    binding,
    lease,
    stopped: stopped.event,
    outbox,
    verifierBytes: encoded.bytes,
    protectedCase,
    observation,
    input: {
      binding,
      manifest,
      lease,
      expectedHeadSaid: stopped.event.d,
      artifacts: [protectedCase.stimulus, protectedCase.expected, observation] as const,
    },
  };
}

function hosted(given: ReturnType<typeof fixture>) {
  const receipt = {
    kind: 'Locked' as const,
    evaluationId: given.manifest.evaluationId,
    manifestSaid: given.manifest.d,
    ownerAid: given.manifest.ownerAid,
    policySaid: given.manifest.policySaid,
    leaseId: given.lease.leaseId,
    lockedAtLeaseVersion: 1,
    lockedAtEvaluationVersion: 2,
    currentLeaseVersion: 1,
    currentEvaluationVersion: 2,
  };
  const inspectManifestLock = vi.fn().mockResolvedValue({ kind: 'Locked' as const, receipt });
  const appendEvidence = vi
    .fn()
    .mockImplementation(
      (upload: {
        batch: { d: string; evaluationId: string; streamId: string; endingSequence: number };
        events: { d: string }[];
      }) =>
        Promise.resolve({
          kind: 'Acknowledged' as const,
          acknowledgement: {
            version: 1 as const,
            disposition: 'Accepted' as const,
            evaluationId: upload.batch.evaluationId,
            streamId: upload.batch.streamId,
            batchSaid: upload.batch.d,
            acceptedThroughSequence: upload.batch.endingSequence,
            chainHeadSaid: upload.events[0]?.d,
          },
        }),
    );
  return { inspectManifestLock, appendEvidence, receipt };
}

it('uploads only the new protected observation and returns the exact hosted event ACK', async () => {
  const given = fixture();
  const server = hosted(given);
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
    () => '2026-09-26T06:00:02.000Z',
  );
  const retained = await adapter.retain(given.input);
  expect(retained).toMatchObject({
    kind: 'Acknowledged',
    artifactSaids: [
      given.protectedCase.stimulus.d,
      given.protectedCase.expected.d,
      given.observation.d,
    ],
    throughSequence: 1,
  });
  expect(server.inspectManifestLock).toHaveBeenCalledWith(
    given.manifest.evaluationId,
    given.manifest.d,
    given.lease.leaseId,
  );
  expect(server.appendEvidence).toHaveBeenCalledTimes(1);
  expect(server.appendEvidence.mock.calls[0]?.[0]).toMatchObject({
    publicArtifacts: [],
    protectedArtifacts: [given.observation],
    events: [
      {
        sequence: 1,
        previous: { kind: 'Previous', eventSaid: given.stopped.d },
        detail: {
          kind: 'ArtifactCaptured',
          artifactSaid: given.observation.d,
          custody: 'ProtectedCiphertext',
        },
      },
    ],
  });
  expect(await adapter.retain(given.input)).toMatchObject({
    kind: 'Acknowledged',
    throughSequence: 1,
  });
  expect(server.appendEvidence).toHaveBeenCalledTimes(1);
  given.outbox.close();
});

it('replays the exact staged batch after a lost ACK and never invents retention', async () => {
  const given = fixture();
  const server = hosted(given);
  server.appendEvidence.mockResolvedValueOnce({ kind: 'Unavailable' });
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
    () => '2026-09-26T06:00:02.000Z',
  );
  expect(await adapter.retain(given.input)).toEqual({ kind: 'Unavailable' });
  expect(given.outbox.pending().kind).toBe('Pending');
  given.outbox.close();
  const reopened = SqliteEvaluationEvidenceOutbox.open(given.stateRoot, {
    ownerAid: given.manifest.ownerAid,
    evaluationId: given.binding.evaluationId,
    streamId: given.binding.evidenceStreamId,
    originRunId: given.binding.originRunId,
    taskId: given.binding.taskId,
    taskRevisionSaid: given.binding.taskRevisionSaid,
    personalAgentAid: given.binding.personalAgentAid,
    taskMandateSaid: given.binding.taskMandateSaid,
  });
  if (reopened.kind !== 'Opened') throw new Error('recovery rejected');
  const retry = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    reopened.outbox,
    () => '2026-09-26T06:01:02.000Z',
  );
  const replayed = await retry.retain(given.input);
  expect(replayed.kind).toBe('Acknowledged');
  expect(server.appendEvidence).toHaveBeenCalledTimes(2);
  expect(server.appendEvidence.mock.calls[1]?.[0]).toEqual(
    server.appendEvidence.mock.calls[0]?.[0],
  );
  expect(reopened.outbox.pending()).toEqual({ kind: 'Empty' });
  reopened.outbox.close();
});

it('stops before upload when the fresh M lock is unavailable or its lease identity changes', async () => {
  const given = fixture();
  const server = hosted(given);
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
  );
  server.inspectManifestLock.mockResolvedValueOnce({ kind: 'Unavailable' });
  expect(await adapter.retain(given.input)).toEqual({ kind: 'Unavailable' });
  server.inspectManifestLock.mockResolvedValueOnce({
    kind: 'Locked',
    receipt: { ...server.receipt, currentLeaseVersion: 2, leaseId: randomUUID() },
  });
  expect(await adapter.retain(given.input)).not.toMatchObject({ kind: 'Acknowledged' });
  expect(server.appendEvidence).not.toHaveBeenCalled();
  given.outbox.close();
});

it('rejects a changed M-locked expected ciphertext before staging an observation', async () => {
  const given = fixture();
  const server = hosted(given);
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
  );
  const wrongTuple = {
    ...given.input,
    artifacts: [given.protectedCase.stimulus, given.observation, given.observation] as const,
  };
  expect(await adapter.retain(wrongTuple)).toEqual({ kind: 'Conflict' });
  expect(server.appendEvidence).not.toHaveBeenCalled();
  expect(given.outbox.position()).toMatchObject({
    nextSequence: 1,
    chainHeadSaid: given.stopped.d,
  });
  given.outbox.close();
});

it('keeps the staged batch pending after a forged hosted chain-head acknowledgement', async () => {
  const given = fixture();
  const server = hosted(given);
  server.appendEvidence.mockImplementationOnce(
    (upload: {
      batch: { d: string; evaluationId: string; streamId: string; endingSequence: number };
    }) =>
      Promise.resolve({
        kind: 'Acknowledged',
        acknowledgement: {
          version: 1,
          disposition: 'Accepted',
          evaluationId: upload.batch.evaluationId,
          streamId: upload.batch.streamId,
          batchSaid: upload.batch.d,
          acceptedThroughSequence: upload.batch.endingSequence,
          chainHeadSaid: said('z'),
        },
      }),
  );
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
    () => '2026-09-26T06:00:02.000Z',
  );
  expect(await adapter.retain(given.input)).toEqual({ kind: 'Unavailable' });
  expect(given.outbox.pending().kind).toBe('Pending');
  given.outbox.close();
});

it('requires a fresh active M-lock read after the batch ACK before reporting retention', async () => {
  const given = fixture();
  const server = hosted(given);
  server.inspectManifestLock
    .mockResolvedValueOnce({ kind: 'Locked', receipt: server.receipt })
    .mockResolvedValueOnce({ kind: 'Unavailable' });
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
    () => '2026-09-26T06:00:02.000Z',
  );
  expect(await adapter.retain(given.input)).toEqual({ kind: 'Unavailable' });
  expect(given.outbox.pending()).toEqual({ kind: 'Empty' });
  expect(await adapter.retain(given.input)).toMatchObject({ kind: 'Acknowledged' });
  expect(server.appendEvidence).toHaveBeenCalledTimes(1);
  given.outbox.close();
});

it('acknowledges original ciphertext once despite same-lease heartbeat during upload', async () => {
  const given = fixture();
  const server = hosted(given);
  server.inspectManifestLock
    .mockResolvedValueOnce({ kind: 'Locked', receipt: server.receipt })
    .mockResolvedValue({
      kind: 'Locked',
      receipt: { ...server.receipt, currentLeaseVersion: 3, currentEvaluationVersion: 4 },
    });
  const adapter = new HostedEvaluationProtectedArtifacts(
    server,
    { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
    given.outbox,
    () => '2026-09-26T06:00:02.000Z',
  );
  const first = await adapter.retain(given.input);
  expect(first.kind).toBe('Acknowledged');
  expect(await adapter.retain(given.input)).toEqual(first);
  expect(server.appendEvidence).toHaveBeenCalledTimes(1);
  given.outbox.close();
});

it.each(['ownerAid', 'manifestSaid', 'policySaid', 'leaseId'] as const)(
  'refuses to report custody if %s changes after upload ACK',
  async (field) => {
    const given = fixture();
    const server = hosted(given);
    server.inspectManifestLock
      .mockResolvedValueOnce({ kind: 'Locked', receipt: server.receipt })
      .mockResolvedValue({
        kind: 'Locked',
        receipt: {
          ...server.receipt,
          currentLeaseVersion: 3,
          currentEvaluationVersion: 4,
          [field]: field === 'leaseId' ? randomUUID() : said('x'),
        },
      });
    const adapter = new HostedEvaluationProtectedArtifacts(
      server,
      { open: vi.fn().mockResolvedValue({ kind: 'Opened', bytes: given.verifierBytes }) },
      given.outbox,
      () => '2026-09-26T06:00:02.000Z',
    );
    expect(await adapter.retain(given.input)).toEqual({ kind: 'LeaseLost' });
    expect(server.appendEvidence).toHaveBeenCalledTimes(1);
    expect(given.outbox.pending()).toEqual({ kind: 'Empty' });
    given.outbox.close();
  },
);
