import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileCalibrationCampaignRecords } from './file-calibration-campaign-records.js';
import { PreparedCompatibilityCalibrationFile } from './prepared-compatibility-calibration-file.js';

it('reads the exact Task/H1 local settlement index and rejects path escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-campaign-records-'));
  try {
    const taskId = '11111111-1111-4111-8111-111111111111';
    const harness = `E${'h'.repeat(43)}`;
    const reader = new FileCalibrationCampaignRecords(root);
    expect(await reader.read(taskId, harness)).toEqual({ kind: 'NotFound' });
    const record = {
      version: 1 as const,
      binding: { kind: 'AwaitingConfirmedCategory' as const },
      attempts: [
        {
          kind: 'Excluded' as const,
          runId: '22222222-2222-4222-8222-222222222222',
          reason: 'BudgetExhausted' as const,
        },
      ],
    };
    expect(
      await new PreparedCompatibilityCalibrationFile(
        join(root, 'calibration', taskId, harness),
      ).commit(0, record),
    ).toEqual({ kind: 'Committed' });
    expect(await reader.read(taskId, harness)).toEqual({ kind: 'Loaded', record });
    expect(await reader.read('../outside', harness)).toEqual({ kind: 'Corrupt' });
    expect(await reader.read(taskId, '../outside')).toEqual({ kind: 'Corrupt' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
