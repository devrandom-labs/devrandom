import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const simulationClaim =
  'Independent simulated-input boundary proofs. Not one continuous campaign, genuine Q, live H2 activation, or completed live Task.';

/** These stages reuse production owners with independent fixtures; none establishes genuine Q. */
export const simulationProofStages = [
  {
    id: 'native-evaluation',
    title: 'Real contained native evaluation boundaries',
    testFiles: [
      'packages/runtime/src/evaluation/infrastructure/native-artifact.integration.spec.ts',
      'apps/cli/src/harness/infrastructure/docker-evaluation-tool-effects.integration.spec.ts',
      'apps/cli/src/harness/application/finalization-native-grading.integration.spec.ts',
    ],
    realBoundaries: [
      'Docker containment and native Rust execution',
      'Public artifact API verification',
      'Immutable source capture',
      'Protected source access denied',
      'Native finalization grading',
    ],
    simulatedInputs: [
      'Deterministic model stimuli and profile/authority fixtures',
      'Independent native fixtures, not a full eighteen-Trial campaign',
      'No paid provider call or live Task',
    ],
  },
  {
    id: 'governed-promotion',
    title: 'Frozen manifest, measured selection and Governor approval boundary',
    testFiles: [
      'packages/protocol/src/evaluation/manifest.spec.ts',
      'packages/domain/src/promotion/selection.spec.ts',
      'packages/runtime/src/promotion/application/authorize-promotion.spec.ts',
      'apps/cli/src/promotion/infrastructure/signify-local-promotion-signing.spec.ts',
      'services/server/src/activation/application/commit-activation.spec.ts',
      'apps/cli/src/promotion/composition/proposal-boundaries.spec.ts',
    ],
    realBoundaries: [
      'Content-bound frozen manifest',
      'Eligible and null selection laws',
      'Separate Ed25519 personal-agent and Governor fixture signatures',
      'Exact approval and issuer receipt rejection',
      'Filesystem protected-write rejection and next authorized effect',
    ],
    simulatedInputs: [
      'Measured observations and authority/TEL custody fixtures',
      'Hosted activation transport and issuer receipt fixtures',
      'No live Governor approval or genuine failure qualification',
    ],
  },
  {
    id: 'process-loss-recovery',
    title: 'Real SIGKILL and fresh-process same-Run continuation',
    testFiles: ['apps/cli/src/run/composition/continuation-process-loss.spec.ts'],
    realBoundaries: [
      'OS child process and SIGKILL',
      'SQLite durable prefix and raw artifact custody',
      'Git checkpoint source equality',
      'Localhost HTTP continuation adapter',
      'Same Run with fresh incarnation',
      'Tampered source rejected before admission',
    ],
    simulatedInputs: [
      'Initial Run authority and hosted seal acknowledgements',
      'Local HTTP admission fixture',
      'Independent from promotion stage; no shared campaign or H2 receipt',
    ],
  },
  {
    id: 'portable-publication',
    title: 'Sanitized package verification and clean-profile private fork',
    testFiles: [
      'packages/protocol/src/publication/harness-package.spec.ts',
      'packages/protocol/src/publication/portable-verification.spec.ts',
      'apps/cli/src/publication/application/evaluate-portable-behavior.spec.ts',
      'services/server/src/publication/application/publish-harness.spec.ts',
      'apps/cli/src/publication/infrastructure/private-publication-files.spec.ts',
    ],
    realBoundaries: [
      'Sanitization and package content identity',
      'Portable behavior and protected-source rejection',
      'Publication admission law',
      'Private filesystem custody and retry-safe new lineage',
      'No principal, mandate or credential import',
    ],
    simulatedInputs: [
      'Publisher signature and public verifier outcomes where fixture adapters are supplied',
      'Independent package provenance fixture; not the successor from prior stages',
      'No live publication or account transfer',
    ],
  },
] as const;

export interface SimulationStageExecution {
  readonly stageId: string;
  readonly vitestReportPath: string;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}
interface StageProof {
  readonly id: string;
  readonly title: string;
  readonly status: 'Passed' | 'Blocked';
  readonly reason?: string;
  readonly proofPath?: string;
  readonly proofSha256?: string;
  readonly testCount: number;
  readonly exitCode?: number;
  readonly realBoundaries: readonly string[];
  readonly simulatedInputs: readonly string[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
}
export interface SimulationProofReport {
  readonly version: 1;
  readonly mode: 'Simulation';
  readonly generatedAt: string;
  readonly repositoryRoot: string;
  readonly continuity: 'IndependentFixtureProofs';
  readonly status: 'Passed' | 'Blocked';
  readonly claim: string;
  readonly stages: readonly StageProof[];
}
interface ReportJsonObject {
  readonly [field: string]: unknown;
}
function object(value: unknown): value is ReportJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function inspectReport(
  value: unknown,
  root: string,
  files: readonly string[],
): { readonly passed: boolean; readonly testCount: number } {
  if (!object(value) || value.success !== true || !Array.isArray(value.testResults))
    return { passed: false, testCount: 0 };
  let testCount = 0;
  for (const file of files) {
    const suites = value.testResults.filter(
      (suite: unknown) =>
        object(suite) &&
        typeof suite.name === 'string' &&
        resolve(root, suite.name) === resolve(root, file),
    );
    if (suites.length !== 1) return { passed: false, testCount };
    const suite: unknown = suites[0];
    if (
      !object(suite) ||
      suite.status !== 'passed' ||
      !Array.isArray(suite.assertionResults) ||
      suite.assertionResults.length === 0
    )
      return { passed: false, testCount };
    if (
      !suite.assertionResults.every(
        (assertion: unknown) => object(assertion) && assertion.status === 'passed',
      )
    )
      return { passed: false, testCount };
    testCount += suite.assertionResults.length;
  }
  return { passed: true, testCount };
}

/** Records test execution evidence, not signed product evidence or a causally continuous Run. */
export async function writeSimulationProofReport(input: {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly executions: readonly SimulationStageExecution[];
}): Promise<SimulationProofReport> {
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const stages: StageProof[] = [];
  for (const descriptor of simulationProofStages) {
    const base = {
      id: descriptor.id,
      title: descriptor.title,
      realBoundaries: descriptor.realBoundaries,
      simulatedInputs: descriptor.simulatedInputs,
    };
    const executions = input.executions.filter((item) => item.stageId === descriptor.id);
    const execution = executions[0];
    if (executions.length !== 1 || execution === undefined) {
      stages.push({
        ...base,
        status: 'Blocked',
        reason: executions.length === 0 ? 'MissingExecution' : 'DuplicateExecution',
        testCount: 0,
      });
      continue;
    }
    try {
      const bytes = await readFile(execution.vitestReportPath);
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Report too large');
      const proofSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const proofPath = join(resolve(input.outputDirectory), `${descriptor.id}.vitest.json`);
      await writeFile(proofPath, bytes, { mode: 0o600 });
      const decoded: unknown = JSON.parse(bytes.toString('utf8'));
      const inspected = inspectReport(decoded, input.repositoryRoot, descriptor.testFiles);
      const started = Date.parse(execution.startedAt);
      const finished = Date.parse(execution.finishedAt);
      const passed =
        execution.exitCode === 0 &&
        Number.isFinite(started) &&
        Number.isFinite(finished) &&
        finished >= started &&
        inspected.passed;
      stages.push({
        ...base,
        status: passed ? 'Passed' : 'Blocked',
        ...(passed ? {} : { reason: 'IncompleteOrFailedAssertions' }),
        proofPath,
        proofSha256,
        testCount: inspected.testCount,
        exitCode: execution.exitCode,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
      });
    } catch {
      stages.push({ ...base, status: 'Blocked', reason: 'UnreadableReport', testCount: 0 });
    }
  }
  const report: SimulationProofReport = {
    version: 1,
    mode: 'Simulation',
    repositoryRoot: resolve(input.repositoryRoot),
    generatedAt: new Date().toISOString(),
    continuity: 'IndependentFixtureProofs',
    status: stages.every((stage) => stage.status === 'Passed') ? 'Passed' : 'Blocked',
    claim: simulationClaim,
    stages,
  };
  await writeFile(
    join(input.outputDirectory, 'simulation-proof-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  return report;
}

/** Checks retained report bytes before presentation; this is not product evidence verification. */
export async function readSimulationProofReport(input: {
  readonly outputDirectory: string;
}): Promise<
  | { readonly kind: 'Read'; readonly report: SimulationProofReport }
  | { readonly kind: 'Unavailable' | 'Invalid' }
> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(input.outputDirectory, 'simulation-proof-report.json'));
  } catch {
    return { kind: 'Unavailable' };
  }
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !object(value) ||
      value.version !== 1 ||
      value.mode !== 'Simulation' ||
      value.continuity !== 'IndependentFixtureProofs' ||
      typeof value.repositoryRoot !== 'string' ||
      typeof value.generatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.generatedAt)) ||
      value.claim !== simulationClaim ||
      !Array.isArray(value.stages) ||
      value.stages.length !== simulationProofStages.length
    )
      return { kind: 'Invalid' };
    for (const [index, descriptor] of simulationProofStages.entries()) {
      const stage: unknown = value.stages[index];
      if (
        !object(stage) ||
        stage.id !== descriptor.id ||
        stage.title !== descriptor.title ||
        !isDeepStrictEqual(stage.realBoundaries, descriptor.realBoundaries) ||
        !isDeepStrictEqual(stage.simulatedInputs, descriptor.simulatedInputs) ||
        (stage.status !== 'Passed' && stage.status !== 'Blocked') ||
        typeof stage.testCount !== 'number' ||
        !Number.isSafeInteger(stage.testCount) ||
        stage.testCount < 0
      )
        return { kind: 'Invalid' };
      if (stage.proofPath === undefined) {
        if (
          stage.status !== 'Blocked' ||
          stage.testCount !== 0 ||
          !['MissingExecution', 'DuplicateExecution', 'UnreadableReport'].includes(
            String(stage.reason),
          )
        )
          return { kind: 'Invalid' };
        continue;
      }
      const expectedPath = join(resolve(input.outputDirectory), `${descriptor.id}.vitest.json`);
      if (stage.proofPath !== expectedPath || typeof stage.proofSha256 !== 'string')
        return { kind: 'Invalid' };
      const raw = await readFile(expectedPath);
      if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== stage.proofSha256)
        return { kind: 'Invalid' };
      const inspected = inspectReport(
        JSON.parse(raw.toString('utf8')) as unknown,
        value.repositoryRoot,
        descriptor.testFiles,
      );
      const passed =
        stage.exitCode === 0 &&
        typeof stage.startedAt === 'string' &&
        typeof stage.finishedAt === 'string' &&
        Number.isFinite(Date.parse(stage.startedAt)) &&
        Date.parse(stage.finishedAt) >= Date.parse(stage.startedAt) &&
        inspected.passed;
      if (
        stage.testCount !== inspected.testCount ||
        stage.status !== (passed ? 'Passed' : 'Blocked')
      )
        return { kind: 'Invalid' };
    }
    const passed = value.stages.every(
      (stage: unknown) => object(stage) && stage.status === 'Passed',
    );
    if (value.status !== (passed ? 'Passed' : 'Blocked')) return { kind: 'Invalid' };
    return { kind: 'Read', report: value as unknown as SimulationProofReport };
  } catch {
    return { kind: 'Invalid' };
  }
}
