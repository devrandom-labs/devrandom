import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ProtectedCredentials } from '@devrandom/domain';
import {
  decodeRunProjection,
  identifyHarnessToolCommand,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
} from '@devrandom/protocol';
import {
  RunResourceBudget,
  type EvidenceObservation,
  type EvidenceRecording,
} from '@devrandom/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runProjectionFixture } from '../../../test/run-fixture.js';
import {
  ManagedWorktreeResources,
  ManagedWorktreeToolEffects,
} from '../infrastructure/managed-worktree-tools.js';
import { EvidenceRecorderProcessOutput } from '../infrastructure/process-output-evidence.js';
import { PosixExactChildCommands } from '../infrastructure/exact-child-commands.js';
import { RunWorktreeCommands } from './run-worktree-commands.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import type { PreparedRunWorktree } from './run-worktree.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function resourceBudget(
  observations: EvidenceObservation[],
  consumedAggregateSeconds = 0,
): RunResourceBudget {
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
  const run = {
    ...decoded.run,
    consumedBudget: {
      ...decoded.run.consumedBudget,
      aggregateChildCommandTimeSeconds: consumedAggregateSeconds,
    },
  };
  return new RunResourceBudget({
    run,
    evidence: {
      recordBudgetDebit(input): EvidenceRecording {
        const entries = input.debits.map((event) => ({
          occurredAt: input.occurredAt,
          producer: input.producer,
          event,
        }));
        observations.push(...entries);
        const observation = entries.at(-1);
        if (observation === undefined) return { kind: 'ObservationRejected' };
        const prepared = prepareEvidenceEvent({
          version: 1,
          sequence: observations.length - 1,
          predecessor:
            observations.length === 1
              ? { kind: 'Genesis' }
              : { kind: 'Previous', eventSaid: `E${'z'.repeat(43)}` },
          taskId: run.binding.taskId,
          taskRevisionSaid: run.binding.taskRevisionSaid,
          runId: run.binding.runId,
          incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
          harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
          personalAgentAid: run.binding.personalAgentAid,
          taskMandateSaid: run.binding.taskMandateSaid,
          occurredAt: observation.occurredAt,
          recordedAt: observation.occurredAt,
          producer: observation.producer,
          event: observation.event,
        });
        return prepared.kind === 'Prepared'
          ? { kind: 'Recorded', event: prepared.event }
          : { kind: 'ObservationRejected' };
      },
    },
    now: () => '2026-09-24T20:00:04.000Z',
  });
}

function monotonicClock(...readings: number[]): () => number {
  let last = readings[0] ?? 0;
  return () => {
    const next = readings.shift();
    if (next !== undefined) last = next;
    return last;
  };
}

describe('exact child command process boundary', () => {
  it.each(['RunFormatter', 'RunStaticAnalysis'] as const)(
    'runs declared %s through the real child, footprint and output boundaries',
    async (capability) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-declared-tool-'));
      roots.push(root);
      const directory = join(root, 'worktree');
      await mkdir(directory);
      const git = async (arguments_: readonly string[]) =>
        (await promisify(execFile)('git', arguments_, { cwd: directory })).stdout.trim();
      await git(['init', '--initial-branch=main']);
      await git(['config', 'user.name', 'Declared Tool Test']);
      await git(['config', 'user.email', 'tool@devrandom.example']);
      await writeFile(join(directory, 'input.txt'), 'before');
      await git(['add', '.']);
      await git(['commit', '-m', 'Accepted base']);
      const worktree: PreparedRunWorktree = {
        directory: await realpath(directory),
        branch: 'main',
        repository: {
          objectFormat: 'sha1',
          commit: await git(['rev-parse', 'HEAD']),
          tree: await git(['rev-parse', 'HEAD^{tree}']),
        },
      };
      const identified = identifyHarnessToolCommand(
        {
          capability,
          id: 'declared-tool',
          argv: [
            'node',
            '-e',
            'require("node:fs").writeFileSync("input.txt", "after"); process.stdout.write("command output");',
          ],
          timeoutSeconds: 5,
          expected: { kind: 'exitCode', code: 0 },
        },
        await realpath(process.execPath),
      );
      if (identified.kind !== 'Identified') throw new Error('Expected identified command');
      const observations: EvidenceObservation[] = [];
      const credentials = new ProtectedCredentials();
      const processes = new PosixExactChildCommands({
        workingDirectory: worktree.directory,
        outputRoot: join(root, 'output'),
        maximumOutputBytes: 4096,
        environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
        budget: resourceBudget(observations),
        protectedCredentials: credentials,
        monotonicNow: monotonicClock(0, 100),
      });
      const commands = new RunWorktreeCommands({
        commands: processes,
        worktree,
        limits: { changedFiles: 1, changedWorktreeBytes: 5 },
        repository: new GitWorktreeChanges(credentials),
        evidence: {
          withhold: () => ({
            kind: 'SecretDetected',
            dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
            securityViolationEventSaid: 'E'.padEnd(44, 'z'),
          }),
        },
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const stored: string[] = [];
      const artifacts = {
        storeArtifact: (input: {
          bytes: Uint8Array;
          mediaType:
            | 'application/octet-stream'
            | 'application/json'
            | 'text/plain; charset=utf-8'
            | 'text/x-diff; charset=utf-8';
        }) => {
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          if (prepared.kind !== 'Prepared') return { kind: 'ArtifactRejected' as const };
          stored.push(new TextDecoder().decode(input.bytes));
          return { kind: 'Stored' as const, artifact: prepared.artifact };
        },
      };
      const resources = new ManagedWorktreeResources({
        worktree: directory,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [identified.command],
      });
      const effects = new ManagedWorktreeToolEffects({
        resources,
        commands,
        artifacts,
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        processOutput: new EvidenceRecorderProcessOutput(
          { ...artifacts, withhold: vi.fn() },
          () => '2026-09-24T20:00:04.000Z',
        ),
        verification: { verify: vi.fn() },
      });
      const proposal = {
        piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: 'turn-0',
        toolCallId: 'call-0',
        proposalIndex: 0,
        input: { kind: capability, commandId: identified.command.identity },
      };
      const resolved = resources.resolve(proposal);
      if (resolved.kind !== 'Resolved') throw new Error('Declared tool must resolve');
      const outcome = await effects.enact(
        {
          proposal,
          tool: capability === 'RunFormatter' ? 'run_formatter' : 'run_static_analysis',
          requiredCapability: capability,
          resource: resolved.resource,
        },
        new AbortController().signal,
      );
      expect(outcome.kind).toBe('Completed');
      if (outcome.kind !== 'Completed') throw new Error('Expected completed declared tool');
      expect(outcome.summary).toContain('command output');
      expect(outcome.outputArtifactSaids).toHaveLength(2);
      expect(await readFile(join(directory, 'input.txt'), 'utf8')).toBe('after');
      expect(stored).toEqual(['command output', '']);
      expect(observations).toEqual([
        {
          producer: { kind: 'ToolGateway' },
          occurredAt: '2026-09-24T20:00:04.000Z',
          event: {
            kind: 'BudgetDebited',
            budget: 'aggregateChildCommandTimeSeconds',
            amount: 1,
            consumed: 1,
          },
        },
      ]);
    },
  );

  it.each([
    { timing: 'Before', budget: 'Files', producer: 'ToolGateway' },
    { timing: 'After', budget: 'Files', producer: 'ToolGateway' },
    { timing: 'Before', budget: 'Bytes', producer: 'PublicTaskVerifier' },
    { timing: 'After', budget: 'Bytes', producer: 'PublicTaskVerifier' },
    { timing: 'Before', budget: 'Secret', producer: 'ToolGateway' },
    { timing: 'After', budget: 'Secret', producer: 'PublicTaskVerifier' },
  ] as const)(
    'stops $producer commands on $budget footprint excess detected $timing execution',
    async ({ timing, budget: dimension, producer }) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-command-worktree-'));
      roots.push(root);
      const directory = join(root, 'worktree');
      await mkdir(directory);
      const git = async (arguments_: readonly string[]): Promise<string> => {
        const result = await promisify(execFile)('git', arguments_, { cwd: directory });
        return result.stdout.trim();
      };
      await git(['init', '--initial-branch=main']);
      await git(['config', 'user.name', 'Worktree Budget Test']);
      await git(['config', 'user.email', 'budget@devrandom.example']);
      await writeFile(join(directory, '.gitignore'), 'generated.bin\n');
      await git(['add', '.gitignore']);
      await git(['commit', '-m', 'Accepted base']);
      const worktree: PreparedRunWorktree = {
        directory: await realpath(directory),
        branch: 'main',
        repository: {
          objectFormat: 'sha1',
          commit: await git(['rev-parse', 'HEAD']),
          tree: await git(['rev-parse', 'HEAD^{tree}']),
        },
      };
      const content = dimension === 'Secret' ? 'synthetic-worktree-credential-1357924680' : '12345';
      const credentials = new ProtectedCredentials(dimension === 'Secret' ? [content] : []);
      const withhold = vi.fn(() => ({
        kind: 'SecretDetected' as const,
        dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
        securityViolationEventSaid: 'E'.padEnd(44, 'z'),
      }));
      if (timing === 'Before') await writeFile(join(directory, 'generated.bin'), content);
      const observations: EvidenceObservation[] = [];
      const budget = resourceBudget(observations);
      const processes = new PosixExactChildCommands({
        protectedCredentials: new ProtectedCredentials(),
        workingDirectory: worktree.directory,
        outputRoot: join(root, 'output'),
        maximumOutputBytes: 4_096,
        environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
        budget,
        monotonicNow: monotonicClock(0, 100),
      });
      const commands = new RunWorktreeCommands({
        commands: processes,
        worktree,
        limits: {
          changedFiles: dimension === 'Files' ? 0 : 256,
          changedWorktreeBytes: dimension === 'Bytes' ? 4 : 16 * 1024 * 1024,
        },
        repository: new GitWorktreeChanges(credentials),
        evidence: { withhold },
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const command = {
        executableRealpath: await realpath(process.execPath),
        arguments: [
          '-e',
          `require("node:fs").writeFileSync("generated.bin", ${JSON.stringify(content)}); process.stdout.write("observed");`,
        ],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: producer },
      };
      const outcome = await commands.run(command, new AbortController().signal);
      expect(outcome).toMatchObject({
        kind: timing === 'Before' ? 'WorktreeAdmissionRejected' : 'WorktreeReconciliationFailed',
        failure: dimension === 'Secret' ? 'SecretDetected' : 'BudgetExhausted',
      });
      if (outcome.kind === 'WorktreeReconciliationFailed') {
        const execution = outcome.execution;
        expect(execution.kind).toBe('Completed');
        expect(await readFile(execution.output.stdout.path, 'utf8')).toBe('observed');
        await execution.output.acknowledge();
      }
      expect(budget.snapshot().changedFiles).toBe(0);
      expect(budget.snapshot().changedWorktreeBytes).toBe(0);
      expect(budget.snapshot().aggregateChildCommandTimeSeconds).toBe(timing === 'Before' ? 0 : 1);
      // Even restoring the worktree must not reopen commands after terminal rejection.
      await rm(join(directory, 'generated.bin'));
      const marker = join(root, 'second-started');
      await expect(
        commands.run(
          {
            ...command,
            arguments: [
              '-e',
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`,
            ],
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        kind: 'WorktreeAdmissionRejected',
        failure: dimension === 'Secret' ? 'SecretDetected' : 'BudgetExhausted',
      });
      await expect(access(marker)).rejects.toThrow();
      if (dimension === 'Secret') {
        expect(withhold).toHaveBeenCalledExactlyOnceWith({
          occurredAt: '2026-09-24T20:00:04.000Z',
          producer: { kind: producer },
          disclosure: {
            kind: 'WithheldSecret',
            reason: 'Credential',
            byteLength: Buffer.byteLength(content),
          },
        });
      } else expect(withhold).not.toHaveBeenCalled();
    },
  );

  it.each([
    { stream: 'stdout', bound: 'FullOutput' },
    { stream: 'stderr', bound: 'FullOutput' },
    { stream: 'stdout', bound: 'PrefixOnly' },
  ] as const)(
    'withholds split credentials on $stream under the $bound capture bound',
    async ({ stream, bound }) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
      roots.push(root);
      const credential = 'synthetic-private-command-credential-1357924680';
      const publicOutput = 'ordinary output\n'.repeat(1_000);
      const first = credential.slice(0, 20);
      const commands = new PosixExactChildCommands({
        workingDirectory: root,
        outputRoot: join(root, 'output'),
        maximumOutputBytes:
          bound === 'PrefixOnly' ? Buffer.byteLength(publicOutput + first) : 512 * 1_024,
        environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
        protectedCredentials: new ProtectedCredentials([credential]),
        budget: resourceBudget([]),
        monotonicNow: monotonicClock(0, 100),
      });
      const pending = commands.run(
        {
          executableRealpath: await realpath(process.execPath),
          arguments: [
            '-e',
            [
              'const fs = require("node:fs");',
              `process.${stream}.write(${JSON.stringify(publicOutput + first)});`,
              'const waiting = setInterval(() => {',
              '  if (!fs.existsSync("release")) return;',
              '  clearInterval(waiting);',
              `  process.${stream}.write(${JSON.stringify(credential.slice(20))});`,
              '}, 10);',
            ].join('\n'),
          ],
          timeoutSeconds: 5,
          expectedExitCode: 0,
          budgetProducer: { kind: 'ToolGateway' },
        },
        new AbortController().signal,
      );
      try {
        let captured = '';
        await vi.waitFor(async () => {
          const [directory] = await readdir(join(root, 'output'));
          if (directory === undefined) throw new Error('capture directory is not ready');
          captured = await readFile(join(root, 'output', directory, stream), 'utf8');
          expect(captured.length).toBeGreaterThan(0);
        });
        expect(publicOutput.startsWith(captured)).toBe(true);
        await writeFile(join(root, 'release'), 'continue');
        const outcome = await pending;
        expect(outcome.kind).toBe(
          bound === 'PrefixOnly' ? 'OutputLimitExceeded' : 'SecretDetected',
        );
        if (!('output' in outcome)) throw new Error('withheld capture must retain cleanup custody');
        if (bound === 'FullOutput') {
          expect(outcome.output.disclosure).toMatchObject({
            kind: 'WithheldSecret',
            reason: 'Credential',
          });
        }
        expect(publicOutput.startsWith(await readFile(outcome.output[stream].path, 'utf8'))).toBe(
          true,
        );
      } finally {
        await writeFile(join(root, 'release'), 'continue');
        const outcome = await pending;
        if ('output' in outcome) await outcome.output.acknowledge();
      }
    },
  );

  it.each([
    { membership: 'GroupMember', elapsed: 2_500 },
    { membership: 'EscapedGroup', elapsed: 2_500 },
    { membership: 'GroupMember', elapsed: 3_500 },
  ] as const)(
    'bounds cleanup for a $membership holding output pipes with $elapsed ms charged',
    async ({ membership, elapsed }) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
      roots.push(root);
      const commands = new PosixExactChildCommands({
        protectedCredentials: new ProtectedCredentials(),
        workingDirectory: root,
        outputRoot: join(root, 'output'),
        maximumOutputBytes: 4_096,
        environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
        budget: resourceBudget([]),
        monotonicNow: monotonicClock(0, elapsed),
      });
      const cancellation = new AbortController();
      const descendant = [
        'process.on("SIGTERM", () => undefined);',
        'process.send("ready");',
        'setInterval(() => undefined, 1000);',
      ].join('\n');
      const parent = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {`,
        `  detached: ${String(membership === 'EscapedGroup')},`,
        '  stdio: ["ignore", 1, 2, "ipc"]',
        '});',
        'require("node:fs").writeFileSync("descendant-pid", String(child.pid));',
        'child.once("message", () => { child.disconnect(); child.unref(); process.exit(0); });',
      ].join('\n');
      const pending = commands.run(
        {
          executableRealpath: await realpath(process.execPath),
          arguments: ['-e', parent],
          timeoutSeconds: 1,
          expectedExitCode: 0,
          budgetProducer: { kind: 'ToolGateway' },
        },
        cancellation.signal,
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
              reject(new Error('command cleanup exceeded its bound'));
            }, 4_500);
          }),
        ]);
        expect(outcome.kind).toBe(
          membership === 'GroupMember' ? 'ProcessGroupSurvived' : 'ProcessCleanupUnconfirmed',
        );
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        cancellation.abort();
        const pid = Number(await readFile(join(root, 'descendant-pid'), 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // A descendant already terminated by the command adapter needs no cleanup.
          }
        }
        const outcome = await pending;
        if ('output' in outcome) await outcome.output.acknowledge();
      }
    },
    10_000,
  );

  it.each(['BeforeInvocation', 'DuringPreparation'] as const)(
    'does not start or create output for a command aborted %s',
    async (timing) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
      roots.push(root);
      const observations: EvidenceObservation[] = [];
      const budget = resourceBudget(observations);
      const commands = new PosixExactChildCommands({
        protectedCredentials: new ProtectedCredentials(),
        workingDirectory: root,
        outputRoot: join(root, 'output'),
        maximumOutputBytes: 4_096,
        environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
        budget,
        monotonicNow: monotonicClock(1_000, 2_000),
      });
      const cancellation = new AbortController();
      const executableRealpath = await realpath(process.execPath);
      if (timing === 'BeforeInvocation') cancellation.abort();
      const pending = commands.run(
        {
          executableRealpath,
          arguments: ['-e', 'require("node:fs").writeFileSync("started", "unexpected")'],
          timeoutSeconds: 5,
          expectedExitCode: 0,
          budgetProducer: { kind: 'ToolGateway' },
        },
        cancellation.signal,
      );
      if (timing === 'DuringPreparation') cancellation.abort();

      expect(await pending).toEqual({ kind: 'AbortedBeforeStart' });
      await expect(access(join(root, 'started'))).rejects.toThrow();
      await expect(access(join(root, 'output'))).rejects.toThrow();
      expect(observations).toEqual([]);
      expect(budget.snapshot().aggregateChildCommandTimeSeconds).toBe(0);
    },
  );

  it('limits the combined stdout and stderr retained by one command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
    roots.push(root);
    const commands = new PosixExactChildCommands({
      protectedCredentials: new ProtectedCredentials(),
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget: resourceBudget([]),
      monotonicNow: monotonicClock(1_000, 1_025),
    });
    const outcome = await commands.run(
      {
        executableRealpath: await realpath(process.execPath),
        arguments: [
          '-e',
          'process.stdout.write("a".repeat(3000)); process.stderr.write("b".repeat(3000))',
        ],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('OutputLimitExceeded');
    if (outcome.kind !== 'OutputLimitExceeded') throw new Error('combined output must be limited');
    const stdout = await readFile(outcome.output.stdout.path);
    const stderr = await readFile(outcome.output.stderr.path);
    expect(stdout.byteLength + stderr.byteLength).toBeLessThanOrEqual(4_096);
    expect(outcome.output.stdout.byteLength).toBe(stdout.byteLength);
    expect(outcome.output.stderr.byteLength).toBe(stderr.byteLength);
    await expect(outcome.output.acknowledge()).resolves.toEqual({ kind: 'Cleaned' });
  });

  it('spawns only the exact realpath and retains bounded output until acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
    roots.push(root);
    const executableRealpath = await realpath(process.execPath);
    const observations: EvidenceObservation[] = [];
    const budget = resourceBudget(observations);
    const commands = new PosixExactChildCommands({
      protectedCredentials: new ProtectedCredentials(),
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget,
      monotonicNow: monotonicClock(1_000, 2_250),
    });

    const outcome = await commands.run(
      {
        executableRealpath,
        arguments: [
          '-e',
          'process.stdout.write("public\\n"); process.stderr.write("diagnostic\\n")',
        ],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: 'PublicTaskVerifier' },
      },
      new AbortController().signal,
    );

    expect(outcome.kind).toBe('Completed');
    if (outcome.kind !== 'Completed') throw new Error('fixture command must complete');
    expect(await readFile(outcome.output.stdout.path, 'utf8')).toBe('public\n');
    expect(await readFile(outcome.output.stderr.path, 'utf8')).toBe('diagnostic\n');
    expect(outcome.output.stdout.byteLength).toBe(7);
    expect(outcome.output.stderr.byteLength).toBe(11);
    expect(outcome.elapsedMilliseconds).toBe(1_250);
    expect(budget.snapshot().aggregateChildCommandTimeSeconds).toBe(2);
    expect(observations.map(({ event }) => event)).toEqual([
      {
        kind: 'BudgetDebited',
        budget: 'aggregateChildCommandTimeSeconds',
        amount: 2,
        consumed: 2,
      },
    ]);
    await expect(outcome.output.acknowledge()).resolves.toEqual({ kind: 'Cleaned' });
    await expect(access(outcome.output.stdout.path)).rejects.toThrow();
    await expect(outcome.output.acknowledge()).resolves.toEqual({ kind: 'AlreadyCleaned' });
  });

  it('never searches PATH for an unavailable executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
    roots.push(root);
    const commands = new PosixExactChildCommands({
      protectedCredentials: new ProtectedCredentials(),
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget: resourceBudget([]),
      monotonicNow: monotonicClock(1_000),
    });

    await expect(
      commands.run(
        {
          executableRealpath: '/definitely-not-a-real-executable',
          arguments: [],
          timeoutSeconds: 5,
          expectedExitCode: 0,
          budgetProducer: { kind: 'ToolGateway' },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'ExecutableUnavailable' });
  });

  it('terminates the child process group when supervision is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
    roots.push(root);
    const commands = new PosixExactChildCommands({
      protectedCredentials: new ProtectedCredentials(),
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget: resourceBudget([]),
      monotonicNow: monotonicClock(1_000, 1_025),
    });
    const cancellation = new AbortController();
    const pending = commands.run(
      {
        executableRealpath: await realpath(process.execPath),
        arguments: ['-e', 'setInterval(() => undefined, 1000)'],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      cancellation.signal,
    );
    setTimeout(() => {
      cancellation.abort();
    }, 25);

    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'Aborted' });
    if (outcome.kind === 'Aborted') {
      await expect(outcome.output.acknowledge()).resolves.toEqual({ kind: 'Cleaned' });
    }
  });

  it('does not start a child whose conservative time reservation exceeds the Run budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-child-command-'));
    roots.push(root);
    const marker = join(root, 'started');
    const decoded = decodeRunProjection(runProjectionFixture());
    if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
    const budget = resourceBudget(
      [],
      decoded.run.binding.budget.aggregateChildCommandTimeSeconds - 1,
    );
    const commands = new PosixExactChildCommands({
      protectedCredentials: new ProtectedCredentials(),
      workingDirectory: root,
      outputRoot: join(root, 'output'),
      maximumOutputBytes: 4_096,
      environment: { path: '/usr/bin:/bin', temporaryDirectory: root, language: 'C' },
      budget,
      monotonicNow: monotonicClock(1_000),
    });

    const outcome = await commands.run(
      {
        executableRealpath: await realpath(process.execPath),
        arguments: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
        timeoutSeconds: 5,
        expectedExitCode: 0,
        budgetProducer: { kind: 'PublicTaskVerifier' },
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'BudgetExhausted' });
    await expect(access(marker)).rejects.toThrow();
    expect(budget.snapshot().aggregateChildCommandTimeSeconds).toBe(
      decoded.run.binding.budget.aggregateChildCommandTimeSeconds - 1,
    );
  });
});
