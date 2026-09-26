/** Ephemeral presenter state. This module never creates production Tasks, evidence, or authority. */
export interface SimulationScene {
  readonly phase:
    | 'Ready'
    | 'Task'
    | 'Failure'
    | 'Compared'
    | 'Active'
    | 'Crashed'
    | 'Resumed'
    | 'Published'
    | 'Forked';
  readonly winner: 'C1' | 'C2' | null;
  readonly active: boolean;
  readonly incarnation: number;
  readonly forked: boolean;
}
export const initialSimulation: SimulationScene = {
  phase: 'Ready',
  winner: null,
  active: false,
  incarnation: 1,
  forked: false,
};
export const simulationHelp = `SIMULATION commands (ephemeral; no provider or hosted writes):
  task                 prepare an illustrative bounded Task
  baseline             inspect a simulated qualified H1 failure
  compare workflow     explore a workflow-improvement result
  compare instruction  explore an instruction-improvement result
  compare none         explore no eligible successor
  approve agent        try approval without Governor authority
  approve              approve the exact simulated decision
  network              test the unchanged authority ceiling
  crash / resume       lose a process; resume the same Run
  publish / fork       share behavior into a clean private lineage
  inspect              see current state and its provenance
  evidence             distinguish illustrative output from recorded proofs
  reset                clear only this simulation
Prefix these with "sim", e.g. sim baseline. Live commands remain separate.`;
export function simulateDemoCommand(
  state: SimulationScene,
  command: string,
): { readonly state: SimulationScene; readonly output: string } {
  const result = (output: string, next = state) => ({
    state: next,
    output: `[SIMULATED] ${output}\n`,
  });
  switch (command.trim()) {
    case 'task':
      return state.phase === 'Ready'
        ? result(
            'Task prepared: demo-receipt-compat\n  Deliverable: src/lib.rs\n  Public verification: current · tamper · legacy\n  Capabilities: read, edit, test, submit\n  Network, credentials, external writes: denied\nNext: sim baseline',
            { ...state, phase: 'Task' },
          )
        : result('An illustrative Task already exists. Use sim reset to start another story.');
    case 'baseline':
      return state.phase === 'Task'
        ? result(
            'H1 verification: compatibility failure\n  current: PASS   tamper: PASS   legacy: FAIL\n  Qualification: 4 matching failures / 5 attempts, 1 excluded\n  Sixth retained Run: SIM-RUN-06\n  Hypothesis: recovery misses a compatibility step\nThese outcomes are illustrative, not live Q evidence.\nChoose: sim compare workflow | instruction | none',
            { ...state, phase: 'Failure' },
          )
        : result('Prepare the simulated Task first: sim task');
    case 'compare workflow':
    case 'compare instruction':
    case 'compare none': {
      if (state.phase !== 'Failure')
        return result(
          'Comparison requires the simulated retained failure. Reset to explore another scenario.',
        );
      const winner = command.endsWith('none')
        ? null
        : command.endsWith('instruction')
          ? 'C1'
          : 'C2';
      return result(
        `Frozen illustrative comparison: SIM-MANIFEST-01\n  Design: 18 rollouts → 15 measurements\n  Arm         Behavior                Illustrative successes\n  H1          Original harness        1 / 3\n  C1          Instruction reminder     ${winner === 'C1' ? '3' : '1'} / 3\n  C2          Recovery workflow        ${winner === 'C2' ? '3' : '1'} / 3\n  C3          Context selection        2 / 3\n  H1 search   Equal-budget control     1 / 3\n${winner === null ? '  Safety: candidates disqualified. No eligible successor; retain H1.' : '  Proposed H2: ' + winner + '. NOT active until exact Governor approval.'}\nNumbers were not measured here. A live winner is determined only by real evidence.\nTry: sim approve agent | sim approve`,
        { ...state, phase: 'Compared', winner },
      );
    }
    case 'approve agent':
      return result('Denied: personal-agent AID cannot sign as Governor. No activation.');
    case 'approve':
      return state.phase === 'Compared' && state.winner !== null
        ? result(
            `Exact Governor decision: approved\n  Manifest: SIM-MANIFEST-01\n  Active H2: ${state.winner}\n  Original authority ceiling: unchanged\nTry: sim network, then sim crash`,
            { ...state, phase: 'Active', active: true },
          )
        : result('No evaluated successor eligible for activation. H1 retained.');
    case 'network':
      return result(
        'Denied: NetworkAccess is outside the original mandate.\nNo authority gained from performance, evolution, or a package fork.',
      );
    case 'crash':
      return state.phase === 'Active'
        ? result(
            'Process lost after checkpoint SIM-CHECKPOINT-01\n  Run: SIM-RUN-06 retained\n  Evidence and checkpoint remain addressable\nNext: sim resume',
            { ...state, phase: 'Crashed' },
          )
        : result('Activate a simulated successor before exploring process loss.');
    case 'resume':
      return state.phase === 'Crashed'
        ? result(
            'Checkpoint reopened and verified\n  Same Run: SIM-RUN-06\n  New incarnation: 2\n  Continued under the same authority and remaining budget\n  Illustrative final verification: PASS\nThis is not live Task completion. Next: sim publish',
            { ...state, phase: 'Resumed', incarnation: 2 },
          )
        : result('No simulated lost process to resume. Nothing replayed.');
    case 'publish':
      return state.phase === 'Resumed'
        ? result(
            'Behavior sanitized\n  Included: reviewed behavior, compatibility, safe provenance\n  Excluded: identity, credentials, mandate, compute, private memory\n  Package: SIM-PACKAGE-01 (not a real SAID or Atlas record)\nNext: sim fork',
            { ...state, phase: 'Published' },
          )
        : result('Complete the simulated recovery before publication.');
    case 'fork':
      return state.phase === 'Published'
        ? result(
            'Clean consumer verified illustrative package\n  New private lineage: SIM-CONSUMER-01\n  Source behavior: SIM-PACKAGE-01\n  Identity, Task authority, keys and compute transferred: NONE\nTry sim network, or return to a live command.',
            { ...state, phase: 'Forked', forked: true },
          )
        : result('Publish the simulated behavior first.');
    case 'inspect':
      return result(
        `Phase: ${state.phase}\nRun: ${state.phase === 'Ready' ? 'not prepared' : 'SIM-RUN-06'}\nIncarnation: ${String(state.incarnation)}\nProposed successor: ${state.winner ?? 'none'}\nActive: ${state.active ? 'yes (illustrative)' : 'no'}\nPersistence: none; all state is presenter-local.\nLive Task/Run/evidence: unchanged.`,
      );
    case 'evidence':
      return result(
        'No simulated score, identifier, approval or receipt is production evidence.\nThe separate recorded backup contains independent fixture proofs, not one continuous live campaign.\nUse proofs to verify retained hashes and inspect real boundaries vs fixture inputs.',
      );
    case 'reset':
      return result('Presenter overlay reset. No live state changed.', initialSimulation);
    default:
      return result(simulationHelp);
  }
}
