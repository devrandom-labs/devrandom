import { describe, expect, it } from 'vitest';

import { runCommandFingerprint, runFixture, runId } from '../test/run-fixture.js';
import { decodeRunDocument, encodeRunDocument } from './run-document.js';

describe('Run Mongo document', () => {
  it('round-trips the exact durable Run and command fingerprint', () => {
    const run = runFixture();
    const document = encodeRunDocument(run, runCommandFingerprint);

    expect(document).toMatchObject({
      _id: runId,
      purpose: { kind: 'Retained' },
      activeOwnerSlot: run.binding.ownerAid,
      activeGlobalSlot: 'Active',
      lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
    });
    expect(decodeRunDocument(document)).toEqual({ run, commandFingerprint: runCommandFingerprint });
  });

  it('rejects indexed metadata that diverges from the Run binding', () => {
    const document = encodeRunDocument(runFixture(), runCommandFingerprint);

    expect(() => decodeRunDocument({ ...document, activeOwnerSlot: `E${'z'.repeat(43)}` })).toThrow(
      'RunDocumentInvalid',
    );
  });

  it('releases both active slots while retaining a terminal calibration purpose', () => {
    const current = runFixture();
    const calibration = {
      ...current,
      binding: {
        ...current.binding,
        purpose: {
          kind: 'PreparedCompatibilityCalibration' as const,
          campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
          ordinal: 2 as const,
        },
      },
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationExcluded' as const,
          checkpointSaid: `E${'q'.repeat(43)}`,
          reason: 'ProviderUnavailable' as const,
        },
      },
      submissionVerification: { kind: 'Rejected' as const },
    };

    const document = encodeRunDocument(calibration, runCommandFingerprint);

    expect(document).toMatchObject({
      purpose: calibration.binding.purpose,
      lifecycle: calibration.lifecycle,
    });
    expect(document).not.toHaveProperty('activeOwnerSlot');
    expect(document).not.toHaveProperty('activeGlobalSlot');
    expect(decodeRunDocument(document)).toEqual({
      run: calibration,
      commandFingerprint: runCommandFingerprint,
    });
  });
});
