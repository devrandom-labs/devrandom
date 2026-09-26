import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { promotionEvidenceClasses, taskBudgetCeilings } from '@devrandom/domain';
import { taskSourceCommandSchema } from '@devrandom/protocol';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { materializeCesrReceiptFixture } from '../../../../tooling/cesr-receipt-fixture.js';

const describeLiveMandates =
  process.env.DEVRANDOM_MANDATE_INTEGRATION === '1' ? describe : describe.skip;
const maximumTaskLifetimeMilliseconds = 4 * 60 * 60 * 1_000;
const taskCreationHeadroomMilliseconds = 60 * 1_000;
const workAccessAttemptMilliseconds = taskBudgetCeilings.workAccessAttemptLifetimeSeconds * 1_000;
const campaignRunWindowMilliseconds = Math.min(
  taskBudgetCeilings.runsPerAdmittedUser * taskBudgetCeilings.runWallTimeSeconds * 1_000,
  maximumTaskLifetimeMilliseconds - taskCreationHeadroomMilliseconds,
);
const acceptanceRunCommandTimeoutMilliseconds =
  campaignRunWindowMilliseconds + workAccessAttemptMilliseconds;
const acceptanceTestTimeoutMilliseconds =
  acceptanceRunCommandTimeoutMilliseconds + 2 * workAccessAttemptMilliseconds;

it('allows a full lawful calibration campaign before the Task deadline', () => {
  expect(acceptanceTestTimeoutMilliseconds).toBeGreaterThan(
    campaignRunWindowMilliseconds + workAccessAttemptMilliseconds,
  );
  expect(acceptanceRunCommandTimeoutMilliseconds).toBeLessThan(acceptanceTestTimeoutMilliseconds);
});

interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function executeCli(
  arguments_: readonly string[],
  workingDirectory: string,
  timeoutMilliseconds = workAccessAttemptMilliseconds,
): Promise<CliExecution> {
  return new Promise((resolve, reject) => {
    const cancellation = new AbortController();
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'apps', 'cli', 'dist', 'main.js'), ...arguments_],
      { cwd: workingDirectory, env: process.env, signal: cancellation.signal },
    );
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      cancellation.abort();
      forceStop = setTimeout(() => child.kill('SIGKILL'), 30_000);
    }, timeoutMilliseconds);
    let stdout = '';
    let stderr = '';
    let childError: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error: Error) => {
      childError = error;
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(deadline);
      if (forceStop !== undefined) clearTimeout(forceStop);
      if (cancellation.signal.aborted) {
        reject(new Error(`devrandom CLI exceeded its ${String(timeoutMilliseconds)} ms bound`));
        return;
      }
      if (childError !== undefined) {
        reject(childError);
        return;
      }
      if (exitCode === null) {
        reject(new Error(`devrandom CLI terminated by ${signal ?? 'an unknown signal'}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function outputValue(output: string, label: string): string {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${label}: `));
  if (line === undefined) {
    throw new Error(`CLI output did not contain ${label}`);
  }
  return line.slice(label.length + 2);
}

function failedRunOutbox(stateDirectory: string, stderr: string): string {
  const runId = /^Run ID: ([0-9a-f-]{36})$/mu.exec(stderr)?.[1];
  if (runId === undefined) return 'Run ID unavailable';
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(join(stateDirectory, 'runs', runId, 'outbox.sqlite'), {
      readOnly: true,
    });
  } catch {
    return 'Local outbox unavailable';
  }
  try {
    return JSON.stringify({
      stream: database
        .prepare('SELECT next_sequence, next_delivery_sequence FROM stream_state')
        .get(),
      counts: Object.fromEntries(
        [
          'evidence_events',
          'evidence_acknowledgements',
          'verified_checkpoints',
          'evidence_seal_acknowledgement',
        ].map((table) => [table, database.prepare(`SELECT count(*) AS count FROM ${table}`).get()]),
      ),
      budgets: database
        .prepare(
          "SELECT json_extract(encoded_event, '$.event.budget') AS dimension, json_extract(encoded_event, '$.event.consumed') AS consumed FROM evidence_events WHERE json_extract(encoded_event, '$.event.kind') = 'BudgetDebited' ORDER BY sequence DESC LIMIT 16",
        )
        .all(),
      recentEvents: database
        .prepare(
          "SELECT sequence, json_extract(encoded_event, '$.event.kind') AS kind, json_extract(encoded_event, '$.event.tool') AS tool, json_extract(encoded_event, '$.event.failure') AS failure FROM evidence_events ORDER BY sequence DESC LIMIT 20",
        )
        .all(),
    });
  } finally {
    database.close();
  }
}

describeLiveMandates(
  'live Task authority, baseline execution, and sealed evidence boundary',
  () => {
    it(
      'retains the attributable prepared compatibility failure and inspects it from fresh CLI processes',
      async () => {
        const stateDirectory = process.env.DEVRANDOM_USER_STATE_DIR;
        if (stateDirectory === undefined || stateDirectory.length === 0) {
          throw new Error('DEVRANDOM_USER_STATE_DIR is required');
        }
        const materialized = await materializeCesrReceiptFixture({
          templateRoot: join(process.cwd(), 'fixtures', 'cesr-receipt-service'),
          taskTemplate: join(process.cwd(), 'fixtures', 'cesr-compat.task.json'),
          destination: join(stateDirectory, 'cesr-compat-boundary-repository'),
        });
        const decodedTask: unknown = JSON.parse(await readFile(materialized.taskFile, 'utf8'));
        if (!Value.Check(taskSourceCommandSchema, decodedTask)) {
          throw new Error('The materialized CESR Task contract is invalid.');
        }
        await writeFile(
          materialized.taskFile,
          `${JSON.stringify(
            {
              ...decodedTask,
              expiresAt: new Date(
                Date.now() + maximumTaskLifetimeMilliseconds - taskCreationHeadroomMilliseconds,
              ).toISOString(),
            },
            null,
            2,
          )}\n`,
        );

        const creation = await executeCli(
          ['task', 'create', materialized.taskFile],
          materialized.worktree,
        );
        expect(creation).toMatchObject({ exitCode: 0, stderr: '' });
        expect(creation.stdout).toContain('Task Created\n');
        expect(creation.stdout).toContain('Label: cesr-compat\n');
        expect(creation.stdout).toContain('Lifecycle: Open\n');

        const first = await executeCli(
          ['task', 'run', 'cesr-compat'],
          materialized.worktree,
          acceptanceRunCommandTimeoutMilliseconds,
        );
        expect(
          first,
          first.exitCode === 0
            ? first.stderr
            : `${first.stderr}\nLocal outbox: ${failedRunOutbox(stateDirectory, first.stderr)}`,
        ).toMatchObject({ exitCode: 0, stderr: '' });
        expect(first.stdout).toContain('Run Supervision Stopped\n');
        expect(first.stdout).toMatch(/Calibration confirmations: [45]\/5\n/u);
        expect(first.stdout).toMatch(/Calibration exclusions: [01]\/5\n/u);
        expect(first.stdout).toContain('Task lifecycle: Open\n');
        expect(first.stdout).toContain(
          'Task Mandate allowed capabilities: EditRepository, ReadRepository, RunTests, SubmitResult\n',
        );
        expect(first.stdout).toContain('Task Mandate evolution classes: C1, C2, C3\n');
        expect(first.stdout).toContain(
          `Promotion Mandate required evidence: ${promotionEvidenceClasses.join(', ')}\n`,
        );
        expect(first.stdout).toContain('H1 kind: InitialSpecialization\n');
        expect(first.stdout).toContain('H1 instructions: AGENTS.md=');
        expect(first.stdout).toContain(
          `H1 model: concentrate/${process.env.DEVRANDOM_MODEL_ID ?? 'deepinfra/gemma-4-e4b'}\n`,
        );
        expect(first.stdout).toContain('H1 model credential source: CONCENTRATE_API_KEY\n');
        expect(first.stdout).toContain('Run admission: Created\n');
        expect(first.stdout).toContain('Run stop cause: ExecutorSettled(Completed)\n');
        expect(first.stdout).toContain('Run state: Active.Blocked(HarnessCompatibilityFailure)\n');
        expect(first.stdout).toContain('Submission verification: Rejected\n');
        expect(first.stdout).toContain('Checkpoint SAID: E');
        expect(first.stdout).toContain('Active Harness Revision SAID: E');
        expect(first.stdout).toContain('Run activation: InitialSpecializationAccepted\n');
        expect(first.stdout).toContain('Run lease disposition: Acquired\n');

        const ownerAid = outputValue(first.stdout, 'Owner AID');
        const personalAgentAid = outputValue(first.stdout, 'Personal-agent AID');
        const governorAid = outputValue(first.stdout, 'Governor AID');
        expect(new Set([ownerAid, personalAgentAid, governorAid]).size).toBe(3);
        for (const aid of [ownerAid, personalAgentAid, governorAid]) {
          expect(aid).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
        }

        const status = await executeCli(['task', 'status', 'cesr-compat'], materialized.worktree);
        expect(status, status.stderr).toMatchObject({ exitCode: 0, stderr: '' });
        expect(status.stdout).toContain('Task lifecycle: Open\n');
        expect(status.stdout).toContain('Run state: Active.Blocked(HarnessCompatibilityFailure)\n');
        expect(status.stdout).toContain('Submission verification: Rejected\n');
        expect(status.stdout).toContain('Evidence event count: ');
        expect(status.stdout).toContain('Checkpoint SAID: E');
        expect(status.stdout).toContain('Evidence seal: Sealed\n');
        expect(status.stdout).toContain(
          'Runtime: inspection only; no runtime was restored or resumed.\n',
        );

        const watch = await executeCli(['task', 'watch', 'cesr-compat'], materialized.worktree);
        expect(watch, watch.stderr).toMatchObject({ exitCode: 0, stderr: '' });
        expect(watch.stdout).toContain('Task Run Timeline\n');
        expect(watch.stdout).toContain('Run state: Active.Blocked(HarnessCompatibilityFailure)\n');
        expect(watch.stdout).toContain('FailureObserved');
        expect(watch.stdout).toContain('RunBlocked');
        expect(watch.stdout).toContain('CheckpointAccepted');
      },
      acceptanceTestTimeoutMilliseconds,
    );
  },
);
