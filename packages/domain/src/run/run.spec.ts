import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import { createRun, effectiveRunBudget, runStateIsCoherent } from './run.js';

const effective = effectiveRunBudget({
  requested: { ...taskBudgetCeilings, providerRequests: 20, toolProposals: 40 },
  task: { ...taskBudgetCeilings, providerRequests: 10 },
  server: { ...taskBudgetCeilings, providerRequests: 30, toolProposals: 25 },
  mandate: { ...taskBudgetCeilings, providerRequests: 15, toolProposals: 30 },
});

describe('Run inception', () => {
  it('reserves exactly five calibration Runs plus one retained Run per admitted user', () => {
    expect(taskBudgetCeilings.runsPerAdmittedUser).toBe(6);
    expect(taskBudgetCeilings.hostedWorkRunsGlobally).toBe(21);
  });

  it('intersects every authority ceiling and starts only Active.Preparing', () => {
    expect(effective.providerRequests).toBe(10);
    expect(effective.toolProposals).toBe(25);

    const created = createRun({
      runId: 'run-1',
      ownerAid: 'EUser',
      taskId: 'task-1',
      taskRevisionSaid: 'ETask',
      harnessLineageId: 'lineage-1',
      personalAgentAid: 'EAgent',
      taskMandateSaid: 'ETaskMandate',
      governorAid: 'EGovernor',
      promotionMandateSaid: 'EPromotionMandate',
      initialHarnessRevisionSaid: 'EHarness',
      purpose: { kind: 'Retained' },
      initialSpecialization: {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId: 'lineage-1',
        harnessRevisionSaid: 'EHarness',
        runId: 'calibration-run-1',
        acceptedAt: '2026-09-24T19:00:00.000Z',
      },
      repository: { objectFormat: 'sha1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      commandId: 'command-1',
      admissionExchangeSaid: 'EAdmission',
      evidenceStreamId: 'stream-1',
      budget: effective,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });

    expect(created).toMatchObject({
      kind: 'Created',
      run: {
        version: 0,
        lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
        submissionVerification: { kind: 'NotSubmitted' },
        lease: { kind: 'Unassigned' },
      },
    });
  });

  it('rejects aliased user, personal-agent, and Governor principals', () => {
    expect(
      createRun({
        runId: 'run-1',
        ownerAid: 'EAgent',
        taskId: 'task-1',
        taskRevisionSaid: 'ETask',
        harnessLineageId: 'lineage-1',
        personalAgentAid: 'EAgent',
        taskMandateSaid: 'ETaskMandate',
        governorAid: 'EGovernor',
        promotionMandateSaid: 'EPromotionMandate',
        initialHarnessRevisionSaid: 'EHarness',
        purpose: { kind: 'Retained' },
        initialSpecialization: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId: 'lineage-1',
          harnessRevisionSaid: 'EHarness',
          runId: 'calibration-run-1',
          acceptedAt: '2026-09-24T19:00:00.000Z',
        },
        repository: { objectFormat: 'sha1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
        commandId: 'command-1',
        admissionExchangeSaid: 'EAdmission',
        evidenceStreamId: 'stream-1',
        budget: effective,
        acceptedAt: '2026-09-24T20:00:00.000Z',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'PrincipalConflict' });
  });

  it('binds each Run to one closed purpose and the exact active initial specialization', () => {
    const created = createRun({
      runId: 'run-1',
      ownerAid: 'EUser',
      taskId: 'task-1',
      taskRevisionSaid: 'ETask',
      harnessLineageId: 'lineage-1',
      personalAgentAid: 'EAgent',
      taskMandateSaid: 'ETaskMandate',
      governorAid: 'EGovernor',
      promotionMandateSaid: 'EPromotionMandate',
      initialHarnessRevisionSaid: 'EHarness',
      purpose: {
        kind: 'PreparedCompatibilityCalibration',
        campaignId: 'campaign-1',
        ordinal: 1,
      },
      initialSpecialization: {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId: 'lineage-1',
        harnessRevisionSaid: 'EHarness',
        runId: 'run-1',
        acceptedAt: '2026-09-24T20:00:00.000Z',
      },
      repository: { objectFormat: 'sha1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      commandId: 'command-1',
      admissionExchangeSaid: 'EAdmission',
      evidenceStreamId: 'stream-1',
      budget: effective,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });

    expect(created).toMatchObject({
      kind: 'Created',
      run: {
        binding: {
          purpose: {
            kind: 'PreparedCompatibilityCalibration',
            campaignId: 'campaign-1',
            ordinal: 1,
          },
          initialSpecialization: { runId: 'run-1', harnessRevisionSaid: 'EHarness' },
        },
      },
    });
  });

  it('keeps calibration terminal outcomes coherent with their verifier disposition', () => {
    const checkpointSaid = 'ECheckpoint';

    expect(
      runStateIsCoherent({
        lifecycle: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationExcluded', checkpointSaid, reason: 'ProviderUnavailable' },
        },
        submissionVerification: { kind: 'Pending' },
      }),
    ).toBe(false);
    expect(
      runStateIsCoherent({
        lifecycle: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationRejected', checkpointSaid, reason: 'H1Passed' },
        },
        submissionVerification: { kind: 'Accepted' },
      }),
    ).toBe(true);
  });
});
