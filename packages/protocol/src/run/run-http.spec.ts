import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';

import { taskBudgetCeilings } from '../task/task-command.js';
import {
  decodeRunLeaseRenewalReceipt,
  decodeRunProjection,
  runConflictProblemSchema,
  runLeaseAcquisitionBodySchema,
  runLeaseProjectionSchema,
  runProjectionSchema,
  type RunProjection,
} from './run-http.js';

const said = (character: string) => `E${character.repeat(43)}`;

const projection: RunProjection = {
  version: 1,
  runId: '53980d39-2af6-470b-bd75-2c92c68da2a8',
  runVersion: 0,
  ownerAid: said('a'),
  commandId: '031634b2-7306-42e9-8922-6cfc6b359ac2',
  taskId: 'c63d3906-3ed8-450e-8410-578109363f38',
  taskRevisionSaid: said('b'),
  harnessLineageId: '972dd61b-6ff0-479a-a79a-8ad2e88582bd',
  harnessRevisionSaid: said('c'),
  personalAgentAid: said('d'),
  taskMandateSaid: said('e'),
  governorAid: said('f'),
  promotionMandateSaid: said('g'),
  purpose: { kind: 'Retained' },
  repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
  admissionExchangeSaid: said('h'),
  evidenceStreamId: 'e46740c6-ffcd-47a7-a152-875d1b34f27d',
  budget: { ceiling: taskBudgetCeilings, consumed: { ...taskBudgetCeilings, providerRequests: 0 } },
  lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
  submissionVerification: { kind: 'NotSubmitted' },
  lease: { kind: 'Unassigned' },
  activation: {
    kind: 'InitialSpecializationAccepted',
    harnessLineageId: '972dd61b-6ff0-479a-a79a-8ad2e88582bd',
    harnessRevisionSaid: said('c'),
    runId: '6ab0cff0-d4f6-41e8-855d-26a5cd9c993a',
    acceptedAt: '2026-09-24T19:00:00.000Z',
  },
  acceptedAt: '2026-09-24T20:00:00.000Z',
};

describe('Run HTTP contract', () => {
  it.each([6, 8, 9])(
    'decodes an admitted Run quota of %s only within the authorized eight-Run ceiling',
    (quota) => {
      const candidate = {
        ...projection,
        budget: {
          ...projection.budget,
          ceiling: { ...projection.budget.ceiling, runsPerAdmittedUser: quota },
        },
      };
      expect(decodeRunProjection(candidate).kind).toBe(quota <= 8 ? 'Accepted' : 'Rejected');
    },
  );

  it.each([
    {
      field: 'Run acceptance',
      invalid: { acceptedAt: '2026-09-31T20:00:00.000Z' },
    },
    {
      field: 'initial activation',
      invalid: {
        activation: { ...projection.activation, acceptedAt: '2026-09-31T19:00:00.000Z' },
        acceptedAt: '2026-10-01T20:00:00.000Z',
      },
    },
  ])('rejects an impossible calendar instant in $field', ({ invalid }) => {
    expect(decodeRunProjection({ ...projection, ...invalid })).toEqual({ kind: 'Rejected' });
  });

  it('rejects an impossible calendar instant in a no-body lease renewal receipt', () => {
    expect(
      decodeRunLeaseRenewalReceipt(projection.runId, '1f59c369-7da0-4638-a333-dd080b7eb163', {
        'x-devrandom-server-time': '2027-02-30T20:00:00.000Z',
        'x-devrandom-lease-expires-at': '2027-03-02T20:00:45.000Z',
        'x-devrandom-run-version': '1',
      }),
    ).toEqual({ kind: 'Rejected' });
  });

  it('rejects an impossible calendar instant in a persisted held Run lease', () => {
    expect(
      decodeRunProjection({
        ...projection,
        runVersion: 1,
        lease: {
          kind: 'Held',
          incarnationId: '1f59c369-7da0-4638-a333-dd080b7eb163',
          acquiredAt: '2027-02-30T20:00:00.000Z',
          expiresAt: '2027-03-02T20:00:45.000Z',
          lastChange: { kind: 'Acquired', fromRunVersion: 0 },
        },
      }),
    ).toEqual({ kind: 'Rejected' });
  });

  it('exposes actual exhausted consumption while rejecting higher authority ceilings and compatibility credit', () => {
    const exhausted = {
      ...projection,
      budget: {
        ...projection.budget,
        consumed: { ...projection.budget.consumed, providerOutputTokens: 100_001 },
      },
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'BudgetExhausted' as const,
          checkpointSaid: said('i'),
        },
      },
    };
    expect(decodeRunProjection(exhausted)).toMatchObject({ kind: 'Accepted' });
    expect(
      decodeRunProjection({
        ...exhausted,
        lifecycle: {
          ...exhausted.lifecycle,
          phase: { ...exhausted.lifecycle.phase, reason: 'HarnessCompatibilityFailure' },
        },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeRunProjection({
        ...exhausted,
        budget: {
          ...exhausted.budget,
          ceiling: { ...exhausted.budget.ceiling, providerOutputTokens: 100_001 },
        },
      }),
    ).toEqual({ kind: 'Rejected' });
  });

  it('carries the complete durable Run binding with independent state spaces', () => {
    expect(Check(runProjectionSchema, projection)).toBe(true);
    expect(
      Check(runProjectionSchema, {
        ...projection,
        lifecycle: { kind: 'Ended', outcome: { kind: 'Submitted' } },
      }),
    ).toBe(false);
  });

  it('rejects structurally valid but contradictory lifecycle and submission states', () => {
    expect(
      decodeRunProjection({
        ...projection,
        lifecycle: {
          kind: 'Ended',
          outcome: { kind: 'Submitted', checkpointSaid: said('i') },
        },
        submissionVerification: { kind: 'NotSubmitted' },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      decodeRunProjection({
        ...projection,
        submissionVerification: { kind: 'Pending' },
      }),
    ).toEqual({ kind: 'Rejected' });
  });

  it('carries calibration terminal outcomes only for calibration purpose', () => {
    const calibration = {
      ...projection,
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: '9f2cb6f3-e087-4d54-bdd7-b84dc4c7ee33',
        ordinal: 1 as const,
      },
      activation: {
        ...projection.activation,
        runId: projection.runId,
        acceptedAt: projection.acceptedAt,
      },
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationExcluded' as const,
          checkpointSaid: said('i'),
          reason: 'ProviderUnavailable' as const,
        },
      },
    };

    expect(decodeRunProjection(calibration)).toMatchObject({ kind: 'Accepted' });
    expect(
      decodeRunProjection({
        ...calibration,
        acceptedAt: '2026-09-31T20:00:00.000Z',
        activation: { ...calibration.activation, acceptedAt: '2026-09-31T20:00:00.000Z' },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(decodeRunProjection({ ...calibration, purpose: { kind: 'Retained' } })).toEqual({
      kind: 'Rejected',
    });
  });

  it('requires expected-version acquisition and exposes the server-time lease receipt', () => {
    expect(Check(runLeaseAcquisitionBodySchema, { version: 1, expectedRunVersion: 0 })).toBe(true);
    expect(Check(runLeaseAcquisitionBodySchema, { version: 1, expectedRunVersion: -1 })).toBe(
      false,
    );
    expect(
      Check(runLeaseProjectionSchema, {
        version: 1,
        disposition: 'Acquired',
        runId: projection.runId,
        incarnationId: '1f59c369-7da0-4638-a333-dd080b7eb163',
        runVersion: 1,
        serverTime: '2026-09-24T20:00:01.000Z',
        expiresAt: '2026-09-24T20:00:46.000Z',
      }),
    ).toBe(true);
  });

  it('requires the current lease owner and expiry only for a lease conflict', () => {
    const base = {
      type: 'https://devrandom.example/problems/run-conflict',
      title: 'Run command conflicts with durable state',
      status: 409,
      code: 'RunConflict',
      correlationId: 'ba955d0f-fb5b-45ef-a728-9a183efb36dc',
    } as const;
    expect(
      Check(runConflictProblemSchema, {
        ...base,
        reason: 'LeaseConflict',
        incarnationId: '1f59c369-7da0-4638-a333-dd080b7eb163',
        expiresAt: '2026-09-24T20:00:46.000Z',
        currentVersion: 1,
      }),
    ).toBe(true);
    expect(Check(runConflictProblemSchema, { ...base, reason: 'LeaseConflict' })).toBe(false);
    expect(
      Check(runConflictProblemSchema, {
        ...base,
        reason: 'CommandConflict',
        incarnationId: '1f59c369-7da0-4638-a333-dd080b7eb163',
        expiresAt: '2026-09-24T20:00:46.000Z',
        currentVersion: 1,
      }),
    ).toBe(false);
  });
});
