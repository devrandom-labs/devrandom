import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoCliActions, invokeDemoCliAction } from './demo-cli-actions.js';
import { initialSimulation, simulateDemoCommand } from './demo-simulation.js';
import { presentRecordedProofs } from './prd03-demo.js';

const help = `  whoami             Your verified identity
  init               Create or recover identity
  task list          Your tasks
  task create        Create a task from its JSON contract
  task inspect       Inspect an existing task
  walkthrough        Explore the complete journey
  actions            All product commands
  proofs             Inspect recorded evidence
  help / exit        Help / leave
`;

type Invocation = Parameters<typeof invokeDemoCliAction>[0];
export async function runInteractiveDemo(input: {
  readonly read: (prompt: string) => Promise<string | null>;
  readonly write: (text: string) => void;
  readonly repositoryRoot: string;
  readonly workingDirectory?: string;
  readonly environmentFile?: string;
  readonly proofDirectory: string;
  readonly color?: boolean;
  readonly animate?: boolean;
  readonly invoke?: (input: Invocation) => ReturnType<typeof invokeDemoCliAction>;
  readonly proofs?: (directory: string, stage?: string) => Promise<number>;
}): Promise<void> {
  let scene = initialSimulation;
  let walkthrough = false;
  let disclosed = false;
  const paint = (code: string, text: string) =>
    input.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const render = (text: string) =>
    text
      .replace(/\b(PASS|approved|verified)\b/g, (word) => paint('32', word))
      .replace(/\b(FAIL|Denied|Blocked)\b/g, (word) => paint('33', word))
      .replace(/^(Next:|Try:|Choose:)(.*)$/gm, (_, label: string, rest: string) =>
        paint('2', `${label}${rest}`),
      );
  const disclose = () => {
    if (disclosed) return;
    input.write(
      paint(
        '33',
        '\n  Illustrative walkthrough — scenario results, not live execution evidence.\n',
      ),
    );
    disclosed = true;
  };
  const showScene = async (output: string) => {
    const text = output
      .replace(/^\[SIMULATED\] /, '')
      .replace(/^These outcomes are illustrative, not live Q evidence\.\n/gm, '')
      .replace(
        /^Numbers were not measured here\. A live winner is determined only by real evidence\.\n/gm,
        '',
      )
      .replace('This is not live Task completion. ', '')
      .replaceAll('sim ', '')
      .replaceAll('simulated ', '')
      .replaceAll('illustrative ', '')
      .replace('Illustrative successes', 'Successes')
      .replace('Illustrative final verification', 'Final verification')
      .replace(' (not a real SAID or Atlas record)', '')
      .replaceAll('SIM-RUN-06', 'run-06')
      .replaceAll('SIM-MANIFEST-01', 'manifest-01')
      .replaceAll('SIM-CHECKPOINT-01', 'checkpoint-01')
      .replaceAll('SIM-PACKAGE-01', 'package-01')
      .replaceAll('SIM-CONSUMER-01', 'consumer-01');
    const lines = text.trimEnd().split('\n');
    input.write('\n' + paint('36;1', `  ${lines.shift() ?? ''}`) + '\n');
    for (const line of lines) {
      if (input.animate) await new Promise((resolve) => setTimeout(resolve, 65));
      input.write(`  ${render(line)}\n`);
    }
    input.write('\n');
  };
  const enabled = new Set<string>();
  input.write(
    `\n${paint('36;1', '  D E V R A N D O M')}\n${paint('2', '  Better agents. Bounded authority.')}\n${paint('2', '  ─────────────────────────────────────────────────────')}\n\n`,
  );
  input.write(help);
  for (;;) {
    const line = await input.read(paint('36', 'devrandom ❯ '));
    if (line === null || ['exit', 'quit'].includes(line.trim())) return;
    const command = line.trim();
    if (command === '' || command === 'help') {
      input.write(help);
      continue;
    }
    if (command === 'simulate' || command === 'walkthrough') {
      walkthrough = true;
      disclose();
      input.write(
        `\n${paint('36;1', '  The complete journey')}\n  task → baseline → compare workflow → approve\n  network → crash → resume → publish → fork\n\n  Start with: ${paint('1', 'task')}\n  Use product to return to your connected CLI.\n\n`,
      );
      continue;
    }
    if (command === 'product') {
      walkthrough = false;
      input.write(help);
      continue;
    }
    if (
      command.startsWith('sim ') ||
      (walkthrough &&
        !['actions', 'proofs'].includes(command) &&
        !/^(live |enable |proofs )/.test(command) &&
        !demoCliActions.some((action) => action.command.join(' ') === command))
    ) {
      disclose();
      const next = simulateDemoCommand(
        scene,
        command.startsWith('sim ') ? command.slice(4) : command,
      );
      scene = next.state;
      await showScene(next.output);
      continue;
    }
    if (command === 'actions') {
      input.write(
        demoCliActions
          .map(
            (action) =>
              `  ${paint('36', action.command.join(' ').padEnd(28))} ${action.title}${action.availability === 'Blocked' && !enabled.has(action.id) ? ' · prerequisites required' : ''}`,
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
      input.write(`Path enabled for ${id}. The CLI will verify prerequisites.\n`);
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
        `${action.reason ?? 'Required artifacts must be available.'}\nUse enable ${action.id} to attempt this path, or walkthrough to explore the scenario.\n`,
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
    input.write(`\n${paint('36;1', `  devrandom ${action.command.join(' ')}`)}\n\n`);
    if (action.requiresConfirmation) {
      input.write('This command can change state or consume the authorized budget.\n');
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
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
      ...(input.environmentFile === undefined ? {} : { environmentFile: input.environmentFile }),
      onOutput: (text) => {
        input.write(render(text));
      },
    });
    input.write(
      paint(
        outcome.exitCode === 0 ? '32' : '33',
        `\n  ${outcome.kind} · exit ${outcome.exitCode === null ? 'unavailable' : String(outcome.exitCode)}\n\n`,
      ),
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
    ...(process.env['DEVRANDOM_DEMO_WORKING_DIRECTORY'] === undefined
      ? {}
      : {
          workingDirectory: resolve(process.env['DEVRANDOM_DEMO_WORKING_DIRECTORY']),
        }),
    color:
      process.env['FORCE_COLOR'] === '1' ||
      (process.env['NO_COLOR'] === undefined && process.stdout.isTTY),
    animate: process.stdout.isTTY && process.env['DEVRANDOM_DEMO_NO_ANIMATION'] !== '1',
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
