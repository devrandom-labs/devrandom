import { describe, expect, it, vi } from 'vitest';

import { projectRun } from '@devrandom/protocol';

import { runFixture } from '../test/run-fixture.js';
import { inspectRun } from './inspect-run.js';

describe('inspect Run', () => {
  it('projects the owner-scoped repository Run without alternate query authority', async () => {
    const run = runFixture();
    const findById = vi.fn().mockResolvedValue({ kind: 'RunFound', run });

    await expect(
      inspectRun({ ownerAid: run.binding.ownerAid, runId: run.binding.runId }, { findById }),
    ).resolves.toEqual({ kind: 'RunFound', projection: projectRun(run) });
    expect(findById).toHaveBeenCalledExactlyOnceWith(run.binding.ownerAid, run.binding.runId);
  });

  it('keeps an absent or differently owned Run indistinguishable', async () => {
    await expect(
      inspectRun(
        { ownerAid: `E${'z'.repeat(43)}`, runId: runFixture().binding.runId },
        { findById: () => Promise.resolve({ kind: 'RunNotFound' }) },
      ),
    ).resolves.toEqual({ kind: 'RunResourceNotFound', resource: 'Run' });
  });
});
