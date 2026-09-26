import { expect, it } from 'vitest';
import { resumeLocalTask, type LocalTaskResumptionInput } from './local-task-resumption.js';
it('rejects a different current owner before opening local custody or acquiring a continuation', async () => {
  const input = {
    task: { ownerAid: 'owner' },
    hosted: { user: { principal: { aid: 'different' } } },
    signal: new AbortController().signal,
  } as unknown as LocalTaskResumptionInput;
  expect(await resumeLocalTask(input)).toEqual({ kind: 'Blocked', gate: 'Authority' });
});
it('rejects an initial pointer before any mandate or executor effect', async () => {
  const input = {
    task: { ownerAid: 'owner', taskId: 'task' },
    hosted: {
      user: { principal: { aid: 'owner' } },
      activationPointer: () => ({
        inspect: () => Promise.resolve({ kind: 'Observed', pointer: { kind: 'Initial' } }),
      }),
    },
    signal: new AbortController().signal,
  } as unknown as LocalTaskResumptionInput;
  expect(await resumeLocalTask(input)).toEqual({ kind: 'Blocked', gate: 'Activation' });
});
