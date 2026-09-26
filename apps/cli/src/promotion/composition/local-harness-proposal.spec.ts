import { expect, it } from 'vitest';
import { proposeLocalHarness, type LocalHarnessProposalInput } from './local-harness-proposal.js';
it('rejects a different operator before reading proposal bytes or establishing agent custody', async () => {
  const input = {
    task: { ownerAid: 'owner' },
    hosted: { user: { principal: { aid: 'different' } } },
    signal: new AbortController().signal,
  } as unknown as LocalHarnessProposalInput;
  expect(await proposeLocalHarness(input)).toEqual({ kind: 'Blocked', gate: 'Authority' });
});
