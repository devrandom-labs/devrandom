import { describe, expect, it, vi } from 'vitest';

import type { TaskMandateInspection } from '@devrandom/domain';
import {
  prepareTaskCommandV2,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
} from '@devrandom/protocol';
import {
  taskSourceFixture,
  preparedRepositoryFixture,
  taskProjectionFixture,
} from '../../../test/task-source-fixture.js';
import { SignifyCurrentExperienceMandate } from './signify-current-experience-mandate.js';

describe('current experience mandate', () => {
  it('denies a legacy Task before reading local credentials or contacting KERIA', async () => {
    const task = taskProjectionFixture();
    const read = vi.fn();
    const establish = vi.fn();
    const mandate = new SignifyCurrentExperienceMandate({
      task,
      user: { principal: { aid: task.ownerAid } } as never,
      records: { read },
      local: { establish },
      now: () => new Date().toISOString(),
    });
    expect(
      await mandate.inspect({
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        ownerAid: task.ownerAid,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(read).not.toHaveBeenCalled();
    expect(establish).not.toHaveBeenCalled();
  });
});

it.each([6, 8])(
  'accepts %s Run authority only under its exact experience mandate schema',
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
    const agent = `E${'a'.repeat(43)}`;
    const registry = `E${'s'.repeat(43)}`;
    const credentialSaid = `E${'A'.repeat(43)}`;
    const correct = quota > 6 ? taskMandateV3SchemaSaid : taskMandateV2SchemaSaid;
    const substitute = quota > 6 ? taskMandateV2SchemaSaid : taskMandateV3SchemaSaid;
    for (const schemaSaid of [correct, substitute]) {
      const inspected: TaskMandateInspection = {
        credential: {
          credentialSaid,
          attributeSaid: `E${'b'.repeat(43)}`,
          issuerAid: task.ownerAid,
          issueeAid: agent,
          registryId: registry,
          schemaSaid,
          issuedAt: task.createdAt,
          credentialSaidBinding: { kind: 'Verified' },
          attributeSaidBinding: { kind: 'Verified' },
          schemaDocument: { kind: 'Resolved', schemaSaid },
          telState: { kind: 'Issued' },
          issuerAnchor: { kind: 'Anchored', eventSaid: `E${'e'.repeat(43)}` },
        },
        authority: 'ExecutePrivateTask',
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        harnessLineageId: task.harnessLineageId,
        repository: task.revision.repository,
        allowedCapabilities: task.revision.requestedCapabilities,
        budgets: task.revision.budgets,
        allowedEvolutionClasses: task.revision.evolutionClasses,
        experience: task.revision.constraints.experience,
        notBefore: task.createdAt,
        expiresAt: task.revision.expiresAt,
      };
      const mandate = new SignifyCurrentExperienceMandate({
        task,
        user: { principal: { aid: task.ownerAid } } as never,
        records: {
          read: () =>
            Promise.resolve({
              binding: {
                ownerAid: task.ownerAid,
                taskId: task.taskId,
                taskRevisionSaid: task.revisionSaid,
                harnessLineageId: task.harnessLineageId,
                personalAgentAid: agent,
                mandateRegistryId: registry,
              },
              stage: { kind: 'Ready', taskMandate: { credential: { credentialSaid } } },
            } as never),
        },
        local: {
          establish: () =>
            Promise.resolve({
              kind: 'Ready',
              governance: {
                userAid: task.ownerAid,
                personalAgentAid: agent,
                mandateRegistryId: registry,
              },
              custody: {
                inspectCredential: () => Promise.resolve({ kind: 'TaskMandate', value: inspected }),
              },
            } as never),
        },
        now: () => '2026-09-24T20:00:00.000Z',
      });
      expect(
        await mandate.inspect({
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          ownerAid: task.ownerAid,
        }),
      ).toMatchObject({ kind: schemaSaid === correct ? 'Current' : 'Denied' });
    }
  },
);
