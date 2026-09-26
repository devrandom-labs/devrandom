import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { PreparedCompatibilityCampaignFile } from './prepared-compatibility-campaign-file.js';

describe('prepared compatibility campaign file', () => {
  it('recovers one private stable campaign identity only for the exact Task label', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-campaign-'));
    const first = new PreparedCompatibilityCampaignFile(
      directory,
      () => '2ae44718-f146-47fc-8507-14b75fd7fa98',
    );

    await expect(first.acquire('repair-parser')).resolves.toEqual({
      kind: 'Acquired',
      campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98',
    });
    await expect(
      new PreparedCompatibilityCampaignFile(directory, () => crypto.randomUUID()).acquire(
        'repair-parser',
      ),
    ).resolves.toEqual({
      kind: 'Acquired',
      campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98',
    });
    await expect(first.acquire('other-task')).resolves.toEqual({ kind: 'BindingConflict' });
    expect(JSON.parse(await readFile(join(directory, 'campaign.json'), 'utf8'))).toEqual({
      version: 1,
      taskLabel: 'repair-parser',
      campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98',
    });
  });
});
