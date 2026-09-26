import { expect, it } from 'vitest';
import { replayTrialProgress } from './replay-trial-progress.js';
const said = (x: string) => `E${x.repeat(43)}`;
const command = {
  identity: 'public',
  contentSaid: said('c'),
  argv: ['cargo', 'test'],
  timeoutSeconds: 20,
  expectedExitCode: 0,
  executableRealpath: '/usr/bin/cargo',
};
const effect = (before: string, after: string, exitCode?: number) => ({
  version: 1,
  kind: 'EvaluationRepositoryEffect',
  toolCallId: 'call',
  proposalIndex: 0,
  inputKind: exitCode === undefined ? 'WriteFile' : 'RunTests',
  sourceBeforeSaid: said(before),
  sourceAfterSaid: said(after),
  ...(exitCode === undefined
    ? {}
    : {
        command: {
          identity: command.identity,
          contentSaid: command.contentSaid,
          argv: command.argv,
          expectedExitCode: 0,
          exitCode,
          output: '',
          error: 'failure',
          cleanupConfirmed: true,
        },
      }),
});
it('counts the same failing condition only after an actual edit without a new verified milestone', () => {
  expect(
    replayTrialProgress(
      [
        effect('a', 'a', 1),
        effect('a', 'a', 1),
        effect('a', 'b'),
        effect('b', 'b', 1),
        effect('b', 'b', 1),
      ],
      [command],
    ),
  ).toEqual({ kind: 'Verified', repeatedFailures: 1 });
  expect(
    replayTrialProgress(
      [
        effect('a', 'a', 1),
        effect('a', 'b'),
        effect('b', 'b', 0),
        effect('b', 'c'),
        effect('c', 'c', 1),
      ],
      [command],
    ),
  ).toEqual({ kind: 'Verified', repeatedFailures: 0 });
});
it('rejects swapped source continuity, unknown command identity, and missing native cleanup', () => {
  expect(replayTrialProgress([effect('a', 'b'), effect('z', 'z', 1)], [command])).toEqual({
    kind: 'Incomplete',
  });
  expect(replayTrialProgress([effect('a', 'a', 1)], [])).toEqual({ kind: 'Incomplete' });
  const bad = effect('a', 'a', 1);
  expect(
    replayTrialProgress(
      [{ ...bad, command: { ...bad.command, cleanupConfirmed: false } }],
      [command],
    ),
  ).toEqual({ kind: 'Incomplete' });
});
