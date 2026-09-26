import { createRun } from '@devrandom/domain';
import { taskBudgetCeilings } from '@devrandom/protocol';

export const runOwnerAid = `E${'a'.repeat(43)}`;
export const runCommandId = 'd2c9160a-58f8-4d43-ae67-22124c6e9112';
export const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
export const runHarnessSaid = `E${'b'.repeat(43)}`;
export const runCommandFingerprint = `sha256:${'c'.repeat(64)}`;

export function runFixture() {
  const created = createRun({
    runId,
    ownerAid: runOwnerAid,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: `E${'d'.repeat(43)}`,
    harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
    personalAgentAid: `E${'e'.repeat(43)}`,
    taskMandateSaid: `E${'f'.repeat(43)}`,
    governorAid: `E${'g'.repeat(43)}`,
    promotionMandateSaid: `E${'h'.repeat(43)}`,
    initialHarnessRevisionSaid: runHarnessSaid,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
      harnessRevisionSaid: runHarnessSaid,
      runId: 'ff6774df-9797-4295-8e74-a974819babec',
      acceptedAt: '2026-09-24T19:55:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: runCommandId,
    admissionExchangeSaid: `E${'i'.repeat(43)}`,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('expected a valid Run fixture');
  }
  return created.run;
}
