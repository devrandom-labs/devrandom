import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoCliActions, invokeDemoCliAction } from './demo-cli-actions.js';
import { initialSimulation, simulateDemoCommand, simulationHelp } from './demo-simulation.js';
import { presentRecordedProofs } from './prd03-demo.js';

const help = `devrandom interactive demo

Real commands: live whoami | live init | live task-list | live task-inspect
  actions                 list all actual CLI capabilities and prerequisites
  live <action>           prompt for inputs and invoke the existing product CLI
  enable <action>         choose a prerequisite-dependent live path explicitly
  simulate                open the illustrative continuation (no live writes)
  sim <command>           explore one simulated action; sim help lists choices
  proofs [stage]          inspect retained, hash-verified fixture proof reports
  help / exit             show this help / leave

LIVE output comes from the actual CLI; failures never turn into simulation.
SIMULATED output is a disposable overlay, not measured performance or authority.
Nothing runs automatically. Existing Tasks are preserved; select one to inspect.
`;

type Invocation = Parameters<typeof invokeDemoCliAction>[0];
export async function runInteractiveDemo(input: {
  readonly read: (prompt: string) => Promise<string | null>;
  readonly write: (text: string) => void;
  readonly repositoryRoot: string;
  readonly environmentFile?: string;
  readonly proofDirectory: string;
  readonly invoke?: (input: Invocation) => ReturnType<typeof invokeDemoCliAction>;
  readonly proofs?: (directory: string, stage?: string) => Promise<number>;
}): Promise<void> {
  let scene = initialSimulation;
  const enabled = new Set<string>();
  input.write(help);
  for (;;) {
    const line = await input.read('devrandom demo > ');
    if (line === null || ['exit', 'quit'].includes(line.trim())) return;
    const command = line.trim();
    if (command === '' || command === 'help') {
      input.write(help);
      continue;
    }
    if (command === 'simulate') {
      input.write(`[SIMULATED] ${simulationHelp}\nStart: sim task\n`);
      continue;
    }
    if (command.startsWith('sim ')) {
      const next = simulateDemoCommand(scene, command.slice(4));
      scene = next.state;
      input.write(next.output);
      continue;
    }
    if (command === 'actions') {
      input.write(
        demoCliActions
          .map(
            (action) =>
              `${action.availability === 'Live' || enabled.has(action.id) ? 'LIVE' : 'PREREQUISITES'}  ${action.id.padEnd(25)} devrandom ${action.command.join(' ')}${action.requiresConfirmation ? ' [confirmation required]' : ''}${action.reason ? `\n    ${action.reason}` : ''}`,
          )
          .join('\n') + '\n',
      );
      continue;
    }
    if (command.startsWith('enable ')) {
      const id = command.slice(7).trim();
      if (!demoCliActions.some((action) => action.id === id)) {
        input.write('Unknown action. Use actions.\n');
        continue;
      }
      enabled.add(id);
      input.write(
        `LIVE path enabled for ${id}. Actual CLI still checks every prerequisite and authority grant. No command executed.\n`,
      );
      continue;
    }
    if (command === 'proofs' || command.startsWith('proofs ')) {
      try {
        const code = await (input.proofs ?? presentRecordedProofs)(
          input.proofDirectory,
          command.slice(6).trim() || undefined,
        );
        input.write(
          `[RECORDED FIXTURE PROOFS] Verification exit ${String(code)}. Independent proofs are not a live campaign.\n`,
        );
      } catch (cause) {
        input.write(
          `[RECORDED FIXTURE PROOFS] Unavailable: ${cause instanceof Error ? cause.message : 'could not read report'}\nNo proof result fabricated.\n`,
        );
      }
      continue;
    }
    const id = command.startsWith('live ')
      ? command.slice(5).trim()
      : demoCliActions.find((action) => action.command.join(' ') === command)?.id;
    const action = demoCliActions.find((candidate) => candidate.id === id);
    if (!action) {
      input.write('Unknown command. Use help or actions.\n');
      continue;
    }
    if (action.availability === 'Blocked' && !enabled.has(action.id)) {
      input.write(
        `[LIVE prerequisite] ${action.reason ?? 'Required artifacts must be available.'}\nUse enable ${action.id} to attempt the real path, or explicitly choose simulate.\n`,
      );
      continue;
    }
    const values: Record<string, string> = {};
    let cancelled = false;
    for (const field of action.inputs) {
      const value = await input.read(
        `${field.label}${field.required ? ' (required)' : ' (optional)'}: `,
      );
      if (value === null) return;
      if (value.trim() === '' && field.required) {
        input.write('Cancelled: required input is empty.\n');
        cancelled = true;
        break;
      }
      if (value.trim() !== '') values[field.name] = value.trim();
    }
    if (cancelled) continue;
    input.write(`[LIVE CLI] devrandom ${action.command.join(' ')}\n`);
    if (action.requiresConfirmation) {
      input.write(
        'This invokes real state changes and may consume authorized provider budget. No simulation or automatic retry.\n',
      );
      if ((await input.read('Type RUN to invoke; anything else cancels: ')) !== 'RUN') {
        input.write('Cancelled. No live command invoked.\n');
        continue;
      }
    }
    const outcome = await (input.invoke ?? invokeDemoCliAction)({
      action: action.id,
      inputs: values,
      confirmed: action.requiresConfirmation,
      enabledActions: [...enabled],
      repositoryRoot: input.repositoryRoot,
      ...(input.environmentFile === undefined ? {} : { environmentFile: input.environmentFile }),
      onOutput: input.write,
    });
    input.write(
      `[LIVE CLI] ${outcome.kind}; exit ${outcome.exitCode === null ? 'unavailable' : String(outcome.exitCode)}. CLI output determines domain outcome.\n`,
    );
    if (outcome.kind !== 'Completed') input.write(`${outcome.output}\n`);
    if (outcome.exitCode !== 0)
      input.write('Live action did not complete successfully. No simulated result substituted.\n');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();
  const root = resolve(
    process.env['DEVRANDOM_DEMO_REPOSITORY_ROOT'] ??
      resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  void runInteractiveDemo({
    repositoryRoot: root,
    proofDirectory: resolve(process.argv[2] ?? '.devrandom/prd03-demo'),
    ...(process.env['DEVRANDOM_DEMO_ENV_FILE'] === undefined
      ? {}
      : { environmentFile: process.env['DEVRANDOM_DEMO_ENV_FILE'] }),
    write: (text) => process.stdout.write(text),
    read: async (prompt) => {
      process.stdout.write(prompt);
      const next = await iterator.next();
      return next.done === true ? null : next.value;
    },
  })
    .catch((cause: unknown) => {
      process.stderr.write(
        `${cause instanceof Error ? cause.message : 'Interactive demo failed.'}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      lines.close();
    });
}
