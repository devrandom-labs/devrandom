import { describe, expect, it } from 'vitest';

import { runIndexDefinitions, runIndexNames } from './mongo-runs.js';

describe('Mongo Run index contract', () => {
  it('owns separate calibration, retained, and active concurrency identities', () => {
    expect(runIndexDefinitions).toEqual([
      {
        name: runIndexNames.ownerCommand,
        key: { ownerAid: 1, commandId: 1 },
        unique: true,
      },
      {
        name: runIndexNames.calibrationPurpose,
        key: {
          taskId: 1,
          taskRevisionSaid: 1,
          'purpose.campaignId': 1,
          'purpose.ordinal': 1,
        },
        unique: true,
        partialFilterExpression: {
          'purpose.kind': 'PreparedCompatibilityCalibration',
        },
      },
      {
        name: runIndexNames.retainedPurpose,
        key: { taskId: 1, taskRevisionSaid: 1 },
        unique: true,
        partialFilterExpression: { 'purpose.kind': 'Retained' },
      },
      {
        name: runIndexNames.activeOwner,
        key: { activeOwnerSlot: 1 },
        unique: true,
        partialFilterExpression: { activeOwnerSlot: { $exists: true } },
      },
      {
        name: runIndexNames.activeGlobal,
        key: { activeGlobalSlot: 1 },
        unique: true,
        partialFilterExpression: { activeGlobalSlot: { $exists: true } },
      },
    ]);
  });
});
