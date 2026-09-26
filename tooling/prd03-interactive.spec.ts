import { expect, it, vi } from 'vitest';
import { runInteractiveDemo } from './prd03-interactive.js';

async function present(commands: string[]) {
  const output: string[] = [];
  const invoke = vi.fn(() =>
    Promise.resolve({
      kind: 'Completed' as const,
      action: 'whoami',
      provenance: 'Live' as const,
      output: 'actual failure',
      exitCode: 1,
    }),
  );
  await runInteractiveDemo({
    repositoryRoot: '/unused',
    proofDirectory: '/unused',
    read: () => Promise.resolve(commands.shift() ?? null),
    write: (text) => output.push(text),
    invoke,
  });
  return { output: output.join(''), invoke };
}
it('keeps failed real commands live and never silently simulates success', async () => {
  const result = await present(['live whoami', 'exit']);
  expect(result.invoke).toHaveBeenCalledOnce();
  expect(result.output).toContain('No simulated result substituted');
  expect(result.output).not.toContain('Active H2:');
});
it('does not invoke mutations unless the operator confirms', async () => {
  const result = await present(['live init', 'no', 'exit']);
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.output).toContain('No live command invoked');
});
it('runs the complete explicitly simulated journey without a real invocation', async () => {
  const result = await present([
    'simulate',
    'sim task',
    'sim baseline',
    'sim compare workflow',
    'sim approve agent',
    'sim approve',
    'sim network',
    'sim crash',
    'sim resume',
    'sim publish',
    'sim fork',
    'exit',
  ]);
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.output).toContain('SIM-CONSUMER-01');
  expect(result.output).toContain('Same Run: SIM-RUN-06');
  expect(result.output).toContain('not live Q evidence');
});
