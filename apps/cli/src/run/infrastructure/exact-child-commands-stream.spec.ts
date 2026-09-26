import type * as NodeFileSystem from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtectedCredentials } from '@devrandom/domain';
import { decodeRunProjection, prepareEvidenceEvent } from '@devrandom/protocol';
import { RunResourceBudget } from '@devrandom/runtime';
import { afterEach, expect, it, vi } from 'vitest';

import { runProjectionFixture } from '../../../test/run-fixture.js';
import { PosixExactChildCommands } from './exact-child-commands.js';

const failingStream = vi.hoisted(() => ({ name: undefined as 'stdout' | 'stderr' | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFileSystem>();
  return {
    ...fs,
    createWriteStream: (...arguments_: Parameters<typeof NodeFileSystem.createWriteStream>) => {
      const stream = fs.createWriteStream(...arguments_);
      const destination = failingStream.name;
      if (
        destination !== undefined &&
        typeof arguments_[0] === 'string' &&
        arguments_[0].endsWith(`/${destination}`)
      ) {
        const write = stream.write.bind(stream);
        stream.write = ((...bytes: Parameters<typeof stream.write>) => {
          const accepted = write(...bytes);
          queueMicrotask(() => stream.destroy(new Error('injected capture write failure')));
          return accepted;
        }) as typeof stream.write;
      }
      return stream;
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  failingStream.name = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(['stdout', 'stderr'] as const)(
  'settles and cleans a real child when %s capture fails',
  async (stream) => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-capture-failure-'));
    roots.push(root);
    const decoded = decodeRunProjection(runProjectionFixture());
    if (decoded.kind !== 'Accepted') throw new Error('expected accepted Run fixture');
    const run = decoded.run;
    const budget = new RunResourceBudget({
      run,
      evidence: {
        recordBudgetDebit(input) {
          const debit = input.debits[0];
          if (debit === undefined) return { kind: 'ObservationRejected' };
          const event = prepareEvidenceEvent({
            version: 1,
            sequence: 0,
            predecessor: { kind: 'Genesis' },
            taskId: run.binding.taskId,
            taskRevisionSaid: run.binding.taskRevisionSaid,
            runId: run.binding.runId,
            incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
            harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
            personalAgentAid: run.binding.personalAgentAid,
            taskMandateSaid: run.binding.taskMandateSaid,
            occurredAt: input.occurredAt,
            recordedAt: input.occurredAt,
            producer: input.producer,
            event: debit,
          });
          return event.kind === 'Prepared'
            ? { kind: 'Recorded', event: event.event }
            : { kind: 'ObservationRejected' };
        },
      },
      now: () => '2026-09-25T20:00:00.000Z',
    });
    const commit = vi.spyOn(budget, 'commit');
    let clockReads = 0;
    const child = new PosixExactChildCommands({
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget,
      protectedCredentials: new ProtectedCredentials(),
      monotonicNow: () => (clockReads++ === 0 ? 1_000 : 2_000),
    });
    failingStream.name = stream;

    const startedAt = performance.now();
    const outcome = await child.run(
      {
        executableRealpath: await realpath(process.execPath),
        arguments: [
          '-e',
          'process.stdout.write("o".repeat(512)); process.stderr.write("e".repeat(512)); setTimeout(() => {}, 10_000);',
        ],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'DependencyUnavailable' });
    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().aggregateChildCommandTimeSeconds).toBe(1);
    expect(await readdir(join(root, 'output'))).toEqual([]);
  },
  15_000,
);
