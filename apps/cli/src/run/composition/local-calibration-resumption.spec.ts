import { expect, it, vi } from 'vitest';
import * as protocol from '@devrandom/protocol';
import { resumeLocalCalibration } from './local-calibration-resumption.js';
import type { LocalTaskResumptionInput } from './local-task-resumption.js';

vi.mock('@devrandom/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof protocol>()),
  decodeRunProjection: vi.fn(),
}));

it('admits a sealed successor blocked by context limit to the baseline authority gate', async () => {
  vi.mocked(protocol.decodeRunProjection).mockReturnValue({
    kind: 'Accepted',
    run: {
      binding: {
        purpose: { kind: 'PreparedCompatibilityCalibration' },
        taskId: 'task',
        taskRevisionSaid: 'revision',
      },
      currentExecution: { harnessRevisionSaid: 'h1' },
      lifecycle: { kind: 'Active', phase: { kind: 'Blocked', reason: 'ContextLimitReached' } },
    },
  } as ReturnType<typeof protocol.decodeRunProjection>);
  const input = {
    task: { ownerAid: 'owner', taskId: 'task', revisionSaid: 'revision' },
    hosted: {
      user: { principal: { aid: 'owner' } },
      runs: { inspect: () => Promise.resolve({ kind: 'Found', run: {} }) },
      activationPointer: () => ({ inspect: () => Promise.resolve({ kind: 'NotFound' }) }),
    },
    signal: new AbortController().signal,
  } as unknown as LocalTaskResumptionInput;
  await expect(resumeLocalCalibration(input)).resolves.toEqual({
    kind: 'Blocked',
    gate: 'Baseline',
  });
});
