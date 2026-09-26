import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireFirstRunLease,
  createRun,
  recordRunCalibration,
  renewRunLease,
  type InitialSpecializationAccepted,
  type Run,
  type RunCalibrationDisposition,
  type RunPurpose,
  type TaskBudgets,
} from '@devrandom/domain';
import { harnessCommandFingerprint } from '@devrandom/protocol';

import { acquireRunLease } from '../application/acquire-run-lease.js';
import { runRoutes } from '../route/run-routes.js';
import { MongoHarnessBootstrap } from '../../harness/infrastructure/mongo-harness-bootstrap.js';
import {
  MongoHarnessRevisions,
  harnessRevisionsCollectionName,
} from '../../harness/infrastructure/mongo-harness-revisions.js';
import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';
import { MongoRunBootstrap } from './mongo-run-bootstrap.js';
import { MongoRuns, runAdmissionsCollectionName, runsCollectionName } from './mongo-runs.js';
import { encodeRunDocument, type RunDocument } from './run-document.js';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const integration = mongodbUri === undefined ? describe.skip : describe;
const governorAid = `E${'y'.repeat(43)}`;
const promotionMandateSaid = `E${'x'.repeat(43)}`;
const runFingerprint = `sha256:${'9'.repeat(64)}`;
const acceptedAt = '2026-09-24T20:00:00.000Z';

integration('Mongo Run admission storage', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(`devrandom_runs_${randomUUID().replaceAll('-', '')}`);
  const harnesses = new MongoHarnessRevisions(database);
  const runs = new MongoRuns(client, database);

  beforeAll(async () => {
    await client.connect();
    await new MongoHarnessBootstrap(database).bootstrap();
    await new MongoRunBootstrap(database).bootstrap();
  });

  beforeEach(async () => {
    await Promise.all([
      database.collection(harnessRevisionsCollectionName).deleteMany({}),
      database.collection(runAdmissionsCollectionName).deleteMany({}),
      database.collection(runsCollectionName).deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  async function admittedHarness() {
    const command = baselineHarnessCommandFixture();
    const projection = {
      version: 1 as const,
      ownerAid: harnessTask.ownerAid,
      commandId: command.commandId,
      acceptedAt: '2026-09-24T19:50:00.000Z',
      revision: command.revision,
    };
    await harnesses.create({ projection, commandFingerprint: harnessCommandFingerprint(command) });
    return projection;
  }

  function proposedRun(
    harness: Awaited<ReturnType<typeof admittedHarness>>,
    runId: string,
    budget: TaskBudgets = harness.revision.budgetCeilings.task,
    purpose: RunPurpose = {
      kind: 'PreparedCompatibilityCalibration',
      campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
      ordinal: 1,
    },
    incumbent?: InitialSpecializationAccepted,
  ) {
    const initialSpecialization: InitialSpecializationAccepted = incumbent ?? {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: harness.revision.task.harnessLineageId,
      harnessRevisionSaid: harness.revision.d,
      runId,
      acceptedAt,
    };
    const created = createRun({
      runId,
      ownerAid: harness.ownerAid,
      taskId: harness.revision.task.taskId,
      taskRevisionSaid: harness.revision.task.revisionSaid,
      harnessLineageId: harness.revision.task.harnessLineageId,
      personalAgentAid: harness.revision.authority.personalAgentAid,
      taskMandateSaid: harness.revision.authority.taskMandateSaid,
      governorAid,
      promotionMandateSaid,
      initialHarnessRevisionSaid: harness.revision.d,
      purpose,
      initialSpecialization,
      repository: {
        objectFormat: harness.revision.repository.objectFormat,
        commit: harness.revision.repository.commit,
        tree: harness.revision.repository.tree,
      },
      commandId: randomUUID(),
      admissionExchangeSaid: `E${'z'.repeat(43)}`,
      evidenceStreamId: randomUUID(),
      budget,
      acceptedAt,
    });
    if (created.kind !== 'Created') {
      throw new Error('expected a valid Run');
    }
    return created.run;
  }

  function activation(run: ReturnType<typeof proposedRun>) {
    return run.binding.initialSpecialization;
  }

  async function commitRun(run: ReturnType<typeof proposedRun>) {
    await runs.reserve({
      ownerAid: run.binding.ownerAid,
      commandId: run.binding.commandId,
      commandFingerprint: runFingerprint,
      admissionExchangeSaid: run.binding.admissionExchangeSaid,
      reservedAt: '2026-09-24T19:59:00.000Z',
    });
    const commitment = await runs.accept({
      ownerAid: run.binding.ownerAid,
      commandId: run.binding.commandId,
      commandFingerprint: runFingerprint,
      run,
      activation: activation(run),
    });
    if (commitment.kind !== 'RunCommitted') {
      throw new Error('expected a committed Run fixture');
    }
    return commitment.run;
  }

  async function recordCalibration(run: Run, disposition: RunCalibrationDisposition): Promise<Run> {
    const recording = recordRunCalibration(
      { ...run, lifecycle: { kind: 'Active', phase: { kind: 'Running' } } },
      {
        checkpointSaid: `E${run.binding.purpose.kind === 'PreparedCompatibilityCalibration' ? String(run.binding.purpose.ordinal).repeat(43) : 'q'.repeat(43)}`,
        disposition,
      },
    );
    if (recording.kind !== 'Recorded') {
      throw new Error('expected a terminal calibration fixture');
    }
    const replaced = await database
      .collection<RunDocument>(runsCollectionName)
      .replaceOne(
        { _id: run.binding.runId, runVersion: run.version },
        encodeRunDocument(recording.run, runFingerprint),
      );
    if (replaced.modifiedCount !== 1) {
      throw new Error('expected the calibration fixture to be persisted');
    }
    return recording.run;
  }

  it('commits H1 inception, Run, and admission acknowledgement atomically', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const reservation = {
      ownerAid: run.binding.ownerAid,
      commandId: run.binding.commandId,
      commandFingerprint: runFingerprint,
      admissionExchangeSaid: run.binding.admissionExchangeSaid,
      reservedAt: '2026-09-24T19:59:00.000Z',
    };

    await expect(runs.reserve(reservation)).resolves.toEqual({ kind: 'RunAdmissionReserved' });
    await expect(
      runs.accept({
        ownerAid: run.binding.ownerAid,
        commandId: run.binding.commandId,
        commandFingerprint: runFingerprint,
        run,
        activation: activation(run),
      }),
    ).resolves.toEqual({ kind: 'RunCommitted', run });
    await expect(runs.reserve(reservation)).resolves.toEqual({
      kind: 'AcceptedRunAdmission',
      run,
    });
    await expect(
      harnesses.findAccepted(harness.ownerAid, harness.revision.d),
    ).resolves.toMatchObject({
      kind: 'AcceptedHarnessFound',
      activation: {
        kind: 'InitialSpecializationAccepted',
        runId: run.binding.runId,
      },
    });
  });

  it('finds a Run only through its owner binding', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    await commitRun(run);

    await expect(runs.findById(run.binding.ownerAid, run.binding.runId)).resolves.toEqual({
      kind: 'RunFound',
      run,
    });
    await expect(runs.findById(`E${'z'.repeat(43)}`, run.binding.runId)).resolves.toEqual({
      kind: 'RunNotFound',
    });
    await expect(runs.findById(run.binding.ownerAid, randomUUID())).resolves.toEqual({
      kind: 'RunNotFound',
    });
  });

  it('rolls H1 inception back when Run insertion fails after the compare-and-set', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const collisionHarnessLineageId = randomUUID();
    const collision = createRun({
      ...run.binding,
      ownerAid: `E${'q'.repeat(43)}`,
      taskId: randomUUID(),
      taskRevisionSaid: `E${'r'.repeat(43)}`,
      harnessLineageId: collisionHarnessLineageId,
      personalAgentAid: `E${'s'.repeat(43)}`,
      governorAid: `E${'t'.repeat(43)}`,
      initialSpecialization: {
        ...run.binding.initialSpecialization,
        harnessLineageId: collisionHarnessLineageId,
      },
      commandId: randomUUID(),
      evidenceStreamId: randomUUID(),
    });
    if (collision.kind !== 'Created') {
      throw new Error('expected a collision fixture');
    }
    await database.collection<RunDocument>(runsCollectionName).insertOne(
      encodeRunDocument(
        {
          ...collision.run,
          lifecycle: {
            kind: 'Ended',
            outcome: {
              kind: 'Failed',
              failure: 'LocalStateCorruption',
              checkpointSaid: `E${'u'.repeat(43)}`,
            },
          },
        },
        `sha256:${'8'.repeat(64)}`,
      ),
    );
    await runs.reserve({
      ownerAid: run.binding.ownerAid,
      commandId: run.binding.commandId,
      commandFingerprint: runFingerprint,
      admissionExchangeSaid: run.binding.admissionExchangeSaid,
      reservedAt: '2026-09-24T19:59:00.000Z',
    });

    await expect(
      runs.accept({
        ownerAid: run.binding.ownerAid,
        commandId: run.binding.commandId,
        commandFingerprint: runFingerprint,
        run,
        activation: activation(run),
      }),
    ).resolves.toEqual({ kind: 'ConcurrentRunAdmission' });
    await expect(
      harnesses.findAccepted(harness.ownerAid, harness.revision.d),
    ).resolves.toMatchObject({
      activation: { kind: 'AwaitingRunAdmission' },
    });
  });

  it('admits five terminal calibrations and then one retained Run against the same H1', async () => {
    const harness = await admittedHarness();
    const campaignId = '4dd443a3-d93c-4857-8ede-b08aa3f979c5';
    const budget = {
      ...harness.revision.budgetCeilings.task,
      runsPerAdmittedUser: 6,
      hostedWorkRunsGlobally: 21,
    };
    const category = {
      version: 1 as const,
      taskId: harness.revision.task.taskId,
      taskRevisionSaid: harness.revision.task.revisionSaid,
      harnessRevisionSaid: harness.revision.d,
      currentCommandSaid: `E${'j'.repeat(43)}`,
      tamperCommandSaid: `E${'k'.repeat(43)}`,
      legacyCommandSaid: `E${'l'.repeat(43)}`,
      legacyObservedExitCode: 101 as const,
    };
    let incumbent: InitialSpecializationAccepted | undefined;

    for (const ordinal of [1, 2, 3, 4, 5] as const) {
      const proposed = proposedRun(
        harness,
        randomUUID(),
        budget,
        { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal },
        incumbent,
      );
      const committed = await commitRun(proposed);
      incumbent ??= committed.binding.initialSpecialization;
      await recordCalibration(
        committed,
        ordinal === 5
          ? { kind: 'Excluded', reason: 'ProviderUnavailable' }
          : { kind: 'Confirmed', category },
      );
    }
    if (incumbent === undefined) {
      throw new Error('expected the first calibration to activate H1');
    }

    const retained = proposedRun(harness, randomUUID(), budget, { kind: 'Retained' }, incumbent);
    await expect(commitRun(retained)).resolves.toEqual(retained);
    await expect(
      database.collection<RunDocument>(runsCollectionName).countDocuments({
        taskId: harness.revision.task.taskId,
        taskRevisionSaid: harness.revision.task.revisionSaid,
      }),
    ).resolves.toBe(6);
    await expect(
      harnesses.findAccepted(harness.ownerAid, harness.revision.d),
    ).resolves.toMatchObject({
      kind: 'AcceptedHarnessFound',
      activation: incumbent,
    });
  });

  it('rejects a skipped calibration ordinal without activating H1', async () => {
    const harness = await admittedHarness();
    const skipped = proposedRun(
      harness,
      randomUUID(),
      harness.revision.budgetCeilings.task,
      {
        kind: 'PreparedCompatibilityCalibration',
        campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
        ordinal: 2,
      },
      {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId: harness.revision.task.harnessLineageId,
        harnessRevisionSaid: harness.revision.d,
        runId: randomUUID(),
        acceptedAt: '2026-09-24T19:55:00.000Z',
      },
    );
    await runs.reserve({
      ownerAid: skipped.binding.ownerAid,
      commandId: skipped.binding.commandId,
      commandFingerprint: runFingerprint,
      admissionExchangeSaid: skipped.binding.admissionExchangeSaid,
      reservedAt: '2026-09-24T19:59:00.000Z',
    });

    await expect(
      runs.accept({
        ownerAid: skipped.binding.ownerAid,
        commandId: skipped.binding.commandId,
        commandFingerprint: runFingerprint,
        run: skipped,
        activation: skipped.binding.initialSpecialization,
      }),
    ).resolves.toEqual({ kind: 'RunCommandConflict' });
    await expect(
      harnesses.findAccepted(harness.ownerAid, harness.revision.d),
    ).resolves.toMatchObject({ activation: { kind: 'AwaitingRunAdmission' } });
  });

  it.each([
    ['owner', { activeRunsPerAdmittedUser: 0 }, { kind: 'OwnerRunCapacityExceeded' as const }],
    ['global', { activeHostedWorkRunsGlobally: 0 }, { kind: 'GlobalRunCapacityExceeded' as const }],
  ])(
    'enforces a zero effective %s active-Run ceiling before H1 inception',
    async (_scope, budgetOverride, expected) => {
      const harness = await admittedHarness();
      const run = proposedRun(harness, randomUUID(), {
        ...harness.revision.budgetCeilings.task,
        ...budgetOverride,
      });
      await runs.reserve({
        ownerAid: run.binding.ownerAid,
        commandId: run.binding.commandId,
        commandFingerprint: runFingerprint,
        admissionExchangeSaid: run.binding.admissionExchangeSaid,
        reservedAt: '2026-09-24T19:59:00.000Z',
      });

      await expect(
        runs.accept({
          ownerAid: run.binding.ownerAid,
          commandId: run.binding.commandId,
          commandFingerprint: runFingerprint,
          run,
          activation: activation(run),
        }),
      ).resolves.toEqual(expected);
      await expect(
        harnesses.findAccepted(harness.ownerAid, harness.revision.d),
      ).resolves.toMatchObject({
        activation: { kind: 'AwaitingRunAdmission' },
      });
    },
  );

  it('acquires the first lease once and reconciles an exact retry without extending it', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    const firstLeaseAt = Date.now() - 5_000;
    const firstLeaseTime = new Date(firstLeaseAt).toISOString();
    const firstLeaseExpiry = new Date(firstLeaseAt + 45_000).toISOString();
    await commitRun(run);

    const first = await runs.acquire({
      ownerAid: run.binding.ownerAid,
      runId: run.binding.runId,
      incarnationId,
      expectedRunVersion: 0,
      serverTime: firstLeaseTime,
    });
    expect(first).toMatchObject({
      kind: 'RunLeaseAcquired',
      run: {
        version: 1,
        lease: {
          kind: 'Held',
          incarnationId,
          acquiredAt: firstLeaseTime,
          expiresAt: firstLeaseExpiry,
          lastChange: { kind: 'Acquired', fromRunVersion: 0 },
        },
      },
    });

    await expect(
      runs.acquire({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 0,
        serverTime: new Date(firstLeaseAt + 1_000).toISOString(),
      }),
    ).resolves.toMatchObject({
      kind: 'RunLeaseReconciled',
      run: {
        version: 1,
        lease: { expiresAt: firstLeaseExpiry },
      },
    });
  });

  it('reconciles a committed first lease through the public route after its HTTP response is lost', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    const firstLeaseAt = Date.now() - 5_000;
    const firstLeaseExpiry = new Date(firstLeaseAt + 45_000).toISOString();
    await commitRun(run);
    const owner = {
      ownerAid: run.binding.ownerAid,
      credentialSaid: `E${'w'.repeat(43)}`,
    };
    let serverTime = new Date(firstLeaseAt).toISOString();
    let loseFirstLeaseResponse = true;
    const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const path = `/api/runs/${run.binding.runId}/incarnations/${incarnationId}`;
    instance.addHook('onSend', (request, _reply, payload, next) => {
      if (request.method === 'PUT' && request.url === path && loseFirstLeaseResponse) {
        loseFirstLeaseResponse = false;
        request.raw.socket.destroy();
      }
      next(null, payload);
    });
    await instance.register(
      runRoutes({
        access: {
          authorize: () => Promise.resolve({ kind: 'RunAccessAuthorized', owner }),
        },
        conversation: {
          admit: () => Promise.reject(new Error('Run was already admitted')),
          inspect: () => Promise.reject(new Error('Run inspection was not requested')),
          acquireLease: (input) =>
            acquireRunLease(input, {
              currentUserCredential: {
                verify: () => Promise.resolve({ kind: 'UserCredentialCurrent' }),
              },
              leases: runs,
              now: () => serverTime,
            }),
          renewLease: () => Promise.reject(new Error('Lease renewal was not requested')),
        },
        now: () => serverTime,
        newCorrelationId: randomUUID,
      }),
    );
    try {
      const origin = await instance.listen({ port: 0, host: '127.0.0.1' });
      const request = () =>
        fetch(new URL(path, origin), {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${'s'.repeat(43)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: 1, expectedRunVersion: 0 }),
        });
      await expect(request()).rejects.toThrow();
      await expect(runs.findById(owner.ownerAid, run.binding.runId)).resolves.toMatchObject({
        kind: 'RunFound',
        run: {
          version: 1,
          lease: {
            kind: 'Held',
            incarnationId,
            expiresAt: firstLeaseExpiry,
          },
        },
      });

      serverTime = new Date(firstLeaseAt + 1_000).toISOString();
      const retried = await request();
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({
        disposition: 'Reconciled',
        runId: run.binding.runId,
        incarnationId,
        runVersion: 1,
        serverTime,
        expiresAt: firstLeaseExpiry,
      });
      await expect(database.collection(runsCollectionName).countDocuments({})).resolves.toBe(1);
    } finally {
      await instance.close();
    }
  }, 15_000);

  it('rejects a competing incarnation and requires a later resume after expiry', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incumbentIncarnationId = randomUUID();
    const firstLeaseAt = Date.now() - 5_000;
    const firstLeaseExpiry = new Date(firstLeaseAt + 45_000).toISOString();
    await commitRun(run);
    await runs.acquire({
      ownerAid: run.binding.ownerAid,
      runId: run.binding.runId,
      incarnationId: incumbentIncarnationId,
      expectedRunVersion: 0,
      serverTime: new Date(firstLeaseAt).toISOString(),
    });

    await expect(
      runs.acquire({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId: randomUUID(),
        expectedRunVersion: 1,
        serverTime: new Date(firstLeaseAt + 1_000).toISOString(),
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseConflict',
      incarnationId: incumbentIncarnationId,
      expiresAt: firstLeaseExpiry,
      currentVersion: 1,
    });
    await expect(
      runs.acquire({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId: incumbentIncarnationId,
        expectedRunVersion: 0,
        serverTime: firstLeaseExpiry,
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseLaterResumeRequired',
      expiredAt: firstLeaseExpiry,
    });
  });

  it('does not commit a first lease whose request-time expiry passed before Mongo write', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    await commitRun(run);
    const requestedAt = new Date(Date.now() - 50_000).toISOString();

    await expect(
      runs.acquire({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 0,
        serverTime: requestedAt,
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseLaterResumeRequired',
      expiredAt: new Date(Date.parse(requestedAt) + 45_000).toISOString(),
    });
    const persisted = await database
      .collection<RunDocument>(runsCollectionName)
      .findOne({ _id: run.binding.runId });
    expect(persisted?.runVersion).toBe(0);
    expect(persisted?.lease).toEqual({ kind: 'Unassigned' });
  });

  it('does not reconcile an exact first lease retry after its stored expiry', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    await commitRun(run);
    const requestedAt = new Date(Date.now() - 50_000).toISOString();
    const acquired = acquireFirstRunLease(run, {
      incarnationId,
      expectedRunVersion: 0,
      serverTime: requestedAt,
    });
    if (acquired.kind !== 'Acquired') throw new Error('Expected acquired fixture');
    if (acquired.run.lease.kind !== 'Held') throw new Error('Expected held lease fixture');
    const replaced = await database
      .collection<RunDocument>(runsCollectionName)
      .replaceOne(
        { _id: run.binding.runId, runVersion: 0 },
        encodeRunDocument(acquired.run, runFingerprint),
      );
    expect(replaced.modifiedCount).toBe(1);

    await expect(
      runs.acquire({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 0,
        serverTime: requestedAt,
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseLaterResumeRequired',
      expiredAt: acquired.run.lease.expiresAt,
    });
    const persisted = await database
      .collection<RunDocument>(runsCollectionName)
      .findOne({ _id: run.binding.runId });
    expect(persisted?.runVersion).toBe(1);
  });

  it('renews the held incarnation once and reconciles an exact retry without extending twice', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    const firstLeaseAt = Date.now() - 10_000;
    const renewalAt = new Date(firstLeaseAt + 5_000).toISOString();
    const renewalRetryAt = new Date(firstLeaseAt + 6_000).toISOString();
    const renewedExpiry = new Date(firstLeaseAt + 50_000).toISOString();
    await commitRun(run);
    await runs.acquire({
      ownerAid: run.binding.ownerAid,
      runId: run.binding.runId,
      incarnationId,
      expectedRunVersion: 0,
      serverTime: new Date(firstLeaseAt).toISOString(),
    });

    await expect(
      runs.renew({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 1,
        serverTime: renewalAt,
      }),
    ).resolves.toMatchObject({
      kind: 'RunLeaseRenewed',
      run: {
        version: 2,
        lease: {
          expiresAt: renewedExpiry,
          lastChange: { kind: 'Renewed', fromRunVersion: 1 },
        },
      },
    });
    await expect(
      runs.renew({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 1,
        serverTime: renewalRetryAt,
      }),
    ).resolves.toMatchObject({
      kind: 'RunLeaseRenewalReconciled',
      run: { version: 2, lease: { expiresAt: renewedExpiry } },
    });
  });

  it('refuses a delayed renewal that arrives at Mongo after the held lease expired', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    await commitRun(run);
    const acquiredAt = new Date(Date.now() - 50_000).toISOString();
    const requestStartedAt = new Date(Date.parse(acquiredAt) + 15_000).toISOString();
    const acquired = acquireFirstRunLease(run, {
      incarnationId,
      expectedRunVersion: 0,
      serverTime: acquiredAt,
    });
    if (acquired.kind !== 'Acquired') throw new Error('Expected acquired fixture');
    const replaced = await database
      .collection<RunDocument>(runsCollectionName)
      .replaceOne(
        { _id: run.binding.runId, runVersion: 0 },
        encodeRunDocument(acquired.run, runFingerprint),
      );
    expect(replaced.modifiedCount).toBe(1);

    await expect(
      runs.renew({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 1,
        serverTime: requestStartedAt,
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseLaterResumeRequired',
      expiredAt: new Date(Date.parse(acquiredAt) + 45_000).toISOString(),
    });
    const persisted = await database
      .collection<RunDocument>(runsCollectionName)
      .findOne({ _id: run.binding.runId });
    expect(persisted?.runVersion).toBe(1);
    expect(persisted?.lease).toMatchObject({ kind: 'Held', incarnationId });
  });

  it('refuses exact renewal reconciliation after the persisted renewed lease expired', async () => {
    const harness = await admittedHarness();
    const run = proposedRun(harness, randomUUID());
    const incarnationId = randomUUID();
    await commitRun(run);
    const acquiredAt = Date.now() - 100_000;
    const renewalAt = new Date(acquiredAt + 15_000).toISOString();
    const acquired = acquireFirstRunLease(run, {
      incarnationId,
      expectedRunVersion: 0,
      serverTime: new Date(acquiredAt).toISOString(),
    });
    if (acquired.kind !== 'Acquired') throw new Error('Expected acquired fixture');
    const renewed = renewRunLease(acquired.run, {
      incarnationId,
      expectedRunVersion: 1,
      serverTime: renewalAt,
    });
    if (renewed.kind !== 'Renewed') throw new Error('Expected renewed fixture');
    if (renewed.run.lease.kind !== 'Held') throw new Error('Expected held lease fixture');
    const replaced = await database
      .collection<RunDocument>(runsCollectionName)
      .replaceOne(
        { _id: run.binding.runId, runVersion: 0 },
        encodeRunDocument(renewed.run, runFingerprint),
      );
    expect(replaced.modifiedCount).toBe(1);

    await expect(
      runs.renew({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        incarnationId,
        expectedRunVersion: 1,
        serverTime: renewalAt,
      }),
    ).resolves.toEqual({
      kind: 'RunLeaseLaterResumeRequired',
      expiredAt: renewed.run.lease.expiresAt,
    });
    const persisted = await database
      .collection<RunDocument>(runsCollectionName)
      .findOne({ _id: run.binding.runId });
    expect(persisted?.runVersion).toBe(2);
  });
});
