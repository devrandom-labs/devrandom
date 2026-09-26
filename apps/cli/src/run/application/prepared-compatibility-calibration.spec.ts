import { prepareEvidenceEvent, type EvidenceEvent } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import type { PreparedCompatibilityFailureClassification } from './prepared-compatibility.js';
import {
  PreparedCompatibilityCalibration,
  type CompatibilityCalibrationRecords,
  type PreparedCompatibilityCalibrationRecord,
} from './prepared-compatibility-calibration.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const category = {
  version: 1 as const,
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: said('t'),
  harnessRevisionSaid: said('h'),
  currentCommandSaid: said('c'),
  tamperCommandSaid: said('m'),
  legacyCommandSaid: said('l'),
  legacyObservedExitCode: 101 as const,
};

function failure(
  character: string,
): Extract<PreparedCompatibilityFailureClassification, { readonly kind: 'Confirmed' }> {
  return {
    kind: 'Confirmed',
    category,
    verifierReceiptSaids: [said(character)],
  };
}

function event(
  runId: string,
  sequence: number,
  predecessor: EvidenceEvent['predecessor'],
  producer: EvidenceEvent['producer'],
  detail: EvidenceEvent['event'],
): EvidenceEvent {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor,
    taskId: category.taskId,
    taskRevisionSaid: category.taskRevisionSaid,
    runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: category.harnessRevisionSaid,
    personalAgentAid: said('a'),
    taskMandateSaid: said('d'),
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.001Z',
    producer,
    event: detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error('evidence fixture must prepare');
  return prepared.event;
}

function realProviderProof(runId: string) {
  const attribution = {
    piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    modelTurnId: 'turn-0',
    toolCallId: 'call-0',
    proposalIndex: 0,
    tool: 'run_tests' as const,
    requiredCapability: 'RunTests' as const,
    resource: `command://cesr-current@${category.currentCommandSaid}`,
  };
  const message = event(
    runId,
    0,
    { kind: 'Genesis' },
    { kind: 'PiExecutor' },
    {
      kind: 'ModelMessageCompleted',
      piSessionId: attribution.piSessionId,
      modelTurnId: attribution.modelTurnId,
      messageArtifactSaid: said('r'),
      disposition: 'Completed',
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 800,
      },
    },
  );
  const proposal = event(
    runId,
    1,
    { kind: 'Previous', eventSaid: message.d },
    { kind: 'ToolGateway' },
    {
      kind: 'ToolProposed',
      ...attribution,
    },
  );
  const effect = event(
    runId,
    2,
    { kind: 'Previous', eventSaid: proposal.d },
    { kind: 'ToolGateway' },
    { kind: 'EffectCompleted', ...attribution, outputArtifactSaids: [said('o')] },
  );
  return { message, proposal, effect };
}

function counted(
  runId: string,
  classification: Extract<
    PreparedCompatibilityFailureClassification,
    { readonly kind: 'Confirmed' | 'NotConfirmed' }
  >,
) {
  return {
    kind: 'ClassifiedRealProviderRun' as const,
    runId,
    classification,
    providerProof: realProviderProof(runId),
  };
}

class MemoryCalibrationRecords implements CompatibilityCalibrationRecords {
  record: PreparedCompatibilityCalibrationRecord | undefined;

  load() {
    return Promise.resolve(
      this.record === undefined
        ? ({ kind: 'NotFound' } as const)
        : ({ kind: 'Loaded', record: this.record } as const),
    );
  }

  commit(expectedAttemptCount: number, record: PreparedCompatibilityCalibrationRecord) {
    if ((this.record?.attempts.length ?? 0) !== expectedAttemptCount) {
      return Promise.resolve({ kind: 'Conflict' as const });
    }
    this.record = record;
    return Promise.resolve({ kind: 'Committed' as const });
  }
}

describe('prepared compatibility calibration', () => {
  it('accepts exactly five independent attempts when four are the identical clean category', async () => {
    const records = new MemoryCalibrationRecords();
    const calibration = new PreparedCompatibilityCalibration(records);
    const runIds = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ];
    for (const [index, runId] of runIds.entries()) {
      await expect(
        calibration.record(counted(runId, failure(String.fromCharCode(97 + index)))),
      ).resolves.toMatchObject({
        kind: 'Recorded',
        disposition: { kind: 'Collecting', acceptedCleanRuns: index + 1 },
      });
    }
    await expect(
      calibration.record({
        kind: 'ExcludedRun',
        runId: '10000000-0000-4000-8000-000000000005',
        reason: 'ProviderUnavailable',
      }),
    ).resolves.toEqual({
      kind: 'Recorded',
      disposition: {
        kind: 'Calibrated',
        acceptedCleanRuns: 4,
        excludedRuns: 1,
        category,
      },
    });
    await expect(calibration.confirm(category)).resolves.toEqual({
      kind: 'Confirmed',
      acceptedCleanRuns: 4,
      excludedRuns: 1,
    });
    await expect(
      calibration.record({
        kind: 'ExcludedRun',
        runId: '10000000-0000-4000-8000-000000000006',
        reason: 'NetworkUnavailable',
      }),
    ).resolves.toEqual({ kind: 'CalibrationClosed' });
  });

  it('rejects passing or unrelated clean outcomes and never counts infrastructure', async () => {
    const records = new MemoryCalibrationRecords();
    const calibration = new PreparedCompatibilityCalibration(records);
    await expect(
      calibration.record({
        kind: 'ExcludedRun',
        runId: '20000000-0000-4000-8000-000000000001',
        reason: 'KERIAUnavailable',
      }),
    ).resolves.toMatchObject({
      kind: 'Recorded',
      disposition: { kind: 'Collecting', acceptedCleanRuns: 0, excludedRuns: 1 },
    });
    await expect(
      calibration.record(
        counted('20000000-0000-4000-8000-000000000002', {
          kind: 'NotConfirmed',
          reason: 'H1Passed',
        }),
      ),
    ).resolves.toEqual({
      kind: 'Recorded',
      disposition: { kind: 'Rejected', reason: 'H1Passed' },
    });
    await expect(
      calibration.record(counted('20000000-0000-4000-8000-000000000003', failure('q'))),
    ).resolves.toEqual({ kind: 'CalibrationClosed' });
  });

  it('rejects duplicate Runs, mismatched categories, and a sixth attempt', async () => {
    const records = new MemoryCalibrationRecords();
    const calibration = new PreparedCompatibilityCalibration(records);
    const runId = '30000000-0000-4000-8000-000000000001';
    await calibration.record(counted(runId, failure('q')));
    await expect(calibration.record(counted(runId, failure('w')))).resolves.toEqual({
      kind: 'RunAlreadyRecorded',
    });
    await expect(
      calibration.record(
        counted('30000000-0000-4000-8000-000000000002', {
          ...failure('e'),
          category: { ...category, legacyCommandSaid: said('z') },
        }),
      ),
    ).resolves.toEqual({
      kind: 'Recorded',
      disposition: { kind: 'Rejected', reason: 'CategoryChanged' },
    });
    await expect(calibration.confirm(category)).resolves.toEqual({ kind: 'NotCalibrated' });
  });
});
