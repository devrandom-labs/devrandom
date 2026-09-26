import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { runLeasePolicy } from '@devrandom/domain';
import { runLeaseSchema, taskSourceCommandSchema } from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { materializeCesrReceiptFixture } from '../../../../tooling/cesr-receipt-fixture.js';

const executeFile = promisify(execFile);
const describeLive =
  process.env.DEVRANDOM_GRANT_REPLACEMENT_INTEGRATION === '1' ? describe : describe.skip;

const snapshotSchema = Type.Object({
  grants: Type.Array(
    Type.Object({
      attemptId: Type.String(),
      clientInstanceId: Type.String(),
      userAid: Type.String(),
      grantedAt: Type.String(),
      expiresAt: Type.String(),
      responseSaid: Type.String(),
      disposition: Type.String(),
      remainingRequests: Type.Union([Type.Number(), Type.Null()]),
    }),
  ),
  runs: Type.Array(
    Type.Object({ runId: Type.String(), runVersion: Type.Number(), lease: runLeaseSchema }),
  ),
  evidence: Type.Array(Type.Object({ runId: Type.String(), receivedAt: Type.String() })),
  budget: Type.Array(
    Type.Object({
      runId: Type.String(),
      dimension: Type.String(),
      consumed: Type.Number(),
    }),
  ),
  checkpoints: Type.Array(Type.Object({ runId: Type.String(), receivedAt: Type.String() })),
  calibrations: Type.Array(Type.Object({ runId: Type.String(), disposition: Type.String() })),
  recentEvents: Type.Array(
    Type.Object({ runId: Type.String(), sequence: Type.Number(), kind: Type.String() }),
  ),
});
type Snapshot = Type.Static<typeof snapshotSchema>;

function startCli(args: readonly string[], cwd: string, timeoutMilliseconds = 510_000) {
  const execution = executeFile(
    process.execPath,
    [join(process.cwd(), 'apps/cli/dist/main.js'), ...args],
    {
      cwd,
      env: process.env,
      timeout: timeoutMilliseconds,
      killSignal: 'SIGINT',
      maxBuffer: 2 * 1_024 * 1_024,
    },
  );
  const completion = execution.then(
    ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
    (cause: unknown) => {
      if (
        cause instanceof Error &&
        'code' in cause &&
        typeof cause.code === 'number' &&
        'stdout' in cause &&
        typeof cause.stdout === 'string' &&
        'stderr' in cause &&
        typeof cause.stderr === 'string'
      ) {
        return { exitCode: cause.code, stdout: cause.stdout, stderr: cause.stderr };
      }
      throw cause;
    },
  );
  return { child: execution.child, completion };
}

async function snapshot(): Promise<Snapshot> {
  const project = process.env.DEVRANDOM_WORK_ACCESS_COMPOSE_PROJECT;
  const environment = process.env.DEVRANDOM_WORK_ACCESS_COMPOSE_ENV;
  if (project === undefined || environment === undefined)
    throw new Error('Missing Compose probe configuration');
  // Read only explicit public identifiers, authority times and usage counts.
  // No grant hashes, proof words, artifact bytes or signing material leave MongoDB.
  const query = `print(JSON.stringify({
    grants: db.workAccessAttempts.find({"state.kind":"Granted"}).toArray().map(g => ({
      attemptId:g._id, clientInstanceId:g.clientInstanceId, userAid:g.userAid,
      grantedAt:g.state.grantedAt.toISOString(), expiresAt:g.state.expiresAt.toISOString(),
      responseSaid:g.state.verifiedResponseSaid,
      disposition:g.state.disposition.kind,
      remainingRequests:g.state.disposition.remainingRequests ?? null
    })),
    runs: db.runs.find({}, {_id:0,runId:1,runVersion:1,lease:1}).toArray(),
    evidence: db.evidenceEvents.aggregate([
      {$group:{_id:"$runId",receivedAt:{$max:"$receivedAt"}}}
    ]).toArray().map(e => ({runId:e._id,receivedAt:e.receivedAt.toISOString()})),
    budget: db.evidenceEvents.aggregate([
      {$match:{"event.event.kind":"BudgetDebited"}},
      {$sort:{sequence:1}},
      {$group:{_id:{runId:"$runId",dimension:"$event.event.budget"},consumed:{$last:"$event.event.consumed"}}}
    ]).toArray().map(e => ({runId:e._id.runId,dimension:e._id.dimension,consumed:e.consumed})),
    checkpoints: db.checkpoints.find({}, {_id:0,runId:1,receivedAt:1}).toArray(),
    calibrations: db.evidenceEvents.find({"event.event.kind":"RunCalibrationRecorded"},
      {_id:0,runId:1,"event.event.disposition.kind":1}).toArray()
      .map(e => ({runId:e.runId,disposition:e.event.event.disposition.kind})),
    recentEvents: db.evidenceEvents.find({}, {_id:0,runId:1,sequence:1,"event.event.kind":1})
      .sort({sequence:-1}).limit(12).toArray()
      .map(e => ({runId:e.runId,sequence:e.sequence,kind:e.event.event.kind}))
  }))`;
  const output = await executeFile(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--env-file',
      environment,
      'exec',
      '-T',
      'mongodb',
      'mongosh',
      '--quiet',
      'devrandom_e0',
      '--eval',
      query,
    ],
    { timeout: 10_000, maxBuffer: 2 * 1_024 * 1_024 },
  );
  const decoded: unknown = JSON.parse(output.stdout);
  if (!Value.Check(snapshotSchema, decoded)) throw new Error('Invalid public grant probe snapshot');
  return decoded;
}

function localOutboxSummaries(state: string, observations: readonly Snapshot[]) {
  const runIds = new Set(
    observations.flatMap((observation) => observation.runs.map((run) => run.runId)),
  );
  return [...runIds].flatMap((runId) => {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(join(state, 'runs', runId, 'outbox.sqlite'), {
        readOnly: true,
      });
    } catch {
      return [];
    }
    try {
      return [
        {
          runId,
          stream: database
            .prepare('SELECT next_sequence, next_delivery_sequence FROM stream_state')
            .get(),
          counts: Object.fromEntries(
            [
              'evidence_events',
              'evidence_acknowledgements',
              'verified_checkpoints',
              'evidence_seal_acknowledgement',
            ].map((table) => [
              table,
              database.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
            ]),
          ),
          recentEvents: database
            .prepare(
              "SELECT sequence, json_extract(encoded_event, '$.event.kind') AS kind, json_extract(encoded_event, '$.event.tool') AS tool, json_extract(encoded_event, '$.event.failure') AS failure FROM evidence_events ORDER BY sequence DESC LIMIT 12",
            )
            .all(),
        },
      ];
    } finally {
      database.close();
    }
  });
}

describeLive('native Run grant replacement', () => {
  it('renews the same incarnation and delivers evidence after its initial grant expires', async () => {
    const state = process.env.DEVRANDOM_USER_STATE_DIR;
    if (state === undefined) throw new Error('Missing identity state');
    expect(process.env.DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS).toBe('45');
    const fixture = await materializeCesrReceiptFixture({
      templateRoot: join(process.cwd(), 'fixtures/cesr-receipt-service'),
      taskTemplate: join(process.cwd(), 'fixtures/cesr-compat.task.json'),
      destination: join(state, 'grant-expiry-repository'),
    });
    const task: unknown = JSON.parse(await readFile(fixture.taskFile, 'utf8'));
    if (!Value.Check(taskSourceCommandSchema, task)) throw new Error('Invalid prepared Task');
    await writeFile(
      fixture.taskFile,
      JSON.stringify({
        ...task,
        completionConditions: [
          {
            id: 'grant-expiry-observation',
            argv: ['sleep', '60'],
            timeoutSeconds: 90,
            expected: { kind: 'exitCode', code: 0 },
          },
          ...task.completionConditions,
        ],
        expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
      }),
    );
    const created = await startCli(['task', 'create', fixture.taskFile], fixture.worktree)
      .completion;
    expect(created).toMatchObject({ exitCode: 0, stderr: '' });
    const snapshots: Snapshot[] = [await snapshot()];
    const running = startCli(['task', 'run', task.label], fixture.worktree);
    const completed = running.completion;
    const reportPath = process.env.DEVRANDOM_GRANT_PROBE_REPORT;
    try {
      let execution: Awaited<typeof completed>;
      let statusDuringRun: Awaited<ReturnType<typeof startCli>['completion']> | undefined;
      let snapshotFailures = 0;
      for (;;) {
        const observation = await Promise.race([
          completed.then((output) => ({ kind: 'Exited' as const, output })),
          new Promise<{ readonly kind: 'Polling' }>((resolve) =>
            setTimeout(() => {
              resolve({ kind: 'Polling' });
            }, 5_000),
          ),
        ]);
        try {
          snapshots.push(await snapshot());
          snapshotFailures = 0;
        } catch (cause) {
          snapshotFailures += 1;
          if (snapshotFailures >= 3) {
            if (reportPath !== undefined)
              await writeFile(
                reportPath,
                JSON.stringify({ snapshots, observationError: String(cause) }, null, 2),
                { mode: 0o600 },
              );
            throw cause;
          }
          continue;
        }
        const latest = snapshots.at(-1);
        const heldRun = latest?.runs.find((run) => run.lease.kind === 'Held');
        if (
          statusDuringRun === undefined &&
          heldRun !== undefined &&
          running.child.exitCode === null &&
          latest !== undefined &&
          latest.grants.length >= 3 &&
          latest.grants.filter((grant) => grant.disposition === 'Active').length === 1 &&
          latest.grants.filter((grant) => grant.disposition === 'Released').length >= 2
        ) {
          statusDuringRun = await startCli(['task', 'status', task.label], fixture.worktree, 60_000)
            .completion;
          expect(statusDuringRun, statusDuringRun.stderr).toMatchObject({
            exitCode: 0,
            stderr: '',
          });
          expect(statusDuringRun.stdout).toContain(`Run ID: ${heldRun.runId}`);
        }
        if (observation.kind === 'Exited') {
          execution = observation.output;
          break;
        }
      }
      // This probe accepts no calibration category. Preserve the actual CLI
      // disposition and check only the independently specified authority law.
      const report = {
        execution,
        statusDuringRun,
        snapshots,
        localOutboxes: localOutboxSummaries(state, snapshots),
      };
      if (reportPath !== undefined)
        await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      expect(
        statusDuringRun,
        'No fresh status succeeded during a renewed active Run',
      ).toBeDefined();
      const grants = new Map<string, Snapshot['grants'][number]>();
      for (const observation of snapshots)
        for (const grant of observation.grants) {
          const prior = grants.get(grant.attemptId);
          grants.set(grant.attemptId, {
            ...grant,
            remainingRequests: grant.remainingRequests ?? prior?.remainingRequests ?? null,
          });
        }
      for (const grant of grants.values()) {
        expect(Date.parse(grant.expiresAt) - Date.parse(grant.grantedAt)).toBe(45_000);
      }
      const runs = snapshots.flatMap((observation) => observation.runs);
      const held = runs.filter((run) => run.lease.kind === 'Held');
      expect(held.length).toBeGreaterThan(0);
      const crossed = held.find((run) => {
        if (run.lease.kind !== 'Held' || run.lease.lastChange.kind !== 'Renewed') return false;
        const acquiredAt = run.lease.acquiredAt;
        const priorGrants = [...grants.values()].filter((grant) => grant.grantedAt <= acquiredAt);
        const owner = priorGrants[0];
        if (
          owner === undefined ||
          priorGrants.some(
            (grant) =>
              grant.userAid !== owner.userAid || grant.clientInstanceId !== owner.clientInstanceId,
          )
        )
          return false;
        // Require all grants issued before this lease to have expired. This
        // proves replacement without guessing which bearer admitted the Run.
        const priorExpiry = priorGrants.reduce(
          (latest, grant) => (grant.expiresAt > latest ? grant.expiresAt : latest),
          owner.expiresAt,
        );
        const renewedAt = Date.parse(run.lease.expiresAt) - runLeasePolicy.leaseSeconds * 1_000;
        return (
          renewedAt > Date.parse(priorExpiry) &&
          snapshots.some((observation) =>
            observation.evidence.some(
              (event) => event.runId === run.runId && event.receivedAt > priorExpiry,
            ),
          ) &&
          [...grants.values()].some(
            (grant) =>
              grant.clientInstanceId === owner.clientInstanceId &&
              grant.userAid === owner.userAid &&
              priorGrants.every((prior) => grant.responseSaid !== prior.responseSaid) &&
              grant.grantedAt > acquiredAt &&
              Date.parse(grant.grantedAt) <= renewedAt &&
              Date.parse(grant.expiresAt) > renewedAt &&
              grant.remainingRequests !== null &&
              grant.remainingRequests < 2_000,
          )
        );
      });
      expect(
        crossed,
        'No same-incarnation lease and evidence acceptance crossed initial grant expiry',
      ).toBeDefined();
      if (crossed === undefined) return;
      expect(
        snapshots.some((observation) =>
          observation.checkpoints.some((checkpoint) => checkpoint.runId === crossed.runId),
        ),
        'The Run crossing grant expiry did not deliver its checkpoint',
      ).toBe(true);
      const incarnations = new Set(
        held
          .filter((run) => run.runId === crossed.runId)
          .flatMap((run) => (run.lease.kind === 'Held' ? [run.lease.incarnationId] : [])),
      );
      expect(incarnations.size).toBe(1);
    } finally {
      if (running.child.exitCode === null && running.child.signalCode === null)
        running.child.kill('SIGINT');
      await completed;
    }
  }, 600_000);
});
