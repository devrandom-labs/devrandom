import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { EvaluationExecutionBinding } from '@devrandom/domain';
import {
  prepareEvaluationManifest,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationPolicy,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import { SqliteEvaluationProviderAllowance } from './sqlite-evaluation-provider-allowance.js';
import { HostedEvaluationEvidenceReading } from './hosted-evaluation-evidence-reading.js';
import { HostedEvaluationProviderCustody } from './hosted-evaluation-provider-custody.js';
import { HostedEvaluationResearchProviderCustody } from './hosted-evaluation-research-provider-custody.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-26T12:00:00.000Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
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
      phase: EvaluationExecutionBinding['phase'];
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

it.each([false, true])(
  'reserves repeated research under D, preserving unresolved crash fence=%s',
  async (crash) => {
    const given = fixture();
    const manifest = given.current.manifest;
    const prepared = prepareEvaluationPolicy({
      taskId: manifest.taskId,
      taskRevisionSaid: manifest.taskRevisionSaid,
      originRunId: manifest.originRunId,
      expectedActiveRevisionSaid: manifest.revisions.H1,
      executionProfileSaid: manifest.executionProfileSaid,
      sourceInventorySaid: manifest.sourceInventorySaid,
      comparisonLaw: 'ThreeRepetitionsTwoAttemptsPublicSearch',
      allocation: manifest.allocation,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const research: EvaluationExecutionBinding = {
      ...given.binding,
      phase: { kind: 'Research', policySaid: prepared.policy.d, role: 'DiagnosticRefiner' },
    };
    const custody = {
      inspect: () =>
        Promise.resolve({
          kind: 'ResearchCurrent' as const,
          ownerAid: given.current.ownerAid,
          admission: given.current.admission,
          policy: prepared.policy,
          lease: given.current.lease,
          accepted: given.current.accepted,
        }),
    };
    const command = {
      version: 1 as const,
      commandId: given.current.admission.commandId,
      fingerprint: `sha256:${'a'.repeat(64)}`,
      taskId: research.taskId,
      taskRevisionSaid: research.taskRevisionSaid,
      originRunId: research.originRunId,
      retainedCheckpointSaid: manifest.retainedCheckpointSaid,
      retainedSealSaid: manifest.retainedSealSaid,
      expectedActiveRevisionSaid: research.harnessRevisionSaid,
      personalAgentAid: research.personalAgentAid,
      taskMandateSaid: research.taskMandateSaid,
      policySaid: prepared.policy.d,
      executionProfileSaid: prepared.policy.executionProfileSaid,
      sourceInventorySaid: prepared.policy.sourceInventorySaid,
      allocation: prepared.policy.allocation,
    };
    const hosted = new HostedEvaluationResearchProviderCustody({
      ownerAid: given.current.ownerAid,
      policy: prepared.policy,
      command,
      http: {
        admit: () =>
          Promise.resolve({
            kind: 'Admitted',
            evaluationId: research.evaluationId,
            version: 1,
            lease: given.current.lease,
            evidenceStreamId: research.evidenceStreamId,
            reservationSaid: given.current.admission.reservationSaid,
          }),
        readPosition: () =>
          Promise.resolve({
            kind: 'Read',
            position: {
              version: 1,
              currentEvaluationVersion: 1,
              evaluationId: research.evaluationId,
              ownerAid: given.current.ownerAid,
              commandId: command.commandId,
              originRunId: research.originRunId,
              streamId: research.evidenceStreamId,
              reservationSaid: given.current.admission.reservationSaid,
              lease: given.current.lease,
              acceptedThroughSequence: -1,
              chainHeadSaid: null,
            },
          }),
        readEvidencePage: () => Promise.resolve({ kind: 'Unavailable' }),
        readPublicArtifact: () => Promise.resolve({ kind: 'Unavailable' }),
      },
    });
    expect(await hosted.inspect(research)).toEqual(await custody.inspect());
    expect(await hosted.inspect({ ...research, taskMandateSaid: said('z') })).toEqual({
      kind: 'Lost',
    });
    const opened = await SqliteEvaluationProviderAllowance.open(given.stateRoot, research, custody);
    expect(opened.kind).toBe('Opened');
    if (opened.kind !== 'Opened') return;
    const maximum = {
      providerRequests: 1 as const,
      inputTokens: 10,
      outputTokens: 10,
      spendMicroUsd: 10,
    };
    expect(
      await opened.allowance.reserve({
        binding: research,
        requestOrdinal: 0,
        maximum: { ...maximum, inputTokens: 21 },
      }),
    ).toEqual({ kind: 'Exhausted' });
    const first = await opened.allowance.reserve({ binding: research, requestOrdinal: 0, maximum });
    expect(first.kind).toBe('Reserved');
    if (first.kind !== 'Reserved') throw new Error('first research reservation');
    if (!crash) {
      const usage = {
        kind: 'Verified' as const,
        ...maximum,
        responseId: 'research-1',
        providerReportArtifactSaid: said('r'),
      };
      expect(await opened.allowance.record({ reservationId: first.reservationId, usage })).toEqual({
        kind: 'Recorded',
      });
      given.current.accepted.push({
        eventSaid: said('u'),
        phase: research.phase,
        requestOrdinal: 0,
        responseId: usage.responseId,
        providerReportArtifactSaid: usage.providerReportArtifactSaid,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        spendMicroUsd: usage.spendMicroUsd,
      });
    }
    opened.allowance.close();
    const reopened = await SqliteEvaluationProviderAllowance.open(
      given.stateRoot,
      research,
      custody,
    );
    expect(reopened.kind).toBe('Opened');
    if (reopened.kind !== 'Opened') return;
    const nextBinding: EvaluationExecutionBinding = {
      ...research,
      phase: { kind: 'Research', policySaid: prepared.policy.d, role: 'CandidateWorker' },
    };
    if (!crash) {
      const proof = given.current.accepted[0];
      if (proof === undefined) throw new Error('research proof');
      proof.phase = { kind: 'Research', policySaid: said('z'), role: 'DiagnosticRefiner' };
      expect(
        await reopened.allowance.reserve({ binding: nextBinding, requestOrdinal: 1, maximum }),
      ).toEqual({ kind: 'Unavailable' });
      proof.phase = research.phase;
    }
    const next = await reopened.allowance.reserve({
      binding: nextBinding,
      requestOrdinal: 1,
      maximum,
    });
    expect(next.kind).toBe(crash ? 'Unavailable' : 'Reserved');
    if (next.kind === 'Reserved') {
      const usage = {
        kind: 'Verified' as const,
        ...maximum,
        responseId: 'research-2',
        providerReportArtifactSaid: said('s'),
      };
      expect(await reopened.allowance.record({ reservationId: next.reservationId, usage })).toEqual(
        { kind: 'Recorded' },
      );
      given.current.accepted.push({
        eventSaid: said('v'),
        phase: nextBinding.phase,
        requestOrdinal: 1,
        responseId: usage.responseId,
        providerReportArtifactSaid: usage.providerReportArtifactSaid,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        spendMicroUsd: usage.spendMicroUsd,
      });
      expect(
        await reopened.allowance.reserve({ binding: research, requestOrdinal: 2, maximum }),
      ).toEqual({ kind: 'Exhausted' });
    }
    reopened.allowance.close();
  },
);

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
  // Recreate the original schema to prove an existing uncertain request survives migration.
  const legacy = new DatabaseSync(
    join(given.stateRoot, 'evaluations', given.binding.evaluationId, 'provider-allowance.sqlite'),
  );
  legacy.exec('ALTER TABLE reservations RENAME TO saved_reservations');
  legacy.exec(
    'CREATE TABLE reservations (reservation_id TEXT PRIMARY KEY, request_ordinal INTEGER NOT NULL UNIQUE, slot_key TEXT NOT NULL, attempt_key TEXT NOT NULL, maximum_json TEXT NOT NULL, state TEXT NOT NULL, usage_json TEXT)',
  );
  legacy.exec('INSERT INTO reservations SELECT * FROM saved_reservations');
  legacy.exec('DROP TABLE saved_reservations');
  legacy.close();
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
    phase: given.binding.phase,
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
          currentEvaluationVersion: 2,
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

it('reuses immutable prefixes across provider custodians while rechecking current authority', async () => {
  const given = fixture();
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: given.binding.evaluationId,
    originRunId: given.binding.originRunId,
    taskId: given.binding.taskId,
    taskRevisionSaid: given.binding.taskRevisionSaid,
    personalAgentAid: given.binding.personalAgentAid,
    taskMandateSaid: given.binding.taskMandateSaid,
    harnessRevisionSaid: given.binding.harnessRevisionSaid,
    phase: given.binding.phase,
    streamId: given.binding.evidenceStreamId,
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T12:00:00.000Z',
    detail: { kind: 'TrialStopped', reason: 'Completed' },
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  const head = prepared.event;
  const throughSequence = 0;
  const chainHeadSaid = head.d;
  let available = true;
  const http = {
    readPosition: vi.fn(() =>
      Promise.resolve(
        available
          ? {
              kind: 'Read' as const,
              position: {
                version: 1 as const,
                currentEvaluationVersion: 2,
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
            }
          : { kind: 'Unavailable' as const },
      ),
    ),
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
    readEvidencePage: vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: given.binding.evaluationId,
          streamId: given.binding.evidenceStreamId,
          afterSequence: -1,
          throughSequence,
          throughHeadSaid: head.d,
          events: [head],
        },
      }),
    ),
    readPublicArtifact: () => Promise.resolve({ kind: 'Missing' as const }),
  };
  const reading = new HostedEvaluationEvidenceReading(http);
  for (let index = 0; index < 2; index += 1) {
    const custody = new HostedEvaluationProviderCustody({
      http,
      reading,
      ownerAid: given.current.ownerAid,
      admittedCommandId: given.current.admission.commandId,
      manifest: given.current.manifest,
    });
    expect(await custody.inspect(given.binding)).toMatchObject({ kind: 'Current' });
  }
  // Two fresh head reads, but only one immutable full-prefix read.
  expect(http.readEvidencePage).toHaveBeenCalledTimes(3);
  available = false;
  const lost = new HostedEvaluationProviderCustody({
    http,
    reading,
    ownerAid: given.current.ownerAid,
    admittedCommandId: given.current.admission.commandId,
    manifest: given.current.manifest,
  });
  expect(await lost.inspect(given.binding)).toEqual({ kind: 'Unavailable' });
});

it('starts each exact Trial slot at ordinal zero while retaining shared accounting and retry fences', async () => {
  const given = fixture();
  const opened = await SqliteEvaluationProviderAllowance.open(given.stateRoot, given.binding, {
    inspect: given.inspect,
  });
  if (opened.kind !== 'Opened') throw new Error('fixture opening failed');
  const maximum = {
    providerRequests: 1 as const,
    inputTokens: 10,
    outputTokens: 10,
    spendMicroUsd: 10,
  };
  try {
    for (const slot of given.current.manifest.slots) {
      const binding: EvaluationExecutionBinding = {
        ...given.binding,
        harnessRevisionSaid:
          given.current.manifest.revisions[slot.arm === 'H1TaskSearch' ? 'H1' : slot.arm],
        phase: { kind: 'Trial', manifestSaid: given.current.manifest.d, ...slot },
      };
      const reservation = await opened.allowance.reserve({ binding, requestOrdinal: 0, maximum });
      expect(reservation.kind, JSON.stringify(slot)).toBe('Reserved');
      if (reservation.kind !== 'Reserved') throw new Error('reservation');
      const usage = {
        kind: 'Verified' as const,
        ...maximum,
        responseId: JSON.stringify(slot),
        providerReportArtifactSaid: said('r'),
      };
      expect(
        await opened.allowance.record({ reservationId: reservation.reservationId, usage }),
      ).toEqual({ kind: 'Recorded' });
      expect(
        await opened.allowance.record({ reservationId: reservation.reservationId, usage }),
      ).toEqual({ kind: 'Recorded' });
      given.current.accepted.push({
        eventSaid: said('u'),
        phase: binding.phase,
        requestOrdinal: 0,
        responseId: usage.responseId,
        providerReportArtifactSaid: usage.providerReportArtifactSaid,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        spendMicroUsd: usage.spendMicroUsd,
      });
      const proof = given.current.accepted.at(-1);
      if (proof === undefined || proof.phase.kind !== 'Trial') throw new Error('proof fixture');
      proof.phase = { ...proof.phase, repetition: proof.phase.repetition === 1 ? 2 : 1 };
      expect(await opened.allowance.reserve({ binding, requestOrdinal: 1, maximum })).toEqual({
        kind: 'Unavailable',
      });
      proof.phase = binding.phase;
      expect(await opened.allowance.reserve({ binding, requestOrdinal: 0, maximum })).toEqual({
        kind: 'Unavailable',
      });
      if (slot.arm === 'H1TaskSearch')
        expect(await opened.allowance.reserve({ binding, requestOrdinal: 1, maximum })).toEqual({
          kind: 'Exhausted',
        });
    }
  } finally {
    opened.allowance.close();
  }
});
