import { describe, expect, it } from 'vitest';
import { RunCheckpointPause } from './run-checkpoint-pause.js';
const proposal = {
  piSessionId: 'session',
  modelTurnId: 'turn',
  toolCallId: 'call',
  proposalIndex: 0,
  input: { kind: 'WriteFile' as const, path: 'src/main.rs', content: 'real edit' },
};
describe('effect-disabled checkpoint pause', () => {
  it('pauses only after a real successfully settled edit and rejects every subsequent effect', async () => {
    let calls = 0;
    const pause = new RunCheckpointPause();
    const gateway = pause.gateway({
      propose: () => {
        calls++;
        return Promise.resolve({
          kind: 'Completed' as const,
          summary: 'written',
          outputArtifactSaids: [],
        });
      },
    });
    expect(pause.reached).toBe(false);
    expect((await gateway.propose(proposal, new AbortController().signal)).kind).toBe('Completed');
    expect(pause.reached).toBe(true);
    const predecessor = {
      objectFormat: 'sha1' as const,
      baseCommit: 'a'.repeat(40),
      baseTree: 'b'.repeat(40),
      changedFiles: [],
    };
    expect(pause.hasProgress(predecessor, predecessor)).toBe(false);
    expect(
      pause.hasProgress(
        {
          ...predecessor,
          changedFiles: [
            {
              path: 'src/main.rs',
              disposition: 'Modified',
              contentSaid: 'E' + 'c'.repeat(43),
              mode: '100644',
            },
          ],
        },
        predecessor,
      ),
    ).toBe(true);
    expect(pause.signal.aborted).toBe(true);
    expect(await gateway.propose(proposal, new AbortController().signal)).toEqual({
      kind: 'DependencyUnavailable',
    });
    expect(calls).toBe(1);
  });
  it('does not turn failed edits or read-only calls into progress', async () => {
    const pause = new RunCheckpointPause();
    await pause
      .gateway({
        propose: () =>
          Promise.resolve({
            kind: 'Failed',
            failure: 'ExitCodeMismatch',
            summary: 'failed',
            outputArtifactSaids: [],
          }),
      })
      .propose(proposal, new AbortController().signal);
    expect(pause.reached).toBe(false);
    await pause
      .gateway({
        propose: () =>
          Promise.resolve({ kind: 'Completed', summary: 'read', outputArtifactSaids: [] }),
      })
      .propose(
        { ...proposal, input: { kind: 'ReadFile', path: 'src/main.rs' } },
        new AbortController().signal,
      );
    expect(pause.reached).toBe(false);
  });
});
