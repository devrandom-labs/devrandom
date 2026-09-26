import { describe, expect, it, vi } from 'vitest';

import { issuerAid } from '@devrandom/identity';
import { decodeRunProjection } from '@devrandom/protocol';
import { RunSupervisor, type RunSupervision } from '@devrandom/runtime';

import { runWorkAccessFixture } from '../../../test/run-work-access-fixture.js';
import { runIncarnationId, runProjectionFixture } from '../../../test/run-fixture.js';
import type { AdmittedTaskRunPreparation } from '../../task/application/task-run-execution.js';
import type { RunWorkAccessRenewal } from '../../work-access/application/run-work-access.js';
import { BaselineRunSupervisorComposition } from './baseline-run-supervisor.js';

describe('Baseline Run supervision composition', () => {
  it('joins cancelled grant maintenance after supervision has settled', async () => {
    const acquireStarted = Promise.withResolvers<AbortSignal>();
    const pendingAcquire =
      Promise.withResolvers<Awaited<ReturnType<RunWorkAccessRenewal['acquire']>>>();
    const renewal: RunWorkAccessRenewal = {
      ...runWorkAccessFixture({ deadline: 0 }),
      acquire: (signal) => {
        acquireStarted.resolve(signal);
        return pendingAcquire.promise;
      },
    };
    const preparation = { workAccessRenewal: renewal } as unknown as AdmittedTaskRunPreparation;
    const projection = runProjectionFixture();
    const decoded = decodeRunProjection(projection);
    if (decoded.kind !== 'Accepted') throw new Error('Run fixture must decode');
    const settled = Promise.withResolvers<RunSupervision>();
    const supervisor = vi
      .spyOn(RunSupervisor.prototype, 'supervise')
      .mockImplementation(() => settled.promise);
    const composition = new BaselineRunSupervisorComposition({
      stateRoot: '/unused',
      repositoryDirectory: '/unused',
      issuerAid: issuerAid('EG76ndMe6q4waBwXj4yMFHp_3MWF_YhoT9Ce98xxSVDj'),
      modelCredential: { acquire: () => Promise.reject(new Error('not used')) },
      childEnvironment: { path: '/usr/bin', language: 'C' },
      now: () => '2026-09-24T20:00:00.000Z',
      sessionId: () => crypto.randomUUID(),
      modelTurnId: () => crypto.randomUUID(),
      wait: () => Promise.resolve(),
    });
    const supervision = composition.provision(preparation).supervise(
      decoded.run,
      {
        runId: projection.runId,
        incarnationId: runIncarnationId,
        runVersion: projection.runVersion + 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
      new AbortController().signal,
      performance.now(),
    );
    try {
      const signal = await acquireStarted.promise;
      settled.resolve({ kind: 'SupervisorIntegrityFailure' });
      const outcome = await Promise.race([
        supervision,
        new Promise<'StillWaiting'>((resolve) => {
          setTimeout(() => {
            resolve('StillWaiting');
          }, 100);
        }),
      ]);
      expect(signal.aborted).toBe(true);
      expect(outcome).toEqual({ kind: 'SupervisorIntegrityFailure' });
    } finally {
      pendingAcquire.resolve({ kind: 'Unavailable' });
      await supervision;
      supervisor.mockRestore();
    }
  });
});
