import { expect, it } from 'vitest';
import { RunEffectQuiescence } from './run-effect-quiescence.js';
it('stops all later writers before submission capture and does not claim quiescence during a prior effect', async () => {
  const custody = new RunEffectQuiescence();
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const gateway = custody.gateway({
    propose: async (proposal) => {
      calls++;
      if (proposal.input.kind === 'WriteFile') await pending;
      else expect(custody.writersStopped()).toBe(true);
      return { kind: 'Completed', summary: 'done', outputArtifactSaids: [] };
    },
  });
  const base = {
    piSessionId: 'session',
    modelTurnId: 'turn',
    toolCallId: 'call',
    proposalIndex: 0,
  };
  const signal = new AbortController().signal;
  const writing = gateway.propose(
    { ...base, input: { kind: 'WriteFile', path: 'source', content: 'edit' } },
    signal,
  );
  expect(custody.writersStopped()).toBe(false);
  expect(
    await gateway.propose({ ...base, input: { kind: 'SubmitResult', artifactSaids: [] } }, signal),
  ).toEqual({ kind: 'DependencyUnavailable' });
  release();
  await writing;
  await gateway.propose({ ...base, input: { kind: 'SubmitResult', artifactSaids: [] } }, signal);
  expect(
    await gateway.propose(
      { ...base, input: { kind: 'WriteFile', path: 'source', content: 'later' } },
      signal,
    ),
  ).toEqual({ kind: 'DependencyUnavailable' });
  expect(calls).toBe(2);
});
