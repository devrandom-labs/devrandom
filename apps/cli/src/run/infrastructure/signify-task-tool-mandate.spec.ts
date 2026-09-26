import { describe, expect, it, vi } from 'vitest';

import type { TaskMandateInspection } from '@devrandom/domain';
import type { LocalMandateCustody } from '@devrandom/identity';
import {
  prepareTaskCommandV2,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  taskMandateV4SchemaSaid,
  taskMandateSchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';

import { harnessPersonalAgentAid } from '../../../test/baseline-harness-fixture.js';
import {
  taskSourceFixture,
  preparedRepositoryFixture,
  taskProjectionFixture,
} from '../../../test/task-source-fixture.js';
import { SignifyTaskToolMandate } from './signify-task-tool-mandate.js';

const mandateRegistryId = `E${'r'.repeat(43)}`;
const taskMandateSaid = `E${'A'.repeat(43)}`;
const attributeSaid = `E${'a'.repeat(43)}`;
const issuerEventSaid = `E${'i'.repeat(43)}`;

function inspection(
  task: TaskProjection,
  telState: TaskMandateInspection['credential']['telState'] = { kind: 'Issued' },
): TaskMandateInspection {
  return {
    credential: {
      credentialSaid: taskMandateSaid,
      attributeSaid,
      issuerAid: task.ownerAid,
      issueeAid: harnessPersonalAgentAid,
      registryId: mandateRegistryId,
      schemaSaid: taskMandateSchemaSaid,
      issuedAt: task.createdAt,
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: { kind: 'Resolved', schemaSaid: taskMandateSchemaSaid },
      telState,
      issuerAnchor: { kind: 'Anchored', eventSaid: issuerEventSaid },
    },
    authority: 'ExecutePrivateTask',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    allowedCapabilities: task.revision.requestedCapabilities,
    budgets: task.revision.budgets,
    allowedEvolutionClasses: task.revision.evolutionClasses,
    notBefore: task.createdAt,
    expiresAt: task.revision.expiresAt,
  };
}

function mandate(
  observed: TaskMandateInspection,
  now: string = '2026-09-24T20:00:00.000Z',
  task: TaskProjection = taskProjectionFixture(),
) {
  const inspectCredential = vi.fn<LocalMandateCustody['inspectCredential']>(() =>
    Promise.resolve({ kind: 'TaskMandate', value: observed }),
  );
  return {
    task,
    inspectCredential,
    mandate: new SignifyTaskToolMandate({
      task,
      personalAgentAid: harnessPersonalAgentAid,
      mandateRegistryId,
      taskMandateSaid,
      custody: { inspectCredential },
      now: () => now,
    }),
  };
}

const exactRead: Parameters<SignifyTaskToolMandate['inspect']>[0] = {
  taskRevisionSaid: taskProjectionFixture().revisionSaid,
  taskMandateSaid,
  tool: 'read_file',
  requiredCapability: 'ReadRepository',
  resource: 'repository://src/parser.ts',
};

describe('Signify current Task Mandate for the Tool Gateway', () => {
  it('rechecks KERIA and authorizes only the exact Task Revision, mandate, capability, and resource', async () => {
    const task = taskProjectionFixture();
    const current = mandate(inspection(task));

    await expect(current.mandate.inspect(exactRead)).resolves.toEqual({
      kind: 'Current',
      mandateSaid: taskMandateSaid,
      allowedCapabilities: task.revision.requestedCapabilities,
    });
    expect(current.inspectCredential).toHaveBeenCalledExactlyOnceWith({
      credentialSaid: taskMandateSaid,
    });

    await expect(
      current.mandate.inspect({ ...exactRead, taskRevisionSaid: `E${'x'.repeat(43)}` }),
    ).resolves.toMatchObject({ kind: 'Current', allowedCapabilities: [] });
    await expect(
      current.mandate.inspect({ ...exactRead, taskMandateSaid: `E${'B'.repeat(43)}` }),
    ).resolves.toMatchObject({ kind: 'Current', allowedCapabilities: [] });
    await expect(
      current.mandate.inspect({
        ...exactRead,
        requiredCapability: 'RunTests',
        resource: 'repository://src/parser.ts',
      }),
    ).resolves.toMatchObject({ kind: 'Current', allowedCapabilities: [] });
    await expect(
      current.mandate.inspect({ ...exactRead, resource: 'command://public-test@not-a-said' }),
    ).resolves.toMatchObject({ kind: 'Current', allowedCapabilities: [] });
  });

  it('distinguishes expiration and current TEL revocation', async () => {
    const task = taskProjectionFixture();
    const expired = mandate(inspection(task), task.revision.expiresAt);
    const revoked = mandate(
      inspection(task, { kind: 'Revoked', revokedAt: '2026-09-24T19:59:59.999Z' }),
    );

    await expect(expired.mandate.inspect(exactRead)).resolves.toEqual({ kind: 'Expired' });
    await expect(revoked.mandate.inspect(exactRead)).resolves.toEqual({ kind: 'Revoked' });
  });

  it('fails closed when live mandate custody is unavailable', async () => {
    const task = taskProjectionFixture();
    const unavailable = new SignifyTaskToolMandate({
      task,
      personalAgentAid: harnessPersonalAgentAid,
      mandateRegistryId,
      taskMandateSaid,
      custody: {
        inspectCredential: () => Promise.reject(new Error('KERIA unavailable')),
      },
      now: () => '2026-09-24T20:00:00.000Z',
    });

    await expect(unavailable.inspect(exactRead)).resolves.toEqual({ kind: 'Unavailable' });
  });
});

it.each([6, 8, 9])(
  'uses exact Task schema for %s Runs and rejects the other schema',
  async (quota) => {
    const source = taskSourceFixture();
    const prepared = prepareTaskCommandV2(
      {
        ...source,
        version: 2,
        budgets: { ...source.budgets, runsPerAdmittedUser: quota },
        constraints: {
          ...source.constraints,
          dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
          experience: {
            corpusSaid: `E${'c'.repeat(43)}`,
            repositoryResourceSaid: `E${'r'.repeat(43)}`,
            disclosure: 'AuthorizedAnalogy',
          },
        },
        requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
      },
      '97e16745-4b76-4de3-9ae5-a183496e73e8',
      preparedRepositoryFixture,
    );
    if (prepared.kind !== 'Prepared') throw new Error('fixture');
    const task = {
      ...taskProjectionFixture(),
      revision: prepared.command.revision,
      revisionSaid: prepared.command.revision.d,
    };
    const original = inspection(task);
    const correct =
      quota > 8
        ? taskMandateV4SchemaSaid
        : quota > 6
          ? taskMandateV3SchemaSaid
          : taskMandateV2SchemaSaid;
    const substitute =
      quota > 8
        ? taskMandateV3SchemaSaid
        : quota > 6
          ? taskMandateV2SchemaSaid
          : taskMandateV3SchemaSaid;
    for (const schemaSaid of [correct, substitute]) {
      const observed = {
        ...original,
        experience: task.revision.constraints.experience,
        credential: {
          ...original.credential,
          schemaSaid,
          schemaDocument: { kind: 'Resolved' as const, schemaSaid },
        },
      };
      const current = mandate(observed, '2026-09-24T20:00:00.000Z', task);
      const outcome = await current.mandate.inspect({
        ...exactRead,
        taskRevisionSaid: task.revisionSaid,
      });
      expect(outcome).toMatchObject(
        schemaSaid === correct
          ? {
              kind: 'Current',
              allowedCapabilities: task.revision.requestedCapabilities.filter(
                (capability) => capability !== 'ReadTaskMemory',
              ),
            }
          : { kind: 'Unavailable' },
      );
    }
  },
);
