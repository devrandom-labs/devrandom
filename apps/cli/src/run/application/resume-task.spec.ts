import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunContinuationFile } from '../infrastructure/run-continuation-file.js';
import { describe, expect, it } from 'vitest';

import { acquireFirstRunLease, createEvidenceStream } from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  prepareVerifiedCheckpoint,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';

import {
  projectRun,
  prepareRunSuccessorSegment,
  taskBudgetCeilings,
  type TaskProjection,
  type ActiveHarnessPointer,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import { createRun, continueRun } from '@devrandom/domain';
import { resumeTask } from './resume-task.js';

const runOwnerAid = `E${'a'.repeat(43)}`;
const runCommandId = 'd2c9160a-58f8-4d43-ae67-22124c6e9112';
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const runHarnessSaid = `E${'b'.repeat(43)}`;

function runFixture() {
  const created = createRun({
    runId,
    ownerAid: runOwnerAid,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: `E${'d'.repeat(43)}`,
    harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
    personalAgentAid: `E${'e'.repeat(43)}`,
    taskMandateSaid: `E${'f'.repeat(43)}`,
    governorAid: `E${'g'.repeat(43)}`,
    promotionMandateSaid: `E${'h'.repeat(43)}`,
    initialHarnessRevisionSaid: runHarnessSaid,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
      harnessRevisionSaid: runHarnessSaid,
      runId: 'ff6774df-9797-4295-8e74-a974819babec',
      acceptedAt: '2026-09-24T19:55:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: runCommandId,
    admissionExchangeSaid: `E${'i'.repeat(43)}`,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('expected a valid Run fixture');
  }
  return created.run;
}

const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const at = '2026-09-24T20:00:01.000Z';

function fixture(
  extraBeforeCheckpoint: readonly EvidenceEventDetail[] = [],
  reason: 'CheckpointPause' | 'HarnessCompatibilityFailure' = 'CheckpointPause',
) {
  const initial = runFixture();
  const leased = acquireFirstRunLease(initial, {
    incarnationId,
    expectedRunVersion: initial.version,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('lease fixture');
  const events: EvidenceEvent[] = [];
  function add(detail: EvidenceEventDetail) {
    const sequence = events.length;
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence,
      predecessor:
        sequence === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: events[sequence - 1]?.d ?? '' },
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      personalAgentAid: initial.binding.personalAgentAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      occurredAt: at,
      recordedAt: at,
      producer: { kind: 'RunSupervisor' },
      event: detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('event fixture');
    events.push(prepared.event);
  }
  add({ kind: 'RunStarted', fromRunVersion: leased.run.version });
  add({ kind: 'IncarnationStarted' });
  for (const detail of extraBeforeCheckpoint) add(detail);
  const head = events.at(-1);
  if (head === undefined) throw new Error('head fixture');
  const preparedCheckpoint = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      harnessLineageId: initial.binding.harnessLineageId,
      personalAgentAid: initial.binding.personalAgentAid,
      governorAid: initial.binding.governorAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      promotionMandateSaid: initial.binding.promotionMandateSaid,
      purpose: initial.binding.purpose,
      repository: {
        objectFormat: 'sha1',
        baseCommit: initial.binding.repository.commit,
        baseTree: initial.binding.repository.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [],
      evidence: {
        eventCount: events.length,
        finalSequence: head.sequence,
        chainHeadSaid: head.d,
      },
      budget: { consumed: leased.run.consumedBudget, remaining: initial.binding.budget },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason },
        verification: { kind: 'NotSubmitted' },
      },
      continuation: {
        kind:
          reason === 'HarnessCompatibilityFailure'
            ? 'LaterHarnessCompatibilityResolutionRequired'
            : 'LaterRuntimeRecoveryRequired',
      },
    },
    [],
  );
  if (preparedCheckpoint.kind !== 'Prepared') throw new Error('checkpoint fixture');
  const checkpoint = preparedCheckpoint.checkpoint;
  add({ kind: 'RunBlocked', reason, checkpointSaid: checkpoint.d });
  const last = events.at(-1);
  if (last === undefined) throw new Error('last fixture');
  const run = {
    ...leased.run,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason,
        checkpointSaid: checkpoint.d,
      },
    },
  };
  const createdStream = createEvidenceStream({
    streamId: initial.binding.evidenceStreamId,
    runId: initial.binding.runId,
    ownerAid: initial.binding.ownerAid,
    taskId: initial.binding.taskId,
    taskRevisionSaid: initial.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
    personalAgentAid: initial.binding.personalAgentAid,
    taskMandateSaid: initial.binding.taskMandateSaid,
    combinedByteCeiling: initial.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (createdStream.kind !== 'Created') throw new Error('stream fixture');
  const stream = {
    ...createdStream.stream,
    cursor: { kind: 'Continued' as const, acceptedThrough: last.sequence, chainHeadSaid: last.d },
    provisional: {
      kind: 'Checkpointed' as const,
      checkpointSaid: checkpoint.d,
      lifecycle: run.lifecycle,
      submissionVerification: run.submissionVerification,
    },
    seal: { kind: 'Sealed' as const, exchangeSaid: `E${'s'.repeat(43)}`, sealedAt: at },
  };
  return {
    run,
    stream,
    checkpoint,
    events,
    sealExchangeSaid: stream.seal.exchangeSaid,
    chainHeadSaid: last.d,
    completionConditionIds: [],
  };
}

function preparation() {
  const f = fixture([], 'HarnessCompatibilityFailure');
  const task = {
    taskId: f.run.binding.taskId,
    revisionSaid: f.run.binding.taskRevisionSaid,
    ownerAid: f.run.binding.ownerAid,
    harnessLineageId: f.run.binding.harnessLineageId,
    lifecycle: { kind: 'Open' },
    revision: { completionConditions: [] },
  } as unknown as TaskProjection;
  const activation = {
    kind: 'Committed',
    disposition: 'Activated',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    pointerVersion: 2,
    activeRevisionSaid: 'E' + 'z'.repeat(43),
    decisionReceiptSaid: 'E' + 'r'.repeat(43),
  } as ActiveHarnessPointer;
  const stream = {
    runId: f.run.binding.runId,
    evidenceStreamId: f.run.binding.evidenceStreamId,
    cursor: {
      kind: 'Accepted',
      eventCount: f.events.length,
      acceptedThroughSequence: f.events.length - 1,
      chainHeadSaid: f.chainHeadSaid,
    },
    checkpoint: { kind: 'Accepted', checkpointSaid: f.checkpoint.d },
    seal: { kind: 'Sealed', sealExchangeSaid: f.sealExchangeSaid, sealedAt: at },
  } as EvidenceStreamProjection;
  return {
    ownerAid: f.run.binding.ownerAid,
    task,
    run: f.run,
    activation,
    predecessor: { checkpoint: f.checkpoint, events: f.events, artifacts: [], stream },
    worktree: {
      directory: '/retained',
      branch: `devrandom/run/${f.run.binding.runId}`,
      repository: f.run.binding.repository,
    },
  };
}
describe('same Run resumption caller boundary', () => {
  it('does not seek a replacement lease when current authority is rejected or retained bytes differ', async () => {
    const input = preparation();
    let admissions = 0;
    const dependencies = {
      authority: { verify: () => Promise.resolve({ kind: 'Rejected' as const }) },
      repository: { capture: () => Promise.resolve({ kind: 'GitUnavailable' as const }) },
      commands: {
        acquire: () => Promise.resolve({ kind: 'Unavailable' as const }),
        recordReceipt: () => Promise.resolve({ kind: 'Unavailable' as const }),
      },
      hosted: {
        admitContinuation: () => {
          admissions++;
          return Promise.resolve({ kind: 'ServerUnavailable' as const });
        },
      },
      now: () => '2026-09-24T20:01:00.000Z',
      monotonicNow: () => 1,
    };
    expect(await resumeTask(input, dependencies, new AbortController().signal)).toEqual({
      kind: 'AuthorityRejected',
    });
    expect(
      await resumeTask(
        input,
        {
          ...dependencies,
          authority: { verify: () => Promise.resolve({ kind: 'Current' as const }) },
        },
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'ArtifactMismatch' });
    expect(admissions).toBe(0);
  });
  it('admits exactly the sealed predecessor with residual budget into a fresh H2 segment', async () => {
    const input = preparation();
    const run = input.run;
    if (run.lease.kind !== 'Held') throw new Error('lease');
    const incarnationId = run.lease.incarnationId;
    const successorIncarnationId = '10000000-0000-4000-8000-000000000001',
      successorStreamId = '10000000-0000-4000-8000-000000000002';
    let receipts = 0;
    const result = await resumeTask(
      input,
      {
        authority: { verify: () => Promise.resolve({ kind: 'Current' }) },
        repository: {
          capture: () =>
            Promise.resolve({
              kind: 'Captured',
              changedWorktreeBytes: 0,
              repository:
                input.predecessor.checkpoint.version === 1
                  ? input.predecessor.checkpoint.repository
                  : ({} as never),
              artifacts: [],
            }),
        },
        commands: {
          acquire: ({ command }) =>
            Promise.resolve({
              kind: 'Recorded',
              command: { ...command, successorIncarnationId, successorStreamId },
            }),
          recordReceipt: () => {
            receipts++;
            return Promise.resolve({ kind: 'Recorded' as const });
          },
        },
        hosted: {
          admitContinuation: (_runId, command) => {
            const segment = prepareRunSuccessorSegment({
              kind: 'RunSuccessorSegment',
              version: 1,
              runId: run.binding.runId,
              taskId: run.binding.taskId,
              taskRevisionSaid: run.binding.taskRevisionSaid,
              ownerAid: run.binding.ownerAid,
              personalAgentAid: run.binding.personalAgentAid,
              taskMandateSaid: run.binding.taskMandateSaid,
              fromRunVersion: run.version,
              predecessor: {
                incarnationId,
                evidenceStreamId: run.binding.evidenceStreamId,
                checkpointSaid: command.predecessorCheckpointSaid,
                sealExchangeSaid: command.predecessorSealSaid,
                finalSequence: input.predecessor.events.length - 1,
                chainHeadSaid: command.predecessorHeadSaid,
              },
              successor: {
                incarnationId: successorIncarnationId,
                evidenceStreamId: successorStreamId,
                harnessRevisionSaid: input.activation.activeRevisionSaid,
              },
              activation: {
                pointerVersion: 2,
                decisionReceiptSaid: command.expectedActivationReceiptSaid,
              },
              consumedBudget: run.consumedBudget,
              admittedAt: '2026-09-24T20:01:00.000Z',
            });
            if (segment.kind !== 'Prepared') throw new Error('segment');
            const continued = continueRun(run, {
              expectedRunVersion: run.version,
              serverTime: segment.segment.admittedAt,
              predecessor: {
                incarnationId,
                evidenceStreamId: run.binding.evidenceStreamId,
                checkpointSaid: command.predecessorCheckpointSaid,
              },
              successor: { segmentSaid: segment.segment.d, ...segment.segment.successor },
              activation: {
                pointerVersion: 2,
                activeRevisionSaid: input.activation.activeRevisionSaid,
                decisionReceiptSaid: command.expectedActivationReceiptSaid,
              },
              effects: 'Settled',
            });
            if (continued.kind !== 'Admitted') throw new Error('continue');
            return Promise.resolve({
              kind: 'Admitted' as const,
              receipt: {
                version: 1,
                disposition: 'Admitted',
                run: projectRun(continued.run),
                segment: segment.segment,
              },
            });
          },
        },
        now: () => '2026-09-24T20:01:00.000Z',
        monotonicNow: () => 123,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: 'Admitted',
      leaseRequestStartedAt: 123,
      run: {
        binding: run.binding,
        consumedBudget: run.consumedBudget,
        currentExecution: { evidenceStreamId: successorStreamId },
      },
    });
    expect(receipts).toBe(1);
  });
});

it('retains the authenticated predecessor for an admission reply lost across process death', async () => {
  const input = preparation();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'run-predecessor-')));
  try {
    const first = new RunContinuationFile(root, () => '10000000-0000-4000-8000-000000000001');
    const predecessor = {
      run: projectRun(input.run),
      stream: {
        ...input.predecessor.stream,
        version: 1 as const,
        seal: {
          kind: 'Sealed' as const,
          sealExchangeSaid: 'E' + 's'.repeat(43),
          eventCount: input.predecessor.events.length,
          finalSequence: input.predecessor.events.length - 1,
          chainHeadSaid: input.predecessor.events.at(-1)?.d ?? '',
          sealedAt: at,
        },
      },
      events: input.predecessor.events,
    };
    expect(await first.retainPredecessor(predecessor)).toBe('Recorded');
    const restarted = new RunContinuationFile(root, () => {
      throw new Error('must not generate another identity');
    });
    expect(await restarted.readPredecessor(input.run.binding.runId, input.run.version)).toEqual(
      predecessor,
    );
    expect(
      await restarted.retainPredecessor({ ...predecessor, events: predecessor.events.slice(1) }),
    ).toBe('Rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
