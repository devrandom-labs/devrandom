import { describe, expect, it, vi } from 'vitest';

import { ReviewedComparisonPlanFile } from './reviewed-comparison-plan-file.js';

describe('parent-reviewed Evaluation plan file', () => {
  it('blocks when the exact newly qualified inventory differs from the reviewed file', async () => {
    const read = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        policy: {
          originRunId: 'run',
          taskId: 'task',
          taskRevisionSaid: 'revision',
          sourceInventorySaid: 'inventory',
        },
        profile: { d: 'profile' },
        inventory: { d: 'inventory', sources: [{ episodeSaid: 'original' }] },
      }),
    );
    const plan = new ReviewedComparisonPlanFile('parent-policy.json', { read } as never);
    const result = await plan.review({
      qualified: { originRunId: 'run', taskId: 'task', taskRevisionSaid: 'revision' } as never,
      inventory: { d: 'inventory', sources: [{ episodeSaid: 'substituted' }] } as never,
    });
    expect(result).toEqual({ kind: 'Missing' });
    expect(read).toHaveBeenCalledWith('parent-policy.json');
  });
});
