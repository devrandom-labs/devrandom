import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimulationProofReport } from './simulation-proof-report.js';

export function renderSimulationDemo(report: SimulationProofReport, stageId?: string): string {
  const stages =
    stageId === undefined ? report.stages : report.stages.filter((s) => s.id === stageId);
  if (stages.length === 0) throw new Error('Unknown demo stage.');
  const lines = [
    'DEVRANDOM — GOVERNED AGENT DEMO',
    'RECORDED SIMULATION • Independent mechanism proofs',
    `Prepared: ${report.generatedAt}`,
    report.status === 'Passed' ? 'DEMO PROOFS READY' : 'DEMO PROOFS BLOCKED',
    '',
    'These stages use separate fixtures, not one continuous campaign.',
    'Live evolution acceptance: NOT ESTABLISHED',
    '',
  ];
  for (const stage of stages) {
    lines.push(
      `${stage.status === 'Passed' ? 'PASS' : 'BLOCKED'} | ${stage.title}`,
      `  ${String(stage.testCount)} checked assertions${stage.reason === undefined ? '' : `; ${stage.reason}`}`,
      ...stage.realBoundaries.map((item) => `  Real: ${item}`),
      ...stage.simulatedInputs.map((item) => `  Simulated: ${item}`),
      `  Proof: ${stage.proofPath ?? 'Unavailable'}`,
      `  Digest: ${stage.proofSha256 ?? 'Unavailable'}`,
      '',
    );
  }
  lines.push(
    'Story: propose → verify → govern → recover → share behavior.',
    'Presenter guide: DEMO.md',
  );
  return `${lines.join('\n')}\n`;
}

const usage = `Usage:
  just demo-prd03-prepare [output-directory]
  just demo-prd03 [output-directory] [stage-id]

Preparation executes independent simulation proofs, including real Docker/Rust and SIGKILL.
Set DEVRANDOM_EVAL_IMAGE to the pinned local evaluation image before preparation.
Presentation reads retained proof files and verifies their hashes. It does not run a model.
`;

async function runProof(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolveExit(code ?? 1);
    });
  });
}

async function prepare(directory: string): Promise<number> {
  const image = process.env.DEVRANDOM_EVAL_IMAGE;
  if (image === undefined || !/^sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error(
      'Set DEVRANDOM_EVAL_IMAGE to the exact local sha256 image digest; see DEMO.md.',
    );
  }
  const { simulationProofStages, writeSimulationProofReport } =
    await import('./simulation-proof-report.js');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputDirectory = await mkdtemp(join(directory, 'run-'));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DEVRANDOM_DEMO_REPORT_DIRECTORY: outputDirectory,
  };
  delete environment.CONCENTRATE_API_KEY;
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.DEVRANDOM_CONCENTRATE_INTEGRATION;
  const executions = [];
  for (const stage of simulationProofStages) {
    process.stdout.write(`\nSIMULATION PREPARATION: ${stage.title}\n`);
    const vitestReportPath = join(outputDirectory, `${stage.id}.vitest.json`);
    const startedAt = new Date().toISOString();
    const exitCode = await runProof(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        ...stage.testFiles,
        '--maxWorkers',
        '1',
        '--reporter=json',
        '--outputFile',
        vitestReportPath,
      ],
      environment,
    );
    executions.push({
      stageId: stage.id,
      vitestReportPath,
      exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  const report = await writeSimulationProofReport({
    repositoryRoot: process.cwd(),
    outputDirectory,
    executions,
  });
  await writeFile(join(outputDirectory, 'presentation.txt'), renderSimulationDemo(report), {
    mode: 0o600,
  });
  const pointer = join(directory, 'latest.next.json');
  await writeFile(
    pointer,
    JSON.stringify({ version: 1, directory: outputDirectory.slice(directory.length + 1) }),
    { mode: 0o600 },
  );
  await rename(pointer, join(directory, 'latest.json'));
  process.stdout.write(`\n${renderSimulationDemo(report)}Proof directory: ${outputDirectory}\n`);
  return report.status === 'Passed' ? 0 : 1;
}

async function present(directory: string, stageId?: string): Promise<number> {
  const { readSimulationProofReport } = await import('./simulation-proof-report.js');
  const pointer: unknown = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
  if (
    typeof pointer !== 'object' ||
    pointer === null ||
    !('version' in pointer) ||
    pointer.version !== 1 ||
    !('directory' in pointer) ||
    typeof pointer.directory !== 'string' ||
    !/^run-[A-Za-z0-9]+$/u.test(pointer.directory)
  ) {
    throw new Error('Invalid simulation report pointer.');
  }
  const outputDirectory = join(directory, pointer.directory);
  const metadata = await lstat(outputDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Invalid simulation report directory.');
  const read = await readSimulationProofReport({ outputDirectory });
  if (read.kind !== 'Read')
    throw new Error(
      `Simulation proof is ${read.kind.toLowerCase()}; prepare again in a fresh run directory.`,
    );
  process.stdout.write(renderSimulationDemo(read.report, stageId));
  process.stdout.write(`Proof directory: ${outputDirectory}\n`);
  return read.report.status === 'Passed' ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  const [command, output = '.devrandom/prd03-demo', stageId] = process.argv.slice(2);
  if (command === '--help' || command === undefined) process.stdout.write(usage);
  else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    process.chdir(root);
    const operation =
      command === 'prepare'
        ? prepare(resolve(output))
        : command === 'present'
          ? present(resolve(output), stageId)
          : Promise.reject(new Error(usage));
    void operation
      .then((code) => {
        process.exitCode = code;
      })
      .catch((cause: unknown) => {
        process.stderr.write(
          `${cause instanceof Error ? cause.message : 'Demo preparation failed.'}\n`,
        );
        process.exitCode = 1;
      });
  }
}
