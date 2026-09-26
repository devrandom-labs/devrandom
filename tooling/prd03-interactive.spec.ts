import { expect, it, vi } from 'vitest';
import { runInteractiveDemo } from './prd03-interactive.js';
import { demoCliActions } from './demo-cli-actions.js';

it.each(demoCliActions)(
  'routes the complete $id action through its public command',
  async (action) => {
    const result = await present([
      ...(action.availability === 'Blocked' ? [`enable ${action.id}`] : []),
      action.command.join(' '),
      ...action.inputs.map(() => 'test-input'),
      ...(action.requiresConfirmation ? ['RUN'] : []),
      'exit',
    ]);
    expect(result.invoke).toHaveBeenCalledOnce();
    expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: action.id }));
    expect(result.output).not.toContain('Unknown command');
    if (action.id === 'init') expect(result.output).toContain('Connecting to identity services');
  },
);

it.each(['init', 'devrandom init', 'init --no-open', 'live init'])(
  'routes %s to real onboarding after confirmation',
  async (command) => {
    const result = await present([command, 'RUN', 'exit']);
    expect(result.invoke).toHaveBeenCalledOnce();
    expect(result.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'init', confirmed: true }),
    );
    expect(result.output).not.toContain('Unknown command');
  },
);

it('keeps onboarding available from the walkthrough', async () => {
  const result = await present(['walkthrough', 'init', 'RUN', 'exit']);
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: 'init' }));
});

it.each([
  { command: 'whoami', answers: [], action: 'whoami' },
  { command: 'task list', answers: [], action: 'task-list' },
  { command: 'task create', answers: ['/tmp/task.json', 'RUN'], action: 'task-create' },
  { command: 'task inspect', answers: ['presentation-20260926'], action: 'task-inspect' },
])('routes the advertised $command command', async ({ command, answers, action }) => {
  const result = await present([command, ...answers, 'exit']);
  expect(result.invoke).toHaveBeenCalledOnce();
  expect(result.invoke).toHaveBeenCalledWith(expect.objectContaining({ action }));
  expect(result.output).not.toContain('Unknown command');
});

async function present(commands: string[], color = false) {
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
    color,
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
  expect(result.output).toContain('consumer-01');
  expect(result.output).toContain('Same Run: run-06');
  expect(result.output).toContain('Illustrative walkthrough');
});

it('offers a colored walkthrough with one disclosure and natural commands', async () => {
  const result = await present(
    [
      'walkthrough',
      'task',
      'baseline',
      'compare workflow',
      'approve',
      'crash',
      'resume',
      'publish',
      'fork',
      'exit',
    ],
    true,
  );
  expect(result.invoke).not.toHaveBeenCalled();
  expect(result.output).toContain('\u001b[');
  expect(result.output.match(/Illustrative walkthrough/g)).toHaveLength(1);
  expect(result.output).not.toContain('[SIMULATED]');
  expect(result.output).not.toContain('[LIVE CLI]');
  expect(result.output).toContain('New private lineage');
});
