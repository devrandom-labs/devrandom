import { createServer } from 'node:http';

import { createRun } from '@devrandom/domain';
import {
  governorAid,
  issuerAid,
  personalAgentAid,
  type LocalRunAdmissionExchange,
} from '@devrandom/identity';
import { projectRun, taskBudgetCeilings } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerRunHttp } from '../infrastructure/server-run-http.js';
import {
  BaselineRunAdmission,
  type BaselineRunAdmissionRecords,
  type BaselineRunAdmissionInput,
  type HostedRuns,
  type StableBaselineRunAdmission,
} from './baseline-run-admission.js';

const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const issuer = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');
const exchangeSaid = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const commandId = 'd2c9160a-58f8-4d43-ae67-22124c6e9112';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const acceptedAt = '2026-09-24T20:00:00.000Z';

function acceptedRun() {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: personalAgent,
    taskMandateSaid: harness.authority.taskMandateSaid,
    governorAid: governor,
    promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
    initialHarnessRevisionSaid: harness.d,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: harness.d,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt,
    },
    repository: task.revision.repository,
    commandId,
    admissionExchangeSaid: exchangeSaid,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt,
  });
  if (created.kind !== 'Created') {
    throw new Error('expected Run fixture');
  }
  return projectRun(created.run);
}

function records(): BaselineRunAdmissionRecords {
  let record: StableBaselineRunAdmission | undefined;
  return {
    acquire: (binding, candidate) => {
      if (record !== undefined) {
        return Promise.resolve({ kind: 'Acquired', provenance: 'Recovered', admission: record });
      }
      record = { version: 1, kind: 'PreparingExchange', binding, ...candidate };
      return Promise.resolve({ kind: 'Acquired', provenance: 'Created', admission: record });
    },
    recordExchange: (_binding, prepared) => {
      if (record === undefined || record.kind !== 'PreparingExchange') {
        return Promise.resolve({ kind: 'Conflict' });
      }
      record = { ...record, kind: 'ExchangePrepared', exchangeSaid: prepared.exchangeSaid };
      return Promise.resolve({ kind: 'Acknowledged', admission: record });
    },
    recordRun: (_binding, disposition, projection) => {
      if (record === undefined || record.kind !== 'ExchangePrepared') {
        return Promise.resolve({ kind: 'Conflict' });
      }
      record = { ...record, kind: 'RunAccepted', runAdmission: disposition, run: projection };
      return Promise.resolve({ kind: 'Acknowledged', admission: record });
    },
    recordLease: (_binding, projection) => {
      if (record === undefined || record.kind !== 'RunAccepted') {
        return Promise.resolve({ kind: 'Conflict' });
      }
      record = { ...record, kind: 'LeaseAccepted', lease: projection };
      return Promise.resolve({ kind: 'Acknowledged', admission: record });
    },
  };
}

function hosted(run = acceptedRun()): HostedRuns {
  return {
    admit: () => Promise.resolve({ kind: 'Created', projection: run }),
    acquireLease: (_runId, requestedIncarnationId) =>
      Promise.resolve({
        kind: 'Acquired',
        projection: {
          version: 1,
          disposition: 'Acquired',
          runId: run.runId,
          incarnationId: requestedIncarnationId,
          runVersion: 1,
          serverTime: acceptedAt,
          expiresAt: '2026-09-24T20:00:45.000Z',
        },
      }),
    renewLease: () => Promise.reject(new Error('not used during admission')),
  };
}

function exchange(): LocalRunAdmissionExchange {
  return {
    prepare: () => Promise.resolve({ exchangeSaid }),
    deliver: () => Promise.resolve({ exchangeSaid }),
  };
}

function admissionInput(server: HostedRuns): BaselineRunAdmissionInput {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture();
  return {
    task,
    harness: {
      version: 1,
      ownerAid: task.ownerAid,
      commandId: harness.commandId,
      acceptedAt,
      revision: harness.revision,
    },
    personalAgentAid: personalAgent,
    governorAid: governor,
    promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
    purpose: { kind: 'Retained' },
    requestedBudget: taskBudgetCeilings,
    exchange: exchange(),
    hosted: server,
  };
}

describe('baseline Run admission', () => {
  it('reconciles one first lease through the HTTP adapter after its committed response is lost', async () => {
    const run = acceptedRun();
    const requests: { readonly path: string | undefined; readonly body: string }[] = [];
    const lease = {
      version: 1 as const,
      disposition: 'Acquired' as const,
      runId: run.runId,
      incarnationId,
      runVersion: 1,
      serverTime: acceptedAt,
      expiresAt: '2026-09-24T20:00:45.000Z',
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ path: request.url, body: Buffer.concat(chunks).toString('utf8') });
        if (requests.length === 1) {
          response.writeHead(201, {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          });
          response.end(JSON.stringify(run));
        } else if (requests.length === 2) {
          request.socket.destroy();
        } else {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          });
          response.end(JSON.stringify(lease));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected HTTP address');
      const origin = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
      if (origin.kind !== 'Accepted') throw new Error('Expected loopback origin');
      let monotonic = 100;
      const outcome = await new BaselineRunAdmission({
        records: records(),
        issuerAid: issuer,
        newCommandId: () => commandId,
        newIncarnationId: () => incarnationId,
        now: () => Date.parse(acceptedAt),
        monotonicNow: () => monotonic,
        wait: (milliseconds) => {
          monotonic += milliseconds;
          return Promise.resolve();
        },
        maximumObservations: 3,
      }).admit(
        admissionInput(
          new ServerRunHttp(origin.origin, 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s', fetch),
        ),
      );
      expect(outcome).toMatchObject({
        kind: 'RunLeaseAcquired',
        leaseRequestStartedAt: 100,
        run: { runId: run.runId },
        lease,
      });
      expect(requests).toEqual([
        {
          path: '/api/runs',
          body: JSON.stringify({
            version: 1,
            commandId,
            admissionExchangeSaid: exchangeSaid,
          }),
        },
        {
          path: `/api/runs/${run.runId}/incarnations/${incarnationId}`,
          body: JSON.stringify({ version: 1, expectedRunVersion: 0 }),
        },
        {
          path: `/api/runs/${run.runId}/incarnations/${incarnationId}`,
          body: JSON.stringify({ version: 1, expectedRunVersion: 0 }),
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });

  it('retries an uncertain first lease response in one admission without renewing its request age', async () => {
    const server = hosted();
    const first = await server.acquireLease(acceptedRun().runId, incarnationId, {
      version: 1,
      expectedRunVersion: 0,
    });
    if (first.kind !== 'Acquired') throw new Error('Expected acquired lease fixture');
    const acquireLease = vi
      .fn<HostedRuns['acquireLease']>()
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValue({ kind: 'Reconciled', projection: first.projection });
    let monotonic = 100;
    const wait = vi.fn((milliseconds: number) => {
      monotonic += milliseconds;
      return Promise.resolve();
    });
    const outcome = await new BaselineRunAdmission({
      records: records(),
      issuerAid: issuer,
      newCommandId: () => commandId,
      newIncarnationId: () => incarnationId,
      now: () => Date.parse(acceptedAt),
      monotonicNow: () => monotonic,
      wait,
      maximumObservations: 3,
    }).admit(admissionInput({ ...server, acquireLease }));

    expect(outcome).toMatchObject({
      kind: 'RunLeaseAcquired',
      leaseRequestStartedAt: 100,
      lease: first.projection,
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(acquireLease).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost first lease response only in its originating process and preserves request age', async () => {
    const retained = records();
    let monotonic = 100;
    const dependencies = {
      records: retained,
      issuerAid: issuer,
      newCommandId: () => commandId,
      newIncarnationId: () => incarnationId,
      now: () => Date.parse(acceptedAt),
      monotonicNow: () => monotonic,
      wait: () => Promise.resolve(),
      maximumObservations: 3,
    };
    const server = hosted();
    const first = await server.acquireLease(acceptedRun().runId, incarnationId, {
      version: 1,
      expectedRunVersion: 0,
    });
    if (first.kind !== 'Acquired') throw new Error('Expected acquired lease fixture');
    const acquireLease = vi
      .fn<HostedRuns['acquireLease']>()
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValue({ kind: 'Reconciled', projection: first.projection });
    const input = admissionInput({ ...server, acquireLease });
    const origin = new BaselineRunAdmission(dependencies);

    expect(await origin.admit(input)).toEqual({
      kind: 'RunLeaseRejected',
      outcome: { kind: 'ServerUnavailable' },
    });
    monotonic = 20_100;
    expect(await new BaselineRunAdmission(dependencies).admit(input)).toEqual({
      kind: 'RunResumeRequired',
    });
    monotonic = 30_100;
    expect(await origin.admit(input)).toMatchObject({
      kind: 'RunLeaseAcquired',
      leaseRequestStartedAt: 100,
      lease: first.projection,
    });
    expect(acquireLease).toHaveBeenCalledTimes(4);
    expect(await origin.admit(input)).toMatchObject({
      kind: 'RunLeaseAcquired',
      leaseRequestStartedAt: 100,
      lease: first.projection,
    });
    expect(acquireLease).toHaveBeenCalledTimes(4);
  });

  it('refuses a first lease from a recovered RunAccepted record when the new process would acquire it', async () => {
    const retained = records();
    const dependencies = {
      records: retained,
      issuerAid: issuer,
      newCommandId: () => commandId,
      newIncarnationId: () => incarnationId,
      now: () => Date.parse(acceptedAt),
      monotonicNow: () => 100,
      wait: () => Promise.resolve(),
      maximumObservations: 3,
    };
    const server = hosted();
    const acquireLease = vi
      .fn<HostedRuns['acquireLease']>()
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockResolvedValueOnce({ kind: 'ServerUnavailable' })
      .mockImplementation((...input) => server.acquireLease(...input));
    const input = admissionInput({ ...server, acquireLease });

    expect(await new BaselineRunAdmission(dependencies).admit(input)).toEqual({
      kind: 'RunLeaseRejected',
      outcome: { kind: 'ServerUnavailable' },
    });
    expect(await new BaselineRunAdmission(dependencies).admit(input)).toEqual({
      kind: 'RunResumeRequired',
    });
    expect(acquireLease).toHaveBeenCalledTimes(3);
  });

  it('preserves live acquisition timing on retry and refuses replay in a new admission owner', async () => {
    const retained = records();
    let monotonic = 100;
    const dependencies = {
      records: retained,
      issuerAid: issuer,
      newCommandId: () => commandId,
      newIncarnationId: () => incarnationId,
      now: () => Date.parse(acceptedAt),
      monotonicNow: () => monotonic,
      wait: () => Promise.resolve(),
      maximumObservations: 3,
    };
    const server = hosted();
    const acquireLease = vi.fn<HostedRuns['acquireLease']>(async (...input) => {
      monotonic = 20_100;
      return server.acquireLease(...input);
    });
    const input: BaselineRunAdmissionInput = {
      task: taskProjectionFixture(),
      harness: {
        version: 1,
        ownerAid: taskProjectionFixture().ownerAid,
        commandId: baselineHarnessCommandFixture().commandId,
        acceptedAt,
        revision: baselineHarnessCommandFixture().revision,
      },
      personalAgentAid: personalAgent,
      governorAid: governor,
      promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      purpose: { kind: 'Retained' },
      requestedBudget: taskBudgetCeilings,
      exchange: exchange(),
      hosted: { ...server, acquireLease },
    };
    const admission = new BaselineRunAdmission(dependencies);
    const acquired = await admission.admit(input);
    expect(acquired).toMatchObject({ kind: 'RunLeaseAcquired', leaseRequestStartedAt: 100 });
    monotonic = 30_100;
    expect(await admission.admit(input)).toEqual(acquired);
    expect(acquireLease).toHaveBeenCalledOnce();
    expect(await new BaselineRunAdmission(dependencies).admit(input)).toEqual({
      kind: 'RunResumeRequired',
    });
    expect(acquireLease).toHaveBeenCalledOnce();
  });

  it('retains the signed command before admission and acquires no lease before the durable Run receipt', async () => {
    const order: string[] = [];
    const signing = exchange();
    const prepare = vi.fn<LocalRunAdmissionExchange['prepare']>((input) => {
      order.push('prepare-exchange');
      return signing.prepare(input);
    });
    const deliver = vi.fn<LocalRunAdmissionExchange['deliver']>((input) => {
      order.push('deliver-exchange');
      return signing.deliver(input);
    });
    const server = hosted();
    const admit = vi.fn<HostedRuns['admit']>((input) => {
      order.push('admit-run');
      return server.admit(input);
    });
    const acquireLease = vi.fn<HostedRuns['acquireLease']>((...input) => {
      order.push('acquire-lease');
      return server.acquireLease(...input);
    });
    const renewLease = vi.fn<HostedRuns['renewLease']>((...input) => server.renewLease(...input));
    const harness = baselineHarnessCommandFixture().revision;

    const outcome = await new BaselineRunAdmission({
      records: records(),
      issuerAid: issuer,
      newCommandId: () => commandId,
      newIncarnationId: () => incarnationId,
      now: () => Date.parse(acceptedAt),
      monotonicNow: () => 0,
      wait: () => Promise.resolve(),
      maximumObservations: 3,
    }).admit({
      task: taskProjectionFixture(),
      harness: {
        version: 1,
        ownerAid: taskProjectionFixture().ownerAid,
        commandId: baselineHarnessCommandFixture().commandId,
        acceptedAt: '2026-09-24T19:00:00.000Z',
        revision: harness,
      },
      personalAgentAid: personalAgent,
      governorAid: governor,
      promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      purpose: { kind: 'Retained' },
      requestedBudget: taskBudgetCeilings,
      exchange: { prepare, deliver },
      hosted: { admit, acquireLease, renewLease },
    });

    expect(outcome).toMatchObject({
      kind: 'RunLeaseAcquired',
      admission: 'Created',
      run: { lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } } },
      lease: {
        disposition: 'Acquired',
        incarnationId,
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
    });
    expect(order).toEqual(['prepare-exchange', 'deliver-exchange', 'admit-run', 'acquire-lease']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      senderAlias: 'devrandom-personal-agent',
      sourceAid: personalAgent,
      recipientAid: issuer,
      preparedAt: Date.parse(acceptedAt),
      payload: { purpose: { kind: 'Retained' } },
    });
    expect(admit).toHaveBeenCalledWith({
      version: 1,
      commandId,
      admissionExchangeSaid: exchangeSaid,
    });
    expect(acquireLease).toHaveBeenCalledWith(acceptedRun().runId, incarnationId, {
      version: 1,
      expectedRunVersion: 0,
    });
  });

  it('stops with a bounded pending outcome instead of inventing a Run', async () => {
    const pendingServer: HostedRuns = {
      admit: () =>
        Promise.resolve({
          kind: 'Pending',
          projection: {
            version: 1,
            disposition: 'RunAdmissionExchangePending',
            commandId,
            admissionExchangeSaid: exchangeSaid,
          },
        }),
      acquireLease: () => Promise.reject(new Error('must not acquire before Run acceptance')),
      renewLease: () => Promise.reject(new Error('must not renew before Run acceptance')),
    };
    const harness = baselineHarnessCommandFixture().revision;

    await expect(
      new BaselineRunAdmission({
        records: records(),
        issuerAid: issuer,
        newCommandId: () => commandId,
        newIncarnationId: () => incarnationId,
        now: () => Date.parse(acceptedAt),
        monotonicNow: () => 0,
        wait: () => Promise.resolve(),
        maximumObservations: 2,
      }).admit({
        task: taskProjectionFixture(),
        harness: {
          version: 1,
          ownerAid: taskProjectionFixture().ownerAid,
          commandId: baselineHarnessCommandFixture().commandId,
          acceptedAt: '2026-09-24T19:00:00.000Z',
          revision: harness,
        },
        personalAgentAid: personalAgent,
        governorAid: governor,
        promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
        purpose: { kind: 'Retained' },
        requestedBudget: taskBudgetCeilings,
        exchange: exchange(),
        hosted: pendingServer,
      }),
    ).resolves.toEqual({ kind: 'RunAdmissionPendingLimitReached' });
  });
});
