import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireFirstRunLease, ProtectedCredentials } from '@devrandom/domain';
import { decodeEvidenceEvent, decodeRunProjection } from '@devrandom/protocol';
import { RunResourceBudget, ToolGateway, ToolProposalBudgetLedger } from '@devrandom/runtime';
import { expect, it } from 'vitest';
import { runIncarnationId, runProjectionFixture } from '../../../test/run-fixture.js';
import { SqliteEvidenceOutboxes } from '../../run/infrastructure/sqlite-evidence-outbox.js';
import {
  ManagedWorktreeResources,
  ManagedWorktreeToolEffects,
} from '../../run/infrastructure/managed-worktree-tools.js';

// Fixture authority; production Gateway, filesystem enforcement, budget and durable evidence.
it('records protected evaluator/evidence write denials and permits the next authorized repository effect', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devrandom-proposal-boundaries-')));
  const now = () => '2026-09-24T20:00:02.000Z';
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') throw new Error('run fixture');
  const leased = acquireFirstRunLease(decoded.run, {
    incarnationId: runIncarnationId,
    expectedRunVersion: decoded.run.version,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('lease fixture');
  const run = leased.run;
  const stateRoot = join(root, 'state');
  const worktree = join(root, 'worktree');
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(worktree);
  await writeFile(join(root, 'evaluation-manifest.json'), 'original evaluator');
  await writeFile(join(root, 'failed-case.json'), 'retained failed evidence');
  await symlink(join(root, 'failed-case.json'), join(worktree, 'evidence-alias.json'));
  const opened = new SqliteEvidenceOutboxes(now, new ProtectedCredentials([])).open({
    stateRoot,
    run,
  });
  if (opened.kind !== 'Opened') throw new Error(opened.kind);
  try {
    const evidence = opened.recorder;
    expect(
      evidence.record({
        occurredAt: now(),
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: run.version },
      }).kind,
    ).toBe('Recorded');
    const resources = new ManagedWorktreeResources({
      worktree,
      protectedPaths: [],
      completionCommands: [],
      toolCommands: [],
    });
    const unexpected = () => {
      throw new Error('unexpected external execution');
    };
    const gateway = new ToolGateway({
      binding: {
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: runIncarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        taskMandateSaid: run.binding.taskMandateSaid,
      },
      activeTools: [{ name: 'write_file', requiredCapability: 'EditRepository' }],
      resources,
      mandate: {
        inspect: () =>
          Promise.resolve({
            kind: 'Current',
            mandateSaid: run.binding.taskMandateSaid,
            allowedCapabilities: ['EditRepository'],
          }),
      },
      lease: { inspect: () => Promise.resolve({ kind: 'Held' }) },
      budget: new ToolProposalBudgetLedger(new RunResourceBudget({ run, evidence, now })),
      evidence,
      now,
      effects: new ManagedWorktreeToolEffects({
        resources,
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        artifacts: evidence,
        commands: { run: unexpected },
        processOutput: { record: unexpected },
        verification: { verify: unexpected },
      }),
    });
    const signal = new AbortController().signal;
    for (const [proposalIndex, path] of [
      '../evaluation-manifest.json',
      'evidence-alias.json',
      'source.ts',
    ].entries()) {
      const outcome = await gateway.propose(
        {
          piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
          modelTurnId: 'turn-0',
          toolCallId: `call-${String(proposalIndex)}`,
          proposalIndex,
          input: { kind: 'WriteFile', path, content: 'authorized source change' },
        },
        signal,
      );
      if (proposalIndex < 2)
        expect(outcome).toMatchObject({ kind: 'Rejected', reason: 'ResourceDenied' });
      else expect(outcome.kind).toBe('Completed');
    }
    expect(await readFile(join(root, 'evaluation-manifest.json'), 'utf8')).toBe(
      'original evaluator',
    );
    expect(await readFile(join(root, 'failed-case.json'), 'utf8')).toBe('retained failed evidence');
    expect(await readFile(join(worktree, 'source.ts'), 'utf8')).toBe('authorized source change');
    const database = new DatabaseSync(join(stateRoot, 'runs', run.binding.runId, 'outbox.sqlite'), {
      readOnly: true,
    });
    try {
      const events = database
        .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence')
        .all()
        .map((row) => {
          const event = decodeEvidenceEvent(JSON.parse(String(row.encoded_event)));
          if (event.kind !== 'Accepted') throw new Error('durable evidence decoding');
          return event.event;
        });
      expect(events.filter((event) => event.event.kind === 'ToolRejected')).toHaveLength(2);
      expect(events.filter((event) => event.event.kind === 'EffectCompleted')).toHaveLength(1);
      expect(events.every((event) => event.personalAgentAid === run.binding.personalAgentAid)).toBe(
        true,
      );
    } finally {
      database.close();
    }
  } finally {
    opened.recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});
