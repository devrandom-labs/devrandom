import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { PreparedCompatibilityCampaignHistoryFile } from './prepared-compatibility-campaign-history.js';

const said = (value: string): string => `E${value.repeat(43)}`;
const id = (value: string): string =>
  `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const taskId = id('1');
const harnessRevisionSaid = said('h');

it('uses the private campaign index only for five exact Run IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-campaign-history-'));
  try {
    const history = new PreparedCompatibilityCampaignHistoryFile(directory);
    const input = { taskId, harnessRevisionSaid };
    expect(await history.read(input)).toEqual({ kind: 'Missing' });
    const path = join(directory, 'calibration', taskId, harnessRevisionSaid);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const category = {
      version: 1,
      taskId,
      taskRevisionSaid: said('t'),
      harnessRevisionSaid,
      currentCommandSaid: said('c'),
      tamperCommandSaid: said('d'),
      legacyCommandSaid: said('e'),
      legacyObservedExitCode: 101,
    };
    const runIds = ['2', '3', '4', '5', '6'].map(id);
    const record = {
      version: 1,
      binding: { kind: 'Bound', category },
      attempts: runIds.map((runId) => ({
        kind: 'Counted',
        runId,
        category,
        modelMessageEventSaid: said('m'),
        toolProposalEventSaid: said('p'),
        toolEffectEventSaid: said('f'),
        verifierReceiptSaids: [said('r')],
      })),
    };
    await writeFile(join(path, 'prepared-compatibility-calibration.json'), JSON.stringify(record), {
      mode: 0o600,
    });
    expect(await history.read(input)).toEqual({ kind: 'Found', runIds });
    expect(await history.read({ taskId: '../escape', harnessRevisionSaid })).toEqual({
      kind: 'Unavailable',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
