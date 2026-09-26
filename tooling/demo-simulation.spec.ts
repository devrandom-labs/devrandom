import { expect, it } from 'vitest';
import { initialSimulation, simulateDemoCommand } from './demo-simulation.js';
it('refuses activation without comparison and separates denial from approval', () => {
  let state = initialSimulation;
  expect(simulateDemoCommand(state, 'approve').output).toContain('No evaluated successor');
  for (const command of ['task', 'baseline', 'compare workflow'])
    state = simulateDemoCommand(state, command).state;
  const denied = simulateDemoCommand(state, 'approve agent');
  expect(denied.state.active).toBe(false);
  expect(denied.output).toContain('Denied');
  expect(simulateDemoCommand(state, 'approve').state.active).toBe(true);
});
it('can retain H1 without inventing a winner', () => {
  let state = initialSimulation;
  for (const command of ['task', 'baseline', 'compare none', 'approve'])
    state = simulateDemoCommand(state, command).state;
  expect(state.winner).toBeNull();
  expect(state.active).toBe(false);
});
it('keeps the same simulated Run on recovery and does not transfer authority', () => {
  let state = initialSimulation;
  for (const command of [
    'task',
    'baseline',
    'compare instruction',
    'approve',
    'crash',
    'resume',
    'publish',
    'fork',
  ]) {
    const result = simulateDemoCommand(state, command);
    state = result.state;
    expect(result.output).toContain('[SIMULATED]');
  }
  expect(state).toMatchObject({ incarnation: 2, forked: true, winner: 'C1' });
  expect(simulateDemoCommand(state, 'inspect').output).toContain('SIM-RUN-06');
  expect(simulateDemoCommand(state, 'network').output).toContain('No authority gained');
});
