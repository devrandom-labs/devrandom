import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  acquireFirstRunLease,
  createRun,
  ProtectedCredentials,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import {
  evidenceArtifactReferences,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  type EvidenceEventDetail,
} from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { RunResourceBudget } from '@devrandom/runtime';

import { SqliteEvidenceOutboxes } from './sqlite-evidence-outbox.js';
import { EvidenceRecorderProcessOutput } from './process-output-evidence.js';

const temporaryDirectories: string[] = [];

function said(character: string): string {
  return `E${character.repeat(43)}`;
}

function runFixture(evidenceBytes = taskBudgetCeilings.evidencePlusArtifactsPerRunBytes): Run {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('b'),
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: said('g'),
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: said('g'),
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('h'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: { ...taskBudgetCeilings, evidencePlusArtifactsPerRunBytes: evidenceBytes },
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture Run must be created');
  }
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('fixture Run lease must be acquired');
  }
  return leased.run;
}

function checkpoint(
  run: Run,
  eventCount: number,
  finalSequence: number,
  chainHeadSaid: string,
  reason: 'HarnessCompatibilityFailure' | 'OutboxBackpressure' = 'HarnessCompatibilityFailure',
) {
  if (run.lease.kind !== 'Held') {
    throw new Error('fixture Run must hold an incarnation');
  }
  const receipt = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'public-test',
    commandSaid: said('i'),
    recordedAt: '2026-09-24T20:00:03.000Z',
    outcome: {
      kind: 'Rejected',
      reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 1 },
      elapsedMilliseconds: 20,
      outputArtifactSaids: [],
    },
  });
  if (receipt.kind !== 'Prepared') {
    throw new Error('fixture verifier receipt must prepare');
  }
  const prepared = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId: run.lease.incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      harnessLineageId: run.binding.harnessLineageId,
      personalAgentAid: run.binding.personalAgentAid,
      governorAid: run.binding.governorAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      promotionMandateSaid: run.binding.promotionMandateSaid,
      purpose: run.binding.purpose,
      repository: {
        objectFormat: run.binding.repository.objectFormat,
        baseCommit: run.binding.repository.commit,
        baseTree: run.binding.repository.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [receipt.receipt],
      evidence: { eventCount, finalSequence, chainHeadSaid },
      budget: { consumed: run.consumedBudget, remaining: run.binding.budget },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason },
        verification: { kind: 'Rejected' },
      },
      continuation:
        reason === 'HarnessCompatibilityFailure'
          ? { kind: 'LaterHarnessCompatibilityResolutionRequired' }
          : { kind: 'ExternalResolutionRequired', reason },
    },
    ['public-test'],
  );
  if (prepared.kind !== 'Prepared') {
    throw new Error(`fixture checkpoint must prepare: ${prepared.reason}`);
  }
  return prepared.checkpoint;
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-evidence-outbox-'));
  temporaryDirectories.push(root);
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  await chmod(state, 0o700);
  return state;
}

function retainedEventSaids(stateRoot: string, runId: string): string[] {
  const database = new DatabaseSync(join(stateRoot, 'runs', runId, 'outbox.sqlite'), {
    readOnly: true,
  });
  try {
    return database
      .prepare('SELECT event_said FROM evidence_events ORDER BY sequence ASC')
      .all()
      .map((row) => {
        if (typeof row.event_said !== 'string') throw new Error('raw evidence event is invalid');
        return row.event_said;
      });
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('SQLite evidence outbox', () => {
  it.each(['Observation', 'Artifact'] as const)(
    'enforces the admitted lower evidence ceiling for %s',
    async (kind) => {
      const run = runFixture(kind === 'Observation' ? 1 : 128 * 1_024);
      const root = await stateRoot();
      const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
        run,
        stateRoot: root,
      });
      if (opened.kind !== 'Opened') throw new Error('outbox must open');
      try {
        const outcome =
          kind === 'Observation'
            ? opened.recorder.record({
                occurredAt: '2026-09-24T20:00:02.000Z',
                producer: { kind: 'RunSupervisor' },
                event: { kind: 'RunStarted', fromRunVersion: run.version },
              })
            : opened.recorder.storeArtifact({
                bytes: Buffer.alloc(128 * 1_024 + 1, 120),
                mediaType: 'application/octet-stream',
              });
        expect(outcome).toEqual({ kind: 'OutboxBoundReached' });
        expect(opened.recorder.readiness()).toEqual({
          kind: 'Ready',
          readiness: { kind: 'Genesis', streamId: run.binding.evidenceStreamId },
        });
        expect(await readdir(join(root, 'runs', run.binding.runId, 'artifacts'))).toEqual([]);
      } finally {
        opened.recorder.close();
      }
    },
  );

  it.each([
    {
      kind: 'DataWithheld',
      disposition: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 },
    },
    { kind: 'SecurityViolation', violation: 'SecretDetected' },
  ] as const)('rejects an individually submitted $kind secret marker', async (event) => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    try {
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:03.000Z',
          producer: { kind: 'EvidenceRecorder' },
          event,
        }),
      ).toEqual({ kind: 'ObservationRejected' });
      expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
    } finally {
      opened.recorder.close();
    }
  });

  it('rejects malformed or repeated budget dimensions without persisting a prefix', async () => {
    const run = runFixture();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run,
      stateRoot: await stateRoot(),
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    const first = {
      kind: 'BudgetDebited',
      budget: 'providerRequests',
      amount: 1,
      consumed: 1,
    } as const;
    try {
      for (const debits of [
        [],
        [first, first],
        [
          first,
          {
            kind: 'BudgetDebited',
            budget: 'providerOutputTokens',
            amount: 20,
            consumed: Number.NaN,
          },
        ],
      ] as const) {
        expect(
          opened.recorder.recordBudgetDebit({
            occurredAt: '2026-09-24T20:00:02.000Z',
            producer: { kind: 'PiExecutor' },
            debits,
          }),
        ).toEqual({ kind: 'ObservationRejected' });
        expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
        expect(opened.recorder.readiness()).toEqual({
          kind: 'Ready',
          readiness: { kind: 'Genesis', streamId: run.binding.evidenceStreamId },
        });
      }
    } finally {
      opened.recorder.close();
    }
  });

  it('rolls back every budget dimension and cursor when the second debit cannot persist', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    const database = new DatabaseSync(join(root, 'runs', run.binding.runId, 'outbox.sqlite'));
    const budget = new RunResourceBudget({
      run,
      evidence: opened.recorder,
      now: () => '2026-09-24T20:00:02.000Z',
    });
    const amounts = [
      { budget: 'providerRequests', amount: 1 },
      { budget: 'providerOutputTokens', amount: 20 },
    ] as const;
    const commit = () => {
      const reservation = budget.reserve(amounts);
      if (reservation.kind !== 'Reserved') throw new Error('reservation must fit');
      return budget.commit(reservation.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: amounts,
      });
    };
    try {
      database.exec(`CREATE TRIGGER reject_output_debit BEFORE INSERT ON evidence_events
        WHEN json_extract(NEW.encoded_event, '$.event.budget') = 'providerOutputTokens'
        BEGIN SELECT RAISE(ABORT, 'synthetic-debit-failure'); END;`);
      expect(commit()).toEqual({ kind: 'Unavailable' });
      expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
      expect(budget.snapshot()).toEqual(run.consumedBudget);
      expect(
        database.prepare('SELECT next_sequence, chain_head, encoded_bytes FROM stream_state').get(),
      ).toEqual({ next_sequence: 0, chain_head: null, encoded_bytes: 0 });
      database.exec('DROP TRIGGER reject_output_debit');
      expect(commit()).toEqual({ kind: 'Committed' });
      expect(budget.snapshot()).toEqual({
        ...run.consumedBudget,
        providerRequests: 1,
        providerOutputTokens: 20,
      });
      const page = opened.recorder.page();
      if (page.kind !== 'Page') throw new Error('atomic debit must exist');
      expect(page.page.events.map(({ sequence, event }) => ({ sequence, event }))).toEqual([
        {
          sequence: 0,
          event: { kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 },
        },
        {
          sequence: 1,
          event: {
            kind: 'BudgetDebited',
            budget: 'providerOutputTokens',
            amount: 20,
            consumed: 20,
          },
        },
      ]);
    } finally {
      database.close();
      opened.recorder.close();
    }
  });

  it.each(['Observation', 'Artifact', 'CapturedOutput'] as const)(
    'rolls back both withholding markers when the second write fails for an %s',
    async (source) => {
      const run = runFixture();
      const root = await stateRoot();
      const credential = 'synthetic-private-atomic-withholding-13579';
      const opened = new SqliteEvidenceOutboxes(
        () => '2026-09-24T20:00:03.000Z',
        new ProtectedCredentials([credential]),
      ).open({ run, stateRoot: root });
      if (opened.kind !== 'Opened') throw new Error('outbox must open');
      const database = new DatabaseSync(join(root, 'runs', run.binding.runId, 'outbox.sqlite'));
      const record = async () =>
        source === 'CapturedOutput'
          ? new EvidenceRecorderProcessOutput(
              opened.recorder,
              () => '2026-09-24T20:00:03.000Z',
            ).record({
              disclosure: {
                kind: 'WithheldSecret',
                reason: 'Credential',
                byteLength: credential.length,
              },
              stdout: { path: join(root, 'uncaptured-stdout'), byteLength: 0 },
              stderr: { path: join(root, 'uncaptured-stderr'), byteLength: 0 },
              acknowledge: () => Promise.resolve({ kind: 'Cleaned' }),
            })
          : source === 'Artifact'
            ? opened.recorder.storeArtifact({
                bytes: new TextEncoder().encode(credential),
                mediaType: 'text/plain; charset=utf-8',
              })
            : opened.recorder.record({
                occurredAt: '2026-09-24T20:00:02.000Z',
                producer: { kind: 'PiExecutor' },
                event: {
                  kind: 'ModelRequest',
                  piSessionId: run.binding.runId,
                  modelTurnId: 'turn-0',
                  provider: 'provider',
                  model: credential,
                  maximumOutputTokens: 100,
                },
              });
      try {
        database.exec(`
          CREATE TRIGGER reject_security_violation BEFORE INSERT ON evidence_events
          WHEN json_extract(NEW.encoded_event, '$.event.kind') = 'SecurityViolation'
          BEGIN SELECT RAISE(ABORT, 'synthetic-write-failure'); END;
        `);
        expect(await record()).toEqual({
          kind: source === 'CapturedOutput' ? 'EvidenceIntegrityFailure' : 'Unavailable',
        });
        expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
        expect(
          database
            .prepare('SELECT next_sequence, chain_head, encoded_bytes FROM stream_state')
            .get(),
        ).toEqual({ next_sequence: 0, chain_head: null, encoded_bytes: 0 });
        database.exec('DROP TRIGGER reject_security_violation');
        expect(await record()).toEqual({ kind: 'SecretDetected' });
        const page = opened.recorder.page();
        if (page.kind !== 'Page') throw new Error('complete withholding pair must exist');
        expect(
          page.page.events.map(({ sequence, event }) => ({ sequence, kind: event.kind })),
        ).toEqual([
          { sequence: 0, kind: 'DataWithheld' },
          { sequence: 1, kind: 'SecurityViolation' },
        ]);
        expect(await readdir(join(root, 'runs', run.binding.runId, 'artifacts'))).toEqual([]);
      } finally {
        database.close();
        opened.recorder.close();
      }
    },
  );

  it('records only withholding markers for a command capture that detected a secret', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    const stdout = join(root, 'stdout');
    const stderr = join(root, 'stderr');
    await Promise.all([writeFile(stdout, 'ordinary output\n'), writeFile(stderr, '')]);
    const disclosure = { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 } as const;
    try {
      const outputEvidence = new EvidenceRecorderProcessOutput(
        opened.recorder,
        () => '2026-09-24T20:00:03.000Z',
      );
      await expect(
        outputEvidence.record({
          disclosure,
          stdout: { path: stdout, byteLength: 16 },
          stderr: { path: stderr, byteLength: 0 },
          acknowledge: async () => {
            await Promise.all([rm(stdout), rm(stderr)]);
            return { kind: 'Cleaned' };
          },
        }),
      ).resolves.toEqual({ kind: 'SecretDetected' });
      const page = opened.recorder.page();
      if (page.kind !== 'Page') throw new Error('withholding markers must exist');
      expect(page.page.events.map(({ event }) => event)).toEqual([
        { kind: 'DataWithheld', disposition: disclosure },
        { kind: 'SecurityViolation', violation: 'SecretDetected' },
      ]);
      expect(await readdir(join(root, 'runs', run.binding.runId, 'artifacts'))).toEqual([]);
      await expect(access(stdout)).rejects.toThrow();
      await expect(access(stderr)).rejects.toThrow();
    } finally {
      opened.recorder.close();
    }
  });

  it('returns the exact adjacent SAIDs from one committed checkpoint-withholding pair', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    try {
      const receipt = opened.recorder.withhold({
        occurredAt: '2026-09-24T20:00:03.000Z',
        producer: { kind: 'EvidenceRecorder' },
        disclosure: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 },
      });
      const page = opened.recorder.page();
      if (page.kind !== 'Page') throw new Error('withholding markers must exist');
      const [withheld, violation] = page.page.events;
      expect(receipt).toEqual({
        kind: 'SecretDetected',
        dataWithheldEventSaid: withheld?.d,
        securityViolationEventSaid: violation?.d,
      });
      expect(violation?.predecessor).toEqual({ kind: 'Previous', eventSaid: withheld?.d });
      expect(page.page.events).toHaveLength(2);
    } finally {
      opened.recorder.close();
    }
  });

  it('withholds an actual protected credential in observation fields before creating an event SAID', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const credential = 'synthetic-private-provider-credential';
    const opened = new SqliteEvidenceOutboxes(
      () => '2026-09-24T20:00:03.000Z',
      new ProtectedCredentials([credential]),
    ).open({ run, stateRoot: root });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    try {
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:02.000Z',
          producer: { kind: 'PiExecutor' },
          event: {
            kind: 'ModelRequest',
            piSessionId: run.binding.runId,
            modelTurnId: 'turn-0',
            provider: 'provider',
            model: credential,
            maximumOutputTokens: 100,
          },
        }),
      ).toEqual({ kind: 'SecretDetected' });
      const page = opened.recorder.page();
      if (page.kind !== 'Page') throw new Error('withholding markers must exist');
      expect(page.page.events.map(({ event }) => event.kind)).toEqual([
        'DataWithheld',
        'SecurityViolation',
      ]);
      expect(JSON.stringify(page)).not.toContain(credential);
    } finally {
      opened.recorder.close();
    }
    const persisted = await readFile(join(root, 'runs', run.binding.runId, 'outbox.sqlite'));
    expect(persisted.includes(credential)).toBe(false);
    expect(persisted.includes(createHash('sha256').update(credential).digest('hex'))).toBe(false);
  });
  it.each([
    {
      content: 'Authorization: Bearer synthetic-private-capability',
      reason: 'AuthorizationHeader',
    },
    {
      content: '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----',
      reason: 'PrivateKey',
    },
    { content: 'CONCENTRATE_API_KEY=synthetic-provider-credential', reason: 'EnvironmentSecret' },
  ] as const)(
    'withholds $reason before artifact hashing or persistence',
    async ({ content, reason }) => {
      const run = runFixture();
      const root = await stateRoot();
      const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:03.000Z').open({
        run,
        stateRoot: root,
      });
      if (opened.kind !== 'Opened') throw new Error('outbox must open');
      const bytes = new TextEncoder().encode(content);
      try {
        expect(
          opened.recorder.storeArtifact({ bytes, mediaType: 'text/plain; charset=utf-8' }),
        ).toEqual({ kind: 'SecretDetected' });
        const page = opened.recorder.page();
        if (page.kind !== 'Page') throw new Error('withholding evidence must exist');
        expect(page.page.events.map(({ event }) => event)).toEqual([
          {
            kind: 'DataWithheld',
            disposition: { kind: 'WithheldSecret', reason, byteLength: bytes.byteLength },
          },
          { kind: 'SecurityViolation', violation: 'SecretDetected' },
        ]);
      } finally {
        opened.recorder.close();
      }
      const directory = join(root, 'runs', run.binding.runId);
      expect(await readdir(join(directory, 'artifacts'))).toEqual([]);
      const persisted = await readFile(join(directory, 'outbox.sqlite'));
      expect(persisted.includes(Buffer.from(bytes))).toBe(false);
      expect(persisted.includes(createHash('sha256').update(bytes).digest('hex'))).toBe(false);
    },
  );
  it.each([64 * 1_024 * 1_024, 1_024 * 1_024])(
    'preserves closure capacity with a %s-byte ceiling after real artifact backpressure',
    async (ceiling) => {
      const run = runFixture(ceiling);
      const executionCeiling = Math.floor((ceiling * 15) / 16);
      const root = await stateRoot();
      const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
        run,
        stateRoot: root,
      });
      if (opened.kind !== 'Opened') throw new Error('outbox must open');
      const recorder = opened.recorder;
      try {
        const started = recorder.record({
          occurredAt: '2026-09-24T20:00:02.000Z',
          producer: { kind: 'RunSupervisor' },
          event: { kind: 'RunStarted', fromRunVersion: run.version },
        });
        if (started.kind !== 'Recorded') throw new Error('Run start must record');
        let artifactBytes = 0;
        for (let index = 0; index < 128; index += 1) {
          const database = await stat(join(root, 'runs', run.binding.runId, 'outbox.sqlite'));
          const remaining = executionCeiling - database.size - artifactBytes;
          if (remaining <= 0) break;
          const bytes = Buffer.alloc(Math.min(512 * 1_024, remaining), index);
          const stored = recorder.storeArtifact({ bytes, mediaType: 'application/octet-stream' });
          if (stored.kind !== 'Stored') throw new Error(`artifact fill failed: ${stored.kind}`);
          artifactBytes += bytes.byteLength;
        }
        expect(artifactBytes).toBeGreaterThan(executionCeiling - 128 * 1_024);
        expect(
          recorder.record({
            occurredAt: '2026-09-24T20:00:03.000Z',
            producer: { kind: 'PiExecutor' },
            event: {
              kind: 'ModelRequest',
              piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
              modelTurnId: 'turn-0',
              provider: 'test',
              model: 'test',
              maximumOutputTokens: 1,
            },
          }),
        ).toEqual({ kind: 'OutboxBackpressure' });
        const verified = checkpoint(run, 1, 0, started.event.d, 'OutboxBackpressure');
        expect(
          recorder.storeCheckpoint({
            checkpoint: verified,
            completionConditionIds: ['public-test'],
          }),
        ).toEqual({ kind: 'Stored', checkpoint: verified });
        for (const event of [
          { kind: 'CheckpointVerified', checkpointSaid: verified.d },
          { kind: 'RunBlocked', reason: 'OutboxBackpressure', checkpointSaid: verified.d },
          { kind: 'CheckpointAccepted', checkpointSaid: verified.d },
        ] as const) {
          expect(
            recorder.record({
              occurredAt: '2026-09-24T20:00:04.000Z',
              producer: { kind: 'EvidenceRecorder' },
              event,
            }),
          ).toMatchObject({ kind: 'Recorded' });
        }
        expect(recorder.readiness()).toMatchObject({
          kind: 'Ready',
          readiness: { kind: 'Continued', nextSequence: 4 },
        });
      } finally {
        recorder.close();
      }
    },
  );

  it('attributes a tool effect to the provider message that proposed it before dispatch', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('fixture outbox must open');
    const artifact = opened.recorder.storeArtifact({
      bytes: new TextEncoder().encode('{"role":"assistant"}'),
      mediaType: 'application/json',
    });
    if (artifact.kind !== 'Stored') throw new Error('fixture message artifact must store');
    const attribution = {
      piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: 'turn-0',
      toolCallId: 'call-0',
      proposalIndex: 0,
      tool: 'run_tests' as const,
      requiredCapability: 'RunTests' as const,
      resource: `command://public-test@${said('i')}`,
    };
    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:02.000Z',
        producer: { kind: 'PiExecutor' },
        event: {
          kind: 'ModelMessageCompleted',
          piSessionId: attribution.piSessionId,
          modelTurnId: attribution.modelTurnId,
          messageArtifactSaid: artifact.artifact.d,
          disposition: 'Completed',
          usage: {
            inputTokens: 120,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            spendMicroUsd: 1,
          },
        },
      }),
    ).toMatchObject({ kind: 'Recorded' });
    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:03.000Z',
        producer: { kind: 'ToolGateway' },
        event: { kind: 'ToolProposed', ...attribution },
      }),
    ).toMatchObject({ kind: 'Recorded' });
    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:04.000Z',
        producer: { kind: 'ToolGateway' },
        event: { kind: 'EffectCompleted', ...attribution, outputArtifactSaids: [] },
      }),
    ).toMatchObject({ kind: 'Recorded' });

    expect(opened.recorder.read(run)).toMatchObject({
      kind: 'Proved',
      proof: {
        message: { sequence: 0 },
        proposal: { sequence: 1 },
        effect: { sequence: 2 },
      },
    });
    opened.recorder.close();
  });

  it('durably stores a verified checkpoint before admitting its evidence reference', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') {
      throw new Error(`fixture outbox did not open: ${opened.kind}`);
    }
    const first = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'RunStarted', fromRunVersion: run.version },
    });
    if (first.kind !== 'Recorded') {
      throw new Error('fixture first event must record');
    }
    const verified = checkpoint(run, 1, 0, first.event.d);

    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:03.000Z',
        producer: { kind: 'EvidenceRecorder' },
        event: { kind: 'CheckpointVerified', checkpointSaid: verified.d },
      }),
    ).toEqual({ kind: 'ObservationRejected' });
    expect(
      opened.recorder.storeCheckpoint({
        checkpoint: verified,
        completionConditionIds: ['public-test'],
      }),
    ).toEqual({
      kind: 'Stored',
      checkpoint: verified,
    });
    expect(opened.recorder.checkpoint(verified.d)).toEqual({
      kind: 'Read',
      checkpoint: verified,
    });
    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:03.000Z',
        producer: { kind: 'EvidenceRecorder' },
        event: { kind: 'CheckpointVerified', checkpointSaid: verified.d },
      }),
    ).toMatchObject({ kind: 'Recorded', event: { sequence: 1 } });
    opened.recorder.close();
  });

  it('keeps the exact pending batch while producers append later evidence', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:04.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('outbox must open');
    try {
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:02.000Z',
          producer: { kind: 'RunSupervisor' },
          event: { kind: 'RunStarted', fromRunVersion: run.version },
        }).kind,
      ).toBe('Recorded');
      const pending = opened.recorder.page();
      if (pending.kind !== 'Page') throw new Error('pending batch must exist');
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:03.000Z',
          producer: { kind: 'RunSupervisor' },
          event: { kind: 'IncarnationStarted' },
        }).kind,
      ).toBe('Recorded');
      expect(opened.recorder.page()).toEqual(pending);
      const last = pending.page.events.at(-1);
      if (last === undefined) throw new Error('batch must contain an event');
      expect(
        opened.recorder.acknowledge({
          version: 1,
          disposition: { kind: 'Accepted' },
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          batchSaid: pending.page.batch.d,
          acceptedThroughSequence: last.sequence,
          chainHeadSaid: last.d,
          receivedAt: '2026-09-24T20:00:05.000Z',
        }).kind,
      ).toBe('Acknowledged');
      const following = opened.recorder.page();
      expect(following).toMatchObject({
        kind: 'Page',
        page: {
          batch: { startingSequence: 1, endingSequence: 1 },
          events: [{ event: { kind: 'IncarnationStarted' } }],
        },
      });
      if (following.kind !== 'Page') throw new Error('following batch must exist');
      const database = new DatabaseSync(join(root, 'runs', run.binding.runId, 'outbox.sqlite'), {
        readOnly: true,
      });
      try {
        expect(
          database.prepare('SELECT batch_said, ending_sequence FROM pending_evidence_batch').all(),
        ).toEqual([{ batch_said: following.page.batch.d, ending_sequence: 1 }]);
      } finally {
        database.close();
      }
    } finally {
      opened.recorder.close();
    }
  });

  it('atomically allocates the causal chain and pages bounded decoded events', async () => {
    const run = runFixture();
    const root = await stateRoot();
    let time = 2;
    const opened = new SqliteEvidenceOutboxes(
      () => `2026-09-24T20:00:${String(time++).padStart(2, '0')}.000Z`,
    ).open({ run, stateRoot: root });
    if (opened.kind !== 'Opened') {
      throw new Error(`fixture outbox did not open: ${opened.kind}`);
    }

    expect(opened.recorder.readiness()).toEqual({
      kind: 'Ready',
      readiness: {
        kind: 'Genesis',
        streamId: run.binding.evidenceStreamId,
      },
    });
    const first = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'RunStarted', fromRunVersion: run.version },
    });
    if (first.kind !== 'Recorded') {
      throw new Error(`first event was not recorded: ${first.kind}`);
    }
    const second = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:03.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'IncarnationStarted' },
    });
    if (second.kind !== 'Recorded') {
      throw new Error(`second event was not recorded: ${second.kind}`);
    }

    expect(first.event).toMatchObject({ sequence: 0, predecessor: { kind: 'Genesis' } });
    expect(second.event).toMatchObject({
      sequence: 1,
      predecessor: { kind: 'Previous', eventSaid: first.event.d },
    });
    expect(opened.recorder.readiness()).toEqual({
      kind: 'Ready',
      readiness: {
        kind: 'Continued',
        streamId: run.binding.evidenceStreamId,
        nextSequence: 2,
        previousEventSaid: second.event.d,
      },
    });
    const page = opened.recorder.page();
    expect(page).toMatchObject({
      kind: 'Page',
      page: {
        batch: {
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          startingSequence: 0,
          endingSequence: 1,
          eventSaids: [first.event.d, second.event.d],
        },
        events: [first.event, second.event],
      },
    });
    if (page.kind !== 'Page') {
      throw new Error('fixture evidence page must exist');
    }
    const acknowledgement = {
      version: 1 as const,
      disposition: { kind: 'Accepted' as const },
      runId: run.binding.runId,
      evidenceStreamId: run.binding.evidenceStreamId,
      batchSaid: page.page.batch.d,
      acceptedThroughSequence: 1,
      chainHeadSaid: second.event.d,
      receivedAt: '2026-09-24T20:00:04.000Z',
    };
    expect(opened.recorder.acknowledge(acknowledgement)).toEqual({
      kind: 'Acknowledged',
      acknowledgement,
    });
    expect(opened.recorder.acknowledge(acknowledgement)).toEqual({
      kind: 'AlreadyAcknowledged',
      acknowledgement,
    });
    expect(
      opened.recorder.acknowledge({
        ...acknowledgement,
        receivedAt: '2026-09-24T20:00:05.000Z',
      }),
    ).toEqual({ kind: 'AcknowledgementRejected' });
    expect(opened.recorder.page()).toEqual({ kind: 'Empty' });
    opened.recorder.close();
  });

  it('durably records the exact sealed server cursor only after every local event is acknowledged', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:04.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error('fixture outbox must open');
    const started = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'RunStarted', fromRunVersion: run.version },
    });
    if (started.kind !== 'Recorded') throw new Error('fixture start must record');
    const verified = checkpoint(run, 1, 0, started.event.d);
    expect(
      opened.recorder.storeCheckpoint({
        checkpoint: verified,
        completionConditionIds: ['public-test'],
      }),
    ).toMatchObject({ kind: 'Stored' });
    expect(
      opened.recorder.record({
        occurredAt: '2026-09-24T20:00:03.000Z',
        producer: { kind: 'EvidenceRecorder' },
        event: { kind: 'CheckpointVerified', checkpointSaid: verified.d },
      }),
    ).toMatchObject({ kind: 'Recorded' });
    const firstPage = opened.recorder.page();
    if (firstPage.kind !== 'Page') throw new Error('checkpoint page must exist');
    expect(
      opened.recorder.acknowledge({
        version: 1,
        disposition: { kind: 'Accepted' },
        runId: run.binding.runId,
        evidenceStreamId: run.binding.evidenceStreamId,
        batchSaid: firstPage.page.batch.d,
        acceptedThroughSequence: firstPage.page.batch.endingSequence,
        chainHeadSaid: firstPage.page.events.at(-1)?.d ?? '',
        receivedAt: '2026-09-24T20:00:04.000Z',
      }),
    ).toMatchObject({ kind: 'Acknowledged' });
    const firstEventSaids = firstPage.page.events.map((event) => event.d);
    expect(retainedEventSaids(root, run.binding.runId)).toEqual(firstEventSaids);
    expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
    const accepted = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:05.000Z',
      producer: { kind: 'EvidenceRecorder' },
      event: { kind: 'CheckpointAccepted', checkpointSaid: verified.d },
    });
    if (accepted.kind !== 'Recorded') throw new Error('checkpoint acceptance must record');
    const finalPage = opened.recorder.page();
    if (finalPage.kind !== 'Page') throw new Error('final page must exist');
    expect(
      opened.recorder.acknowledge({
        version: 1,
        disposition: { kind: 'Accepted' },
        runId: run.binding.runId,
        evidenceStreamId: run.binding.evidenceStreamId,
        batchSaid: finalPage.page.batch.d,
        acceptedThroughSequence: finalPage.page.batch.endingSequence,
        chainHeadSaid: accepted.event.d,
        receivedAt: '2026-09-24T20:00:06.000Z',
      }),
    ).toMatchObject({ kind: 'Acknowledged' });
    const completeEventSaids = [
      ...firstEventSaids,
      ...finalPage.page.events.map((event) => event.d),
    ];
    expect(retainedEventSaids(root, run.binding.runId)).toEqual(completeEventSaids);
    expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
    const projection = {
      version: 1 as const,
      runId: run.binding.runId,
      evidenceStreamId: run.binding.evidenceStreamId,
      cursor: {
        kind: 'Accepted' as const,
        eventCount: 3,
        acceptedThroughSequence: 2,
        chainHeadSaid: accepted.event.d,
      },
      checkpoint: { kind: 'Accepted' as const, checkpointSaid: verified.d },
      seal: {
        kind: 'Sealed' as const,
        sealExchangeSaid: said('s'),
        eventCount: 3,
        finalSequence: 2,
        chainHeadSaid: accepted.event.d,
        sealedAt: '2026-09-24T20:00:07.000Z',
      },
    };

    expect(opened.recorder.recordSealAcknowledgement(projection)).toEqual({
      kind: 'Recorded',
      projection,
    });
    expect(opened.recorder.recordSealAcknowledgement(projection)).toEqual({
      kind: 'AlreadyRecorded',
      projection,
    });
    expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'Read', projection });
    opened.recorder.close();
    expect(retainedEventSaids(root, run.binding.runId)).toEqual(completeEventSaids);
  });

  it.each(['Observation', 'EffectFailed'] as const)(
    'atomically publishes bounded artifact bytes before %s may reference them',
    async (kind) => {
      const run = runFixture();
      const root = await stateRoot();
      const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
        run,
        stateRoot: root,
      });
      if (opened.kind !== 'Opened') {
        throw new Error(`fixture outbox did not open: ${opened.kind}`);
      }
      const bytes = new TextEncoder().encode('public verifier output\n');
      const stored = opened.recorder.storeArtifact({
        bytes,
        mediaType: 'text/plain; charset=utf-8',
      });
      if (stored.kind !== 'Stored') {
        throw new Error(`fixture artifact was not stored: ${stored.kind}`);
      }
      const artifactPath = join(root, 'runs', run.binding.runId, 'artifacts', stored.artifact.d);
      expect((await lstat(artifactPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(artifactPath)).toEqual(Buffer.from(bytes));
      expect(opened.recorder.artifact(stored.artifact.d)).toEqual({
        kind: 'Read',
        artifact: stored.artifact,
        bytes,
      });
      const event: EvidenceEventDetail =
        kind === 'Observation'
          ? { kind, source: 'Verifier', artifactSaid: stored.artifact.d }
          : {
              kind,
              failure: 'BudgetExhausted',
              outputArtifactSaids: [stored.artifact.d],
              piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
              modelTurnId: 'turn-1',
              toolCallId: 'call-0',
              proposalIndex: 0,
              tool: 'run_tests',
              requiredCapability: 'RunTests',
              resource: 'command://public-test',
            };
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:03.000Z',
          producer: { kind: kind === 'Observation' ? 'PublicTaskVerifier' : 'ToolGateway' },
          event,
        }),
      ).toMatchObject({ kind: 'Recorded' });
      const pending = opened.recorder.page();
      if (pending.kind !== 'Page') throw new Error('output evidence must be pending delivery');
      expect(pending.page.events.map(({ event: detail }) => detail)).toEqual([event]);
      expect(evidenceArtifactReferences(pending.page.events[0]?.event ?? event)).toEqual([
        stored.artifact.d,
      ]);
      opened.recorder.close();
    },
  );

  it('uses the required defensive durability profile and owner-only permissions', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') {
      throw new Error(`fixture outbox did not open: ${opened.kind}`);
    }
    opened.recorder.close();
    const path = join(root, 'runs', run.binding.runId, 'outbox.sqlite');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    database.close();
  });

  it('returns at most one 32-event transport page and refuses runtime restoration', async () => {
    const run = runFixture();
    const root = await stateRoot();
    const outboxes = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z');
    const opened = outboxes.open({ run, stateRoot: root });
    if (opened.kind !== 'Opened') {
      throw new Error(`fixture outbox did not open: ${opened.kind}`);
    }
    for (let index = 0; index < 33; index += 1) {
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:02.000Z',
          producer: { kind: 'RunSupervisor' },
          event: { kind: 'BudgetDebited', budget: 'toolProposals', amount: 0, consumed: 0 },
        }),
      ).toMatchObject({ kind: 'Recorded' });
    }
    const page = opened.recorder.page();
    expect(page.kind).toBe('Page');
    if (page.kind !== 'Page') {
      throw new Error('fixture page must exist');
    }
    expect(page.page.events).toHaveLength(32);
    expect(page.page.encodedBytes).toBeLessThanOrEqual(256 * 1_024);
    opened.recorder.close();

    expect(outboxes.open({ run, stateRoot: root })).toEqual({
      kind: 'ExistingOutboxRequiresLaterResume',
    });
  });

  it('rejects original execution accounting recorded after the expired lease', async () => {
    const original = runFixture();
    const run: Run = {
      ...original,
      binding: {
        ...original.binding,
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'a125a348-0e50-49d4-a106-c3ca22e0b949',
          ordinal: 1,
        },
      },
    };
    let time = '2026-09-24T20:00:02.000Z';
    const root = await stateRoot();
    const outboxes = new SqliteEvidenceOutboxes(() => time);
    const opened = outboxes.open({ run, stateRoot: root });
    if (opened.kind !== 'Opened') throw new Error(opened.kind);
    const started = opened.recorder.record({
      occurredAt: time,
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'RunStarted', fromRunVersion: run.version },
    });
    if (started.kind !== 'Recorded') throw new Error(started.kind);
    time = '2026-09-24T20:10:00.000Z';
    expect(
      opened.recorder.recordBudgetDebit({
        occurredAt: time,
        producer: { kind: 'PiExecutor' },
        debits: [{ kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 }],
      }),
    ).toMatchObject({ kind: 'Recorded' });
    opened.recorder.close();
    expect(outboxes.reconcileCalibration({ run, stateRoot: root }, [started.event])).toEqual({
      kind: 'LocalStateCorruption',
    });
  });

  it('reopens an expired calibration only against its exact hosted prefix and rejects execution', async () => {
    const original = runFixture();
    const run: Run = {
      ...original,
      binding: {
        ...original.binding,
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'a125a348-0e50-49d4-a106-c3ca22e0b949',
          ordinal: 1,
        },
      },
    };
    const root = await stateRoot();
    const opened = new SqliteEvidenceOutboxes(() => '2026-09-24T20:00:02.000Z').open({
      run,
      stateRoot: root,
    });
    if (opened.kind !== 'Opened') throw new Error(opened.kind);
    const started = opened.recorder.record({
      occurredAt: '2026-09-24T20:00:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'RunStarted', fromRunVersion: run.version },
    });
    if (started.kind !== 'Recorded') throw new Error(started.kind);
    opened.recorder.close();
    const recovery = new SqliteEvidenceOutboxes(() => '2026-09-24T20:10:00.000Z');
    expect(recovery.reconcileCalibration({ run, stateRoot: root }, [])).toEqual({
      kind: 'LocalStateCorruption',
    });
    expect(
      recovery.reconcileCalibration({ run, stateRoot: root }, [
        { ...started.event, taskRevisionSaid: said('z') },
      ]),
    ).toEqual({ kind: 'LocalStateCorruption' });
    const reopened = recovery.reconcileCalibration({ run, stateRoot: root }, [started.event]);
    expect(reopened.kind).toBe('Opened');
    if (reopened.kind !== 'Opened') throw new Error(reopened.kind);
    expect(
      reopened.recorder.record({
        occurredAt: '2026-09-24T20:10:00.000Z',
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: run.version },
      }),
    ).toEqual({ kind: 'ObservationRejected' });
    expect(
      reopened.recorder.recordBudgetDebit({
        occurredAt: '2026-09-24T20:10:00.000Z',
        producer: { kind: 'RunSupervisor' },
        debits: [{ kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 }],
      }),
    ).toEqual({ kind: 'ObservationRejected' });
    expect(reopened.recorder.readiness()).toMatchObject({
      kind: 'Ready',
      readiness: { nextSequence: 1, previousEventSaid: started.event.d },
    });
    expect(
      reopened.recorder.recordBudgetDebit({
        occurredAt: '2026-09-24T20:10:00.000Z',
        producer: { kind: 'EvidenceRecorder' },
        debits: [
          {
            kind: 'BudgetDebited',
            budget: 'changedWorktreeBytes',
            amount: 17_000_000,
            consumed: 17_000_000,
          },
        ],
      }),
    ).toMatchObject({ kind: 'Recorded' });
    reopened.recorder.close();
    const retried = recovery.reconcileCalibration({ run, stateRoot: root }, [started.event]);
    expect(retried.kind).toBe('Opened');
    if (retried.kind !== 'Opened') throw new Error(retried.kind);
    expect(retried.events).toHaveLength(2);
    expect(retried.events[0]).toEqual(started.event);
    retried.recorder.close();
  });
});
