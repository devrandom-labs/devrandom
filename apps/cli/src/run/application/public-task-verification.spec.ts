import { prepareEvidenceEvent } from '@devrandom/protocol';
import { acquireFirstRunLease, startRunExecution, type Run } from '@devrandom/domain';
import { decodeRunProjection } from '@devrandom/protocol';
import type { EvidenceObservation, EvidenceRecorder, EvidenceRecording } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import type { CapturedChildOutput, ExactChildCommands } from './exact-child-command.js';
import type { ProcessOutputEvidence } from './process-output-evidence.js';
import { PublicTaskVerification } from './public-task-verification.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function capturedOutput(): CapturedChildOutput {
  return {
    disclosure: { kind: 'Recordable' as const },
    stdout: { path: '/output/stdout', byteLength: 10 },
    stderr: { path: '/output/stderr', byteLength: 20 },
    acknowledge: () => Promise.resolve({ kind: 'Cleaned' }),
  };
}

function runningRun(): Run {
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') {
    throw new Error('fixture Run projection must decode');
  }
  const leased = acquireFirstRunLease(decoded.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('fixture Run lease must be acquired');
  }
  if (leased.run.lease.kind !== 'Held') {
    throw new Error('acquired fixture Run must hold its lease');
  }
  const started = startRunExecution(leased.run, {
    incarnationId: leased.run.lease.incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') {
    throw new Error('fixture Run must start');
  }
  return started.run;
}

function recorder(observations: EvidenceObservation[]): EvidenceRecorder {
  const run = runningRun();
  let sequence = 0;
  let predecessor: string | undefined;
  return {
    run,
    readiness: () => ({
      kind: 'Ready',
      readiness: { kind: 'Genesis', streamId: run.binding.evidenceStreamId },
    }),
    recordBudgetDebit: () => ({ kind: 'Unavailable' }),
    withhold: () => ({ kind: 'Unavailable' }),
    record(observation): EvidenceRecording {
      observations.push(observation);
      if (run.lease.kind !== 'Held') {
        return { kind: 'ObservationRejected' };
      }
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          predecessor === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: predecessor },
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: run.lease.incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      if (prepared.kind !== 'Prepared') {
        return { kind: 'ObservationRejected' };
      }
      sequence += 1;
      predecessor = prepared.event.d;
      return { kind: 'Recorded', event: prepared.event };
    },
    page: () => ({ kind: 'Empty' }),
    acknowledge: () => ({ kind: 'AcknowledgementRejected' }),
    storeArtifact: () => ({ kind: 'ArtifactRejected' }),
    artifact: () => ({ kind: 'ArtifactNotFound' }),
    storeCheckpoint: () => ({ kind: 'CheckpointRejected' }),
    checkpoint: () => ({ kind: 'CheckpointNotFound' }),
    recordCheckpointAcceptance: () => ({ kind: 'Unavailable' }),
    recordSealAcknowledgement: () => ({ kind: 'AcknowledgementRejected' }),
    sealAcknowledgement: () => ({ kind: 'NotFound' }),
    close: vi.fn(),
  };
}

describe('public Task verification', () => {
  it('rejects an unavailable submitted artifact before recording submission or running a verifier', async () => {
    const observations: EvidenceObservation[] = [];
    const run = vi.fn<ExactChildCommands['run']>();
    const verification = new PublicTaskVerification({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      evidence: recorder(observations),
      commands: { run },
      processOutput: { record: vi.fn() },
      now: () => '2026-09-24T20:00:03.000Z',
    });

    await expect(
      verification.verify({ artifactSaids: [said('z')] }, new AbortController().signal),
    ).resolves.toEqual({ kind: 'ArtifactUnavailable' });
    expect(observations).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves the SQLite outbox and permits a corrected submission after an unavailable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-submission-artifact-'));
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot, { mode: 0o700 });
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run: runningRun(),
      stateRoot,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    try {
      const commands = { run: vi.fn<ExactChildCommands['run']>() };
      const verification = new PublicTaskVerification({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        evidence: opened.recorder,
        commands,
        processOutput: { record: vi.fn() },
        now: () => '2026-09-24T20:00:03.000Z',
      });
      const signal = new AbortController().signal;
      await expect(verification.verify({ artifactSaids: [said('z')] }, signal)).resolves.toEqual({
        kind: 'ArtifactUnavailable',
      });
      expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
      expect(commands.run).not.toHaveBeenCalled();

      commands.run.mockResolvedValueOnce({ kind: 'DependencyUnavailable' });
      await verification.verify({ artifactSaids: [] }, signal);
      const page = opened.recorder.page();
      if (page.kind !== 'Page') throw new Error('corrected submission must record evidence');
      expect(page.page.events[0]?.event).toEqual({ kind: 'ResultSubmitted', artifactSaids: [] });
      expect(commands.run).toHaveBeenCalledOnce();
    } finally {
      opened.recorder.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['ProcessGroupSurvived', 'ProcessCleanupUnconfirmed'] as const)(
    'records %s without accepting or rejecting task correctness',
    async (kind) => {
      const observations: EvidenceObservation[] = [];
      const verification = new PublicTaskVerification({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        evidence: recorder(observations),
        commands: {
          run: () =>
            Promise.resolve({
              kind,
              exitCode: 0,
              terminationSignal: null,
              elapsedMilliseconds: 3_000,
              output: capturedOutput(),
            }),
        },
        processOutput: {
          record: () =>
            Promise.resolve({
              kind: 'Recorded',
              stdoutArtifactSaid: said('x'),
              stderrArtifactSaid: said('y'),
              feedback: 'expected 3, received 4',
            }),
        },
        now: () => '2026-09-24T20:00:03.000Z',
      });

      await expect(
        verification.verify({ artifactSaids: [] }, new AbortController().signal),
      ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
      expect(observations.map(({ event }) => event.kind)).toEqual([
        'ResultSubmitted',
        'Observation',
        'Observation',
        'SecurityViolation',
      ]);
      expect(observations.at(-1)?.event).toEqual({
        kind: 'SecurityViolation',
        violation: kind === 'ProcessGroupSurvived' ? 'ProcessSurvivedTermination' : kind,
      });
    },
  );

  it.each(['BeforeExecution', 'AfterExecution'] as const)(
    'keeps verification unresolved for footprint exhaustion %s and retains observed output',
    async (timing) => {
      const observations: EvidenceObservation[] = [];
      const output = capturedOutput();
      const run = vi.fn<ExactChildCommands['run']>(() =>
        Promise.resolve(
          timing === 'BeforeExecution'
            ? { kind: 'WorktreeAdmissionRejected', failure: 'BudgetExhausted' }
            : {
                kind: 'WorktreeReconciliationFailed',
                failure: 'BudgetExhausted',
                execution: {
                  kind: 'Completed',
                  exitCode: 0,
                  terminationSignal: null,
                  elapsedMilliseconds: 10,
                  output,
                },
              },
        ),
      );
      const record = vi.fn<ProcessOutputEvidence['record']>(() =>
        Promise.resolve({
          kind: 'Recorded',
          stdoutArtifactSaid: said('x'),
          stderrArtifactSaid: said('y'),
          feedback: 'expected 3, received 4',
        }),
      );
      const verification = new PublicTaskVerification({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        evidence: recorder(observations),
        commands: { run },
        processOutput: { record },
        now: () => '2026-09-24T20:00:03.000Z',
      });
      await expect(
        verification.verify({ artifactSaids: [] }, new AbortController().signal),
      ).resolves.toEqual({
        kind: 'Blocked',
        reason: 'BudgetExhausted',
        receipts: verification.unresolvedReceipts('RunBlocked'),
        outputArtifactSaids: timing === 'BeforeExecution' ? [] : [said('x'), said('y')],
      });
      expect(run).toHaveBeenCalledOnce();
      if (timing === 'BeforeExecution') {
        expect(record).not.toHaveBeenCalled();
        expect(observations.map(({ event }) => event)).toEqual([
          { kind: 'ResultSubmitted', artifactSaids: [] },
        ]);
      } else {
        expect(record).toHaveBeenCalledExactlyOnceWith(output);
        expect(observations.map(({ event }) => event)).toEqual([
          { kind: 'ResultSubmitted', artifactSaids: [] },
          { kind: 'Observation', source: 'Verifier', artifactSaid: said('x') },
          { kind: 'Observation', source: 'Verifier', artifactSaid: said('y') },
        ]);
      }
    },
  );

  it('stops with evidence integrity failure when a verifier command has no lawful outcome', async () => {
    const observations: EvidenceObservation[] = [];
    const run = vi.fn<ExactChildCommands['run']>(() =>
      Promise.reject(new Error('untrusted command error')),
    );
    const record = vi.fn<ProcessOutputEvidence['record']>();
    const verification = new PublicTaskVerification({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      evidence: recorder(observations),
      commands: { run },
      processOutput: { record },
      now: () => '2026-09-24T20:00:03.000Z',
    });
    await expect(
      verification.verify({ artifactSaids: [] }, new AbortController().signal),
    ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
    expect(run).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
    expect(observations.map(({ event }) => event)).toEqual([
      { kind: 'ResultSubmitted', artifactSaids: [] },
    ]);
    expect(verification.unresolvedReceipts('RunBlocked')).toMatchObject([
      { outcome: { kind: 'Unresolved', reason: 'RunBlocked' } },
    ]);
  });

  it('leaves verification unresolved when a command aborts before starting', async () => {
    const observations: EvidenceObservation[] = [];
    const record = vi.fn<ProcessOutputEvidence['record']>();
    const verification = new PublicTaskVerification({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      evidence: recorder(observations),
      commands: { run: () => Promise.resolve({ kind: 'AbortedBeforeStart' }) },
      processOutput: { record },
      now: () => '2026-09-24T20:00:03.000Z',
    });

    const outcome = await verification.verify({ artifactSaids: [] }, new AbortController().signal);

    expect(outcome).toEqual({
      kind: 'Blocked',
      reason: 'EffectAborted',
      receipts: verification.unresolvedReceipts('RunBlocked'),
      outputArtifactSaids: [],
    });
    expect(record).not.toHaveBeenCalled();
    expect(observations.map(({ event }) => event.kind)).toEqual(['ResultSubmitted']);
  });

  it('describes every unattempted condition with a truthful verifier receipt', () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const run = vi.fn<ExactChildCommands['run']>();
    const verification = new PublicTaskVerification({
      task,
      harness,
      evidence: recorder([]),
      commands: { run },
      processOutput: { record: vi.fn() },
      now: () => '2026-09-24T20:00:03.000Z',
    });

    expect(verification.unresolvedReceipts('NotAttempted')).toMatchObject([
      {
        completionConditionId: 'public-test',
        commandSaid: harness.completionCommands[0]?.contentSaid,
        outcome: { kind: 'Unresolved', reason: 'NotAttempted' },
      },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it('turns the exact H1 command failure into an attributable rejected receipt', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const observations: EvidenceObservation[] = [];
    const evidence = recorder(observations);
    const run = vi.fn<ExactChildCommands['run']>(() =>
      Promise.resolve({
        kind: 'ExitCodeMismatch',
        exitCode: 1,
        terminationSignal: null,
        elapsedMilliseconds: 25,
        output: capturedOutput(),
      }),
    );
    const record = vi.fn<ProcessOutputEvidence['record']>(() =>
      Promise.resolve({
        kind: 'Recorded',
        stdoutArtifactSaid: said('x'),
        stderrArtifactSaid: said('y'),
        feedback: 'expected 3, received 4',
      }),
    );
    const commands: ExactChildCommands = { run };
    const processOutput: ProcessOutputEvidence = { record };
    const verification = new PublicTaskVerification({
      task,
      harness,
      evidence,
      commands,
      processOutput,
      now: () => '2026-09-24T20:00:03.000Z',
    });

    const outcome = await verification.verify({ artifactSaids: [] }, new AbortController().signal);

    expect(outcome).toMatchObject({
      kind: 'Rejected',
      receipts: [
        {
          completionConditionId: 'public-test',
          commandSaid: harness.completionCommands[0]?.contentSaid,
          outcome: {
            kind: 'Rejected',
            reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 1 },
            outputArtifactSaids: [said('x'), said('y')],
          },
        },
      ],
    });
    if (outcome.kind !== 'Rejected') throw new Error('failed test must reject verification');
    expect(outcome.feedback).toContain('expected 3, received 4');
    expect(outcome.feedback).toContain('public-test');
    expect(outcome.feedback).toContain('UnexpectedExitCode');
    expect(run).toHaveBeenCalledOnce();
    const invocation = run.mock.calls[0];
    if (invocation === undefined) throw new Error('public verifier command must run');
    expect(invocation[0]).toEqual({
      executableRealpath: harness.completionCommands[0]?.executableRealpath,
      arguments: ['test-public'],
      timeoutSeconds: 120,
      expectedExitCode: 0,
      budgetProducer: { kind: 'PublicTaskVerifier' },
    });
    expect(invocation[1]).toBeInstanceOf(AbortSignal);
    expect(observations.map(({ event }) => event.kind)).toEqual([
      'ResultSubmitted',
      'Observation',
      'Observation',
      'TaskVerificationRejected',
    ]);
  });

  it('fails closed before a child command when the Task, H1, and Run binding diverge', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const run = vi.fn<ExactChildCommands['run']>();
    const commands: ExactChildCommands = { run };
    const verification = new PublicTaskVerification({
      task: { ...task, revisionSaid: said('z') },
      harness,
      evidence: recorder([]),
      commands,
      processOutput: { record: vi.fn() },
      now: () => '2026-09-24T20:00:03.000Z',
    });

    await expect(
      verification.verify({ artifactSaids: [] }, new AbortController().signal),
    ).resolves.toEqual({ kind: 'DependencyUnavailable' });
    expect(run).not.toHaveBeenCalled();
  });
});
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
