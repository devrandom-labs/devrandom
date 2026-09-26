import type { Db } from 'mongodb';
import { expect, it } from 'vitest';

import { openServerAtlasExperience } from './server-atlas-experience.js';

it('keeps Experience source admission and readiness unavailable without server Atlas custody', async () => {
  const composition = await openServerAtlasExperience({ kind: 'Disabled' }, {} as Db);
  expect(composition.kind).toBe('Unavailable');
  expect(
    await composition.sources.admitSource(
      {} as Parameters<typeof composition.sources.admitSource>[0],
    ),
  ).toBe('Unavailable');
  await expect(composition.verify()).rejects.toThrow('Atlas Experience is unavailable');
  await expect(composition.close()).resolves.toBeUndefined();
});
