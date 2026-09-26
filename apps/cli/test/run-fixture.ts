import { createRun } from '@devrandom/domain';
import { projectRun, taskBudgetCeilings } from '@devrandom/protocol';

import { baselineHarnessCommandFixture } from './baseline-harness-fixture.js';
import { taskProjectionFixture } from './task-source-fixture.js';

export const runCommandId = 'd2c9160a-58f8-4d43-ae67-22124c6e9112';
export const runAdmissionExchangeSaid = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const runIncarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';

export function runProjectionFixture() {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: harness.authority.personalAgentAid,
    taskMandateSaid: harness.authority.taskMandateSaid,
    governorAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    promotionMandateSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
    initialHarnessRevisionSaid: harness.d,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: harness.d,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T20:00:00.000Z',
    },
    repository: task.revision.repository,
    commandId: runCommandId,
    admissionExchangeSaid: runAdmissionExchangeSaid,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('expected valid Run fixture');
  }
  return projectRun(created.run);
}
