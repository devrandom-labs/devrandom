import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  simulationProofStages,
  writeSimulationProofReport,
  readSimulationProofReport,
} from './simulation-proof-report.js';

it.each(['passed', 'pending', 'failed', 'missing'] as const)(
  'reports independent proof stages truthfully when a required assertion is %s',
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), 'simulation-proof-report-'));
    try {
      const executions = [];
      for (const stage of simulationProofStages) {
        const path = join(root, `${stage.id}.json`);
        await writeFile(
          path,
          JSON.stringify({
            success: status !== 'failed',
            testResults: stage.testFiles.flatMap((file, index) =>
              status === 'missing' && index === 0
                ? []
                : [
                    {
                      name: join(root, file),
                      status: status === 'failed' ? 'failed' : 'passed',
                      assertionResults: [{ fullName: 'caller-visible fixture assertion', status }],
                    },
                  ],
            ),
          }),
        );
        executions.push({
          stageId: stage.id,
          vitestReportPath: path,
          exitCode: status === 'failed' ? 1 : 0,
          startedAt: '2026-09-26T17:00:00.000Z',
          finishedAt: '2026-09-26T17:00:01.000Z',
        });
      }
      const report = await writeSimulationProofReport({
        repositoryRoot: root,
        outputDirectory: join(root, 'report'),
        executions,
      });
      expect(report.mode).toBe('Simulation');
      expect(report.continuity).toBe('IndependentFixtureProofs');
      expect(report.status).toBe(status === 'passed' ? 'Passed' : 'Blocked');
      expect(report.stages.every((stage) => stage.status === report.status)).toBe(true);
      expect(
        JSON.parse(await readFile(join(root, 'report', 'simulation-proof-report.json'), 'utf8')),
      ).toEqual(report);
      expect(report.stages.every((stage) => stage.proofSha256?.startsWith('sha256:'))).toBe(true);
      expect(await readSimulationProofReport({ outputDirectory: join(root, 'report') })).toEqual({
        kind: 'Read',
        report,
      });
      await writeFile(join(root, 'report', 'governed-promotion.vitest.json'), '{}');
      expect(await readSimulationProofReport({ outputDirectory: join(root, 'report') })).toEqual({
        kind: 'Invalid',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('does not turn an omitted stage into a completed demonstration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simulation-proof-missing-'));
  try {
    const report = await writeSimulationProofReport({
      repositoryRoot: root,
      outputDirectory: join(root, 'report'),
      executions: [],
    });
    expect(report.status).toBe('Blocked');
    expect(report.stages.every((stage) => stage.reason === 'MissingExecution')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
