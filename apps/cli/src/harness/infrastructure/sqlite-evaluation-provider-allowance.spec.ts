import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { EvaluationExecutionBinding } from '@devrandom/domain';
import { prepareEvaluationManifest, prepareEvidenceArtifact } from '@devrandom/protocol';

import { SqliteEvaluationProviderAllowance } from './sqlite-evaluation-provider-allowance.js';
import { HostedEvaluationProviderCustody } from './hosted-evaluation-provider-custody.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'devrandom-provider-allowance-'));
  roots.push(stateRoot);
  const ownerAid = said('o');
  let binding: EvaluationExecutionBinding = {
    kind: 'Evaluation',
    evaluationId: randomUUID(),
    evidenceStreamId: randomUUID(),
    evaluationLeaseId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Trial', manifestSaid: said('v'), arm: 'H1', repetition: 1, attempt: 1 },
  };
  const budget = {
    providerRequests: 2,
    providerInputTokens: 20,
    providerOutputTokens: 20,
    providerSpendMicroUsd: 20,
    runWallTimeSeconds: 10,
    toolProposals: 2,
    aggregateChildCommandTimeSeconds: 10,
    changedFiles: 2,
    changedWorktreeBytes: 100,
    evidencePlusArtifactsPerRunBytes: 10_000,
  };
  const prepared = prepareEvaluationManifest({
    evaluationId: binding.evaluationId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    originRunId: binding.originRunId,
    ownerAid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: binding.harnessRevisionSaid, C1: said('1'), C2: said('2'), C3: said('3') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('y'),
    verifierSaid: said('w'),
    protectedCaseArtifactSaid: said('q'),
    finalCaseArtifactSaid: said('f'),
    publicConditionIds: ['public'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  const manifest = prepared.manifest;
  binding = {
    ...binding,
    phase: { kind: 'Trial', manifestSaid: manifest.d, arm: 'H1', repetition: 1, attempt: 1 },
  };
  const reserved = Object.fromEntries(
    Object.keys(budget).map((key) => [key, budget[key as keyof typeof budget] * 17]),
  );
  const commandId = randomUUID();
  const reservation = prepareEvidenceArtifact(
    new TextEncoder().encode(
      JSON.stringify({
        evaluationId: binding.evaluationId,
        ownerAid,
        commandId,
        originRunId: binding.originRunId,
        reserved,
      }),
    ),
    'application/json',
  );
  if (reservation.kind !== 'Prepared') throw new Error(reservation.reason);
  const current = {
    kind: 'Current' as const,
    ownerAid,
    admission: {
      commandId,
      evaluationId: binding.evaluationId,
      evidenceStreamId: binding.evidenceStreamId,
      originRunId: binding.originRunId,
      reservationSaid: reservation.artifact.d,
      leaseId: binding.evaluationLeaseId,
    },
    manifest,
    lock: {
      evaluationId: binding.evaluationId,
      manifestSaid: manifest.d,
      ownerAid,
      policySaid: manifest.policySaid,
      leaseId: binding.evaluationLeaseId,
      currentLeaseVersion: 2,
    },
    lease: {
      evaluationId: binding.evaluationId,
      leaseId: binding.evaluationLeaseId,
      version: 2,
      serverTime: '2026-09-26T12:00:00.000Z',
      expiresAt: '2026-09-26T17:00:00.000Z',
    },
    accepted: [] as {
      eventSaid: string;
      requestOrdinal: number;
      responseId: string;
      providerReportArtifactSaid: string;
      inputTokens: number;
      outputTokens: number;
      spendMicroUsd: number;
    }[],
  };
  return { stateRoot, binding, current, inspect: () => Promise.resolve(current) };
}

it('fences a request durably before provider I/O and never reuses it after crash', async () => {
  const given = fixture();
  const first = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  expect(first.kind).toBe('Opened');
  if (first.kind !== 'Opened') return;
  const maximum = {
    providerRequests: 1 as const,
    inputTokens: 10,
    outputTokens: 10,
    spendMicroUsd: 10,
  };
  expect(
    await first.allowance.reserve({ binding: given.binding, requestOrdinal: 0, maximum }),
  ).toMatchObject({ kind: 'Reserved' });
  first.allowance.close();
  const reopened = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  expect(reopened.kind).toBe('Opened');
  if (reopened.kind !== 'Opened') return;
  expect(
    await reopened.allowance.reserve({ binding: given.binding, requestOrdinal: 0, maximum }),
  ).toEqual({ kind: 'Unavailable' });
  expect(
    await reopened.allowance.reserve({ binding: given.binding, requestOrdinal: 1, maximum }),
  ).toEqual({ kind: 'Unavailable' });
  reopened.allowance.close();
});

it('serializes two parent processes and does not refund before accepted provider evidence', async () => {
  const given = fixture();
  const first = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  const second = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  if (first.kind !== 'Opened' || second.kind !== 'Opened')
    throw new Error('fixture opening failed');
  const maximum = {
    providerRequests: 1 as const,
    inputTokens: 10,
    outputTokens: 10,
    spendMicroUsd: 10,
  };
  const pair = await Promise.all([
    first.allowance.reserve({ binding: given.binding, requestOrdinal: 0, maximum }),
    second.allowance.reserve({ binding: given.binding, requestOrdinal: 0, maximum }),
  ]);
  expect(pair.map((outcome) => outcome.kind).sort()).toEqual(['Reserved', 'Unavailable']);
  const reserved = pair.find((outcome) => outcome.kind === 'Reserved');
  if (reserved?.kind !== 'Reserved') throw new Error('reservation missing');
  const usage = {
    kind: 'Verified' as const,
    providerRequests: 1 as const,
    inputTokens: 4,
    outputTokens: 2,
    spendMicroUsd: 3,
    responseId: 'response-1',
    providerReportArtifactSaid: said('r'),
  };
  expect(await first.allowance.record({ reservationId: reserved.reservationId, usage })).toEqual({
    kind: 'Recorded',
  });
  expect(
    await second.allowance.reserve({ binding: given.binding, requestOrdinal: 1, maximum }),
  ).toEqual({ kind: 'Unavailable' });
  given.current.accepted.push({
    eventSaid: said('u'),
    requestOrdinal: 0,
    responseId: usage.responseId,
    providerReportArtifactSaid: usage.providerReportArtifactSaid,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    spendMicroUsd: usage.spendMicroUsd,
  });
  expect(
    await second.allowance.reserve({ binding: given.binding, requestOrdinal: 1, maximum }),
  ).toMatchObject({ kind: 'Reserved' });
  first.allowance.close();
  second.allowance.close();
});

it('retains the full maximum when verified usage exceeds the reservation', async () => {
  const given = fixture();
  const opening = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  if (opening.kind !== 'Opened') throw new Error('fixture opening failed');
  const allowance = opening.allowance;
  const maximum = {
    providerRequests: 1 as const,
    inputTokens: 10,
    outputTokens: 10,
    spendMicroUsd: 10,
  };
  const reserved = await allowance.reserve({ binding: given.binding, requestOrdinal: 0, maximum });
  if (reserved.kind !== 'Reserved') throw new Error('reservation missing');
  expect(
    await allowance.record({
      reservationId: reserved.reservationId,
      usage: {
        kind: 'Verified',
        providerRequests: 1,
        inputTokens: 11,
        outputTokens: 2,
        spendMicroUsd: 3,
        responseId: 'response-overrun',
        providerReportArtifactSaid: said('r'),
      },
    }),
  ).toEqual({ kind: 'Exhausted' });
  allowance.close();
  const reopened = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  if (reopened.kind !== 'Opened') throw new Error('reopening failed');
  expect(
    await reopened.allowance.reserve({ binding: given.binding, requestOrdinal: 1, maximum }),
  ).toEqual({ kind: 'Unavailable' });
  reopened.allowance.close();
});

it('composes owner-scoped current position and M lock, refusing an unreadable accepted head', async () => {
  const given = fixture();
  let throughSequence = -1;
  let chainHeadSaid: string | null = null;
  const http = {
    readPosition: () =>
      Promise.resolve({
        kind: 'Read' as const,
        position: {
          version: 1 as const,
          evaluationId: given.binding.evaluationId,
          ownerAid: given.current.ownerAid,
          commandId: given.current.admission.commandId,
          originRunId: given.binding.originRunId,
          streamId: given.binding.evidenceStreamId,
          reservationSaid: given.current.admission.reservationSaid,
          lease: given.current.lease,
          acceptedThroughSequence: throughSequence,
          chainHeadSaid,
        },
      }),
    inspectManifestLock: () =>
      Promise.resolve({
        kind: 'Locked' as const,
        receipt: {
          kind: 'Locked' as const,
          ...given.current.lock,
          lockedAtLeaseVersion: 1,
          lockedAtEvaluationVersion: 2,
          currentEvaluationVersion: 2,
        },
      }),
    readEvidencePage: () => Promise.resolve({ kind: 'Conflict' as const }),
    readPublicArtifact: () => Promise.resolve({ kind: 'Missing' as const }),
  };
  const custody = new HostedEvaluationProviderCustody({
    http,
    ownerAid: given.current.ownerAid,
    admittedCommandId: given.current.admission.commandId,
    manifest: given.current.manifest,
  });
  expect(await custody.inspect(given.binding)).toMatchObject({
    kind: 'Current',
    admission: { reservationSaid: given.current.admission.reservationSaid },
    accepted: [],
  });
  throughSequence = 0;
  chainHeadSaid = said('x');
  expect(await custody.inspect(given.binding)).toEqual({ kind: 'Unavailable' });
});
