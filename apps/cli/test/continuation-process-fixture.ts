/** Deterministic subprocess fixture: real custody/HTTP adapters, fixture authority and seal acknowledgements. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  createRun,
  acquireFirstRunLease,
  startRunExecution,
  continueRun,
  ProtectedCredentials,
  type Run,
} from '@devrandom/domain';
import {
  prepareTaskCommand,
  projectRun,
  prepareRunSuccessorSegment,
  preparePublicVerifierReceipt,
  type EvidenceEvent,
  type EvidenceStreamProjection,
  type RunContinuationRequest,
  type TaskProjection,
  type ActiveHarnessPointer,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';
import { RunResourceBudget } from '@devrandom/runtime';
import { taskSourceFixture, taskProjectionFixture } from './task-source-fixture.js';
import { baselineHarnessCommandFixture } from './baseline-harness-fixture.js';
import { runProjectionFixture } from './run-fixture.js';
import { decodeRunProjection } from '@devrandom/protocol';
import { GitRunWorktrees } from '../src/run/infrastructure/git-run-worktree.js';
import { GitWorktreeChanges } from '../src/run/infrastructure/git-worktree-changes.js';
import { SqliteEvidenceOutboxes } from '../src/run/infrastructure/sqlite-evidence-outbox.js';
import { RunCheckpointPause } from '../src/run/application/run-checkpoint-pause.js';
import { VerifiedRunCheckpoint } from '../src/run/application/verified-run-checkpoint.js';
import { settleBlockedRun } from '../src/run/application/blocked-run-settlement.js';
import { resumeTask } from '../src/run/application/resume-task.js';
import { RunContinuationFile } from '../src/run/infrastructure/run-continuation-file.js';
import { ServerRunHttp } from '../src/run/infrastructure/server-run-http.js';
import { decodeDevrandomServerOrigin } from '../src/infrastructure/devrandom-server-http.js';
import type { PreparedRunWorktree } from '../src/run/application/run-worktree.js';
const [mode, root] = process.argv.slice(2);
if (root === undefined) throw new Error('fixture root required');
const said = (c: string) => `E${c.repeat(43)}`;
const now = () => '2026-09-24T20:00:05.000Z';
const signal = new AbortController().signal;
const credentials = new ProtectedCredentials([]);
const repository = new GitWorktreeChanges(credentials);
const stateRoot = join(root, 'state');
interface Snapshot {
  readonly run: Run;
  readonly task: TaskProjection;
  readonly worktree: PreparedRunWorktree;
  readonly events: readonly EvidenceEvent[];
  readonly stream: EvidenceStreamProjection;
  readonly checkpointRepository: Extract<VerifiedCheckpoint, { version: 1 }>['repository'];
}
if (mode === 'pause') {
  const source = join(root, 'repository');
  await mkdir(source, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Process fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git('commit', '--quiet', '-m', 'fixture');
  const prepared = prepareTaskCommand(taskSourceFixture(), randomUUID(), {
    objectFormat: 'sha1',
    commit: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  });
  if (prepared.kind !== 'Prepared') throw new Error('task fixture');
  const task = taskProjectionFixture(prepared.command);
  const harness = baselineHarnessCommandFixture(task).revision;
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') throw new Error('run fixture');
  const created = createRun({
    ...decoded.run.binding,
    taskRevisionSaid: task.revisionSaid,
    initialHarnessRevisionSaid: harness.d,
    repository: task.revision.repository,
    initialSpecialization: {
      ...decoded.run.binding.initialSpecialization,
      harnessRevisionSaid: harness.d,
    },
  });
  if (created.kind !== 'Created') throw new Error('create fixture');
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: randomUUID(),
    expectedRunVersion: created.run.version,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired' || leased.run.lease.kind !== 'Held')
    throw new Error('lease fixture');
  const preparing: Run = {
    ...leased.run,
    currentExecution: {
      segmentSaid: said('s'),
      harnessRevisionSaid: said('z'),
      evidenceStreamId: randomUUID(),
    },
    lease: { ...leased.run.lease, segmentSaid: said('s') },
  };
  const work = await new GitRunWorktrees().prepare(
    {
      stateRoot,
      repositoryDirectory: source,
      runId: preparing.binding.runId,
      repository: preparing.binding.repository,
    },
    signal,
  );
  if (work.kind !== 'Prepared') throw new Error(`worktree ${work.kind}`);
  const opened = new SqliteEvidenceOutboxes(now, credentials).open({ stateRoot, run: preparing });
  if (opened.kind !== 'Opened') throw new Error(opened.kind);
  const evidence = opened.recorder;
  const started = evidence.record({
    occurredAt: now(),
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: preparing.version },
  });
  if (started.kind !== 'Recorded') throw new Error(started.kind);
  const running = startRunExecution(preparing, {
    incarnationId: leased.run.lease.incarnationId,
    leaseObservedAt: now(),
    worktree: work.worktree,
    evidence: { kind: 'Genesis', streamId: preparing.currentExecution?.evidenceStreamId ?? '' },
  });
  if (running.kind !== 'Started') throw new Error(running.kind);
  const budget = new RunResourceBudget({ run: running.run, evidence, now });
  const reservation = budget.reserve([{ budget: 'providerRequests', amount: 1 }]);
  if (reservation.kind !== 'Reserved') throw new Error('reserve');
  if (
    budget.commit(reservation.reservation, {
      producer: { kind: 'PiExecutor' },
      actual: [{ budget: 'providerRequests', amount: 1 }],
    }).kind !== 'Committed'
  )
    throw new Error('debit');
  const artifact = evidence.storeArtifact({
    bytes: Buffer.from('addressable pre-crash evidence'),
    mediaType: 'text/plain; charset=utf-8',
  });
  if (artifact.kind !== 'Stored') throw new Error('artifact');
  if (
    evidence.record({
      occurredAt: now(),
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'Observation', source: 'Repository', artifactSaid: artifact.artifact.d },
    }).kind !== 'Recorded'
  )
    throw new Error('observation');
  const prior = await repository.capture(work.worktree, preparing.binding.budget, signal);
  if (prior.kind !== 'Captured') throw new Error('prior');
  const pause = new RunCheckpointPause();
  let effects = 0;
  const gateway = pause.gateway({
    propose: async () => {
      effects++;
      await writeFile(
        join(work.worktree.directory, 'source.txt'),
        'changed before external SIGKILL\n',
      );
      return { kind: 'Completed', summary: 'actual file edit', outputArtifactSaids: [] };
    },
  });
  const proposal = {
    piSessionId: 'fixture-session',
    modelTurnId: 'fixture-turn',
    toolCallId: 'fixture-call',
    proposalIndex: 0,
    input: {
      kind: 'WriteFile' as const,
      path: 'source.txt',
      content: 'changed before external SIGKILL\n',
    },
  };
  await gateway.propose(proposal, signal);
  if ((await gateway.propose(proposal, signal)).kind !== 'DependencyUnavailable' || effects !== 1)
    throw new Error('effects not disabled');
  const captured = await repository.capture(work.worktree, preparing.binding.budget, signal);
  if (captured.kind !== 'Captured' || !pause.hasProgress(captured.repository, prior.repository))
    throw new Error('no actual progress');
  const receipts = harness.completionCommands.map((command) => {
    const preparedReceipt = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: command.identity,
      commandSaid: command.contentSaid,
      recordedAt: now(),
      outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
    });
    if (preparedReceipt.kind !== 'Prepared') throw new Error('receipt');
    return preparedReceipt.receipt;
  });
  const events: EvidenceEvent[] = [];
  let stream: EvidenceStreamProjection | undefined;
  const settled = await settleBlockedRun(
    {
      run: running.run,
      reason: 'CheckpointPause',
      verifierReceipts: receipts,
      outputArtifactSaids: [artifact.artifact.d],
    },
    {
      evidence,
      checkpointing: new VerifiedRunCheckpoint({
        task,
        harness,
        worktree: work.worktree,
        evidence,
        budget,
        repository,
        now,
      }),
      now,
      sealing: {
        settle: (recorder, checkpointSaid) => {
          const acknowledge = () => {
            for (;;) {
              const page = recorder.page();
              if (page.kind === 'Empty') return;
              if (page.kind !== 'Page') throw new Error('page');
              events.push(...page.page.events);
              const head = page.page.events.at(-1);
              if (head === undefined) throw new Error('head');
              const ack = recorder.acknowledge({
                version: 1,
                disposition: { kind: 'Accepted' },
                runId: preparing.binding.runId,
                evidenceStreamId: preparing.currentExecution?.evidenceStreamId ?? '',
                batchSaid: page.page.batch.d,
                acceptedThroughSequence: head.sequence,
                chainHeadSaid: head.d,
                receivedAt: now(),
              });
              if (ack.kind !== 'Acknowledged') throw new Error('ack');
            }
          };
          acknowledge();
          if (
            recorder.record({
              occurredAt: now(),
              producer: { kind: 'EvidenceRecorder' },
              event: { kind: 'CheckpointAccepted', checkpointSaid },
            }).kind !== 'Recorded'
          )
            throw new Error('accept');
          acknowledge();
          const head = events.at(-1);
          if (head === undefined) throw new Error('head');
          stream = {
            version: 1,
            runId: preparing.binding.runId,
            evidenceStreamId: preparing.currentExecution?.evidenceStreamId ?? '',
            cursor: {
              kind: 'Accepted',
              eventCount: events.length,
              acceptedThroughSequence: head.sequence,
              chainHeadSaid: head.d,
            },
            checkpoint: { kind: 'Accepted', checkpointSaid },
            seal: {
              kind: 'Sealed',
              sealExchangeSaid: said('q'),
              eventCount: events.length,
              finalSequence: head.sequence,
              chainHeadSaid: head.d,
              sealedAt: now(),
            },
          };
          if (recorder.recordSealAcknowledgement(stream).kind !== 'Recorded')
            throw new Error('seal acknowledgement');
          return Promise.resolve({ kind: 'Sealed' as const });
        },
      },
    },
  );
  if (settled.kind !== 'Settled' || stream === undefined)
    throw new Error(`settlement ${settled.kind}`);
  const snapshot: Snapshot = {
    run: { ...settled.run, consumedBudget: budget.snapshot() },
    task,
    worktree: work.worktree,
    events,
    stream,
    checkpointRepository: captured.repository,
  };
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot), { mode: 0o600 });
  process.stdout.write('CHECKPOINT_ACKNOWLEDGED\n');
  setInterval(() => undefined, 1000); // Deliberately keep the SQLite handle open until external SIGKILL.
} else if (mode === 'resume') {
  const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')) as Snapshot;
  const outboxes = new SqliteEvidenceOutboxes(now, credentials);
  const read = outboxes.readPredecessor({
    run: snapshot.run,
    stateRoot,
    stream: snapshot.stream,
    events: snapshot.events,
  });
  if (read.kind !== 'Read') throw new Error(`custody ${read.kind}`);
  let admissions = 0;
  const activation: ActiveHarnessPointer = {
    version: 1,
    kind: 'Committed',
    disposition: 'Activated',
    taskId: snapshot.task.taskId,
    taskRevisionSaid: snapshot.task.revisionSaid,
    harnessLineageId: snapshot.task.harnessLineageId,
    pointerVersion: 2,
    commandId: randomUUID(),
    activeRevisionSaid: said('z'),
    decisionReceiptSaid: said('r'),
  };
  const admittedAt = '2026-09-24T20:01:00.000Z';
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST' ||
        request.url !== `/api/runs/${snapshot.run.binding.runId}/continuations` ||
        request.headers.authorization !== `Bearer ${'x'.repeat(43)}`
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunContinuationRequest;
      const run = snapshot.run;
      if (run.lease.kind !== 'Held' || run.currentExecution === undefined)
        throw new Error('lease or current execution');
      const segment = prepareRunSuccessorSegment({
        version: 1,
        kind: 'RunSuccessorSegment',
        runId: run.binding.runId,
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        ownerAid: run.binding.ownerAid,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        fromRunVersion: run.version,
        predecessor: {
          incarnationId: run.lease.incarnationId,
          segmentSaid: run.currentExecution.segmentSaid,
          evidenceStreamId: run.currentExecution?.evidenceStreamId ?? '',
          checkpointSaid: command.predecessorCheckpointSaid,
          sealExchangeSaid: command.predecessorSealSaid,
          finalSequence: snapshot.events.length - 1,
          chainHeadSaid: command.predecessorHeadSaid,
        },
        successor: {
          incarnationId: command.successorIncarnationId,
          evidenceStreamId: command.successorStreamId,
          harnessRevisionSaid: activation.activeRevisionSaid,
        },
        activation: {
          pointerVersion: activation.pointerVersion,
          decisionReceiptSaid: activation.decisionReceiptSaid,
        },
        consumedBudget: run.consumedBudget,
        admittedAt,
      });
      if (segment.kind !== 'Prepared') throw new Error('segment');
      const continued = continueRun(run, {
        expectedRunVersion: run.version,
        serverTime: admittedAt,
        predecessor: {
          incarnationId: run.lease.incarnationId,
          evidenceStreamId: run.currentExecution?.evidenceStreamId ?? '',
          checkpointSaid: command.predecessorCheckpointSaid,
        },
        successor: { segmentSaid: segment.segment.d, ...segment.segment.successor },
        activation: {
          pointerVersion: activation.pointerVersion,
          activeRevisionSaid: activation.activeRevisionSaid,
          decisionReceiptSaid: activation.decisionReceiptSaid,
        },
        effects: 'Settled',
      });
      if (continued.kind !== 'Admitted') throw new Error(continued.kind);
      admissions++;
      response
        .writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(
          JSON.stringify({
            version: 1,
            disposition: 'Admitted',
            run: projectRun(continued.run),
            segment: segment.segment,
          }),
        );
    })().catch((cause: unknown) => {
      process.stderr.write(String(cause));
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('address');
    const origin = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
    if (origin.kind !== 'Accepted') throw new Error('origin');
    const resumed = await resumeTask(
      {
        ownerAid: snapshot.run.binding.ownerAid,
        task: snapshot.task,
        run: snapshot.run,
        activation,
        predecessor: read.custody,
        worktree: snapshot.worktree,
      },
      {
        authority: { verify: () => Promise.resolve({ kind: 'Current' }) },
        repository,
        commands: new RunContinuationFile(join(stateRoot, 'continuations'), randomUUID),
        hosted: new ServerRunHttp(origin.origin, 'x'.repeat(43), fetch),
        now: () => admittedAt,
        monotonicNow: () => performance.now(),
      },
      signal,
    );
    if (resumed.kind !== 'Admitted') {
      process.stdout.write(JSON.stringify({ kind: resumed.kind, admissions }));
    } else {
      const opened = outboxes.open({ run: resumed.run, stateRoot });
      if (opened.kind !== 'Opened') throw new Error(`new outbox ${opened.kind}`);
      const started = opened.recorder.record({
        occurredAt: admittedAt,
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: resumed.run.version },
      });
      if (started.kind !== 'Recorded') throw new Error('new start');
      const captured = await repository.capture(
        snapshot.worktree,
        resumed.run.binding.budget,
        signal,
      );
      if (captured.kind !== 'Captured') throw new Error('fresh source');
      const prior = outboxes.readPredecessor({
        run: snapshot.run,
        stateRoot,
        stream: snapshot.stream,
        events: snapshot.events,
      });
      if (prior.kind !== 'Read') throw new Error('prior changed');
      opened.recorder.close();
      process.stdout.write(
        JSON.stringify({
          kind: 'Resumed',
          admissions,
          runId: resumed.run.binding.runId,
          oldIncarnationId:
            snapshot.run.lease.kind === 'Held' ? snapshot.run.lease.incarnationId : '',
          incarnationId: resumed.receipt.segment.successor.incarnationId,
          sequence: started.event.sequence,
          consumedBudget: resumed.run.consumedBudget,
          repository: captured.repository,
          oldPrefix: prior.custody.events.map((event) => event.d),
          artifactCount: prior.custody.artifacts.length,
        }),
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
  }
} else throw new Error('fixture mode');
