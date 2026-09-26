import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PreparedCompatibilityCalibration } from '../application/prepared-compatibility-calibration.js';
import type { PreparedCompatibilityCalibrationRecord } from '../application/prepared-compatibility-calibration.js';
import { PreparedCompatibilityCalibrationFile } from './prepared-compatibility-calibration-file.js';

const directories: string[] = [];
const said = (character: string): string => `E${character.repeat(43)}`;
const record: PreparedCompatibilityCalibrationRecord = {
  version: 1,
  binding: {
    kind: 'Bound',
    category: {
      version: 1,
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      taskRevisionSaid: said('t'),
      harnessRevisionSaid: said('h'),
      currentCommandSaid: said('c'),
      tamperCommandSaid: said('m'),
      legacyCommandSaid: said('l'),
      legacyObservedExitCode: 101,
    },
  },
  attempts: [
    {
      kind: 'Counted',
      runId: '10000000-0000-4000-8000-000000000001',
      category: {
        version: 1,
        taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        taskRevisionSaid: said('t'),
        harnessRevisionSaid: said('h'),
        currentCommandSaid: said('c'),
        tamperCommandSaid: said('m'),
        legacyCommandSaid: said('l'),
        legacyObservedExitCode: 101,
      },
      modelMessageEventSaid: said('a'),
      toolProposalEventSaid: said('b'),
      toolEffectEventSaid: said('e'),
      verifierReceiptSaids: [said('v')],
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('prepared compatibility calibration file', () => {
  it('retains a bounded closed record across fresh processes with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-calibration-'));
    directories.push(directory);
    const file = new PreparedCompatibilityCalibrationFile(directory);

    await expect(file.load()).resolves.toEqual({ kind: 'NotFound' });
    await expect(file.commit(0, record)).resolves.toEqual({ kind: 'Committed' });
    await expect(new PreparedCompatibilityCalibrationFile(directory).load()).resolves.toEqual({
      kind: 'Loaded',
      record,
    });
    await expect(file.commit(0, record)).resolves.toEqual({ kind: 'Conflict' });

    const path = join(directory, 'prepared-compatibility-calibration.json');
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
  });

  it('refuses an unbounded or malformed retained record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-calibration-'));
    directories.push(directory);
    const file = new PreparedCompatibilityCalibrationFile(directory);
    const counted = record.attempts[0];
    if (counted === undefined)
      throw new Error('calibration record fixture must contain an attempt');
    const unbounded = { ...record, attempts: Array.from({ length: 6 }, () => counted) };

    await expect(file.commit(0, unbounded)).resolves.toEqual({ kind: 'Unavailable' });
  });

  it('assesses a second infrastructure exclusion after the first is durably recorded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-calibration-'));
    directories.push(directory);
    const calibration = new PreparedCompatibilityCalibration(
      new PreparedCompatibilityCalibrationFile(directory),
    );
    const first = {
      kind: 'ExcludedRun' as const,
      runId: '10000000-0000-4000-8000-000000000001',
      reason: 'BudgetExhausted' as const,
    };
    const second = {
      kind: 'ExcludedRun' as const,
      runId: '10000000-0000-4000-8000-000000000002',
      reason: 'ModelUsageUnavailable' as const,
    };

    await expect(calibration.record(first)).resolves.toMatchObject({ kind: 'Recorded' });
    await expect(
      new PreparedCompatibilityCalibration(
        new PreparedCompatibilityCalibrationFile(directory),
      ).assess(second),
    ).resolves.toEqual({
      kind: 'Accepted',
      disposition: { kind: 'Excluded', reason: 'ModelUsageUnavailable' },
    });
  });
});
