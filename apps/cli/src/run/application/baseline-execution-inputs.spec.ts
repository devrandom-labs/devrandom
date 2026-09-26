import { prepareTaskCommand } from '@devrandom/protocol';
import { ProtectedCredentials } from '@devrandom/domain';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import {
  preparedRepositoryFixture,
  taskSourceFixture,
  taskProjectionFixture,
} from '../../../test/task-source-fixture.js';
import type { PreparedRunWorktree } from './run-worktree.js';
import {
  BaselineExecutionInputMaterializer,
  type ManagedWorktreeInstructions,
} from './baseline-execution-inputs.js';

const instructionContent = '# Task repository rules\n';

function worktree(): PreparedRunWorktree {
  const task = taskProjectionFixture();
  return {
    directory: '/state/runs/1cc482f1-98e9-4454-8e4c-5566cb47ce3d/worktree',
    branch: 'devrandom/run/1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    repository: task.revision.repository,
  };
}

describe('baseline execution input materialization', () => {
  it.each(['InstructionContent', 'InstructionErrorPath', 'TaskObjective', 'ManifestPath'] as const)(
    'withholds protected %s before identification or returning input details',
    async (location) => {
      const secret = 'opaque-materialization-fixture-57382';
      const task = taskProjectionFixture();
      const harness = baselineHarnessCommandFixture().revision;
      const inspect = vi.fn<ManagedWorktreeInstructions['inspect']>(() =>
        Promise.resolve(
          location === 'InstructionErrorPath'
            ? { kind: 'InstructionUnavailable', path: `${secret}/AGENTS.md` }
            : {
                kind: 'Inspected',
                instructions: [
                  {
                    path: 'AGENTS.md',
                    content: location === 'InstructionContent' ? secret : instructionContent,
                  },
                ],
              },
        ),
      );
      const materializer = new BaselineExecutionInputMaterializer({
        instructions: { inspect },
        protectedCredentials: new ProtectedCredentials([secret]),
      });
      const outcome = await materializer.materialize(
        {
          task:
            location === 'TaskObjective'
              ? { ...task, revision: { ...task.revision, objective: secret } }
              : task,
          harness:
            location === 'ManifestPath'
              ? {
                  ...harness,
                  repository: {
                    ...harness.repository,
                    instructionResources: [
                      {
                        path: `${secret}/AGENTS.md`,
                        contentSaid: harness.d,
                      },
                    ],
                  },
                }
              : harness,
          worktree: worktree(),
        },
        new AbortController().signal,
      );

      expect(outcome).toEqual({ kind: 'SecretDetected' });
      expect(inspect).toHaveBeenCalledTimes(
        location === 'TaskObjective' || location === 'ManifestPath' ? 0 : 1,
      );
    },
  );

  it.each(['BeforeInspection', 'DuringInspection'] as const)(
    'does not materialize inputs when cancelled %s',
    async (phase) => {
      const cancellation = new AbortController();
      if (phase === 'BeforeInspection') cancellation.abort();
      const inspect = vi.fn<ManagedWorktreeInstructions['inspect']>(() => {
        cancellation.abort();
        return Promise.resolve({
          kind: 'Inspected',
          instructions: [{ path: 'AGENTS.md', content: instructionContent }],
        });
      });
      const materializer = new BaselineExecutionInputMaterializer({
        protectedCredentials: new ProtectedCredentials(),
        instructions: { inspect },
      });
      await expect(
        materializer.materialize(
          {
            task: taskProjectionFixture(),
            harness: baselineHarnessCommandFixture().revision,
            worktree: worktree(),
          },
          cancellation.signal,
        ),
      ).resolves.toEqual({ kind: 'Interrupted' });
      expect(inspect).toHaveBeenCalledTimes(phase === 'BeforeInspection' ? 0 : 1);
    },
  );
  it('materializes exact H1 instructions and one deterministic closed Task prompt', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const inspect = vi.fn<ManagedWorktreeInstructions['inspect']>(() =>
      Promise.resolve({
        kind: 'Inspected',
        instructions: [{ path: 'AGENTS.md', content: instructionContent }],
      }),
    );
    const materializer = new BaselineExecutionInputMaterializer({
      protectedCredentials: new ProtectedCredentials(),
      instructions: { inspect },
    });

    const first = await materializer.materialize(
      { task, harness, worktree: worktree() },
      new AbortController().signal,
    );
    const second = await materializer.materialize(
      { task, harness, worktree: worktree() },
      new AbortController().signal,
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      kind: 'Materialized',
      inputs: {
        worktree: '/state/runs/1cc482f1-98e9-4454-8e4c-5566cb47ce3d/worktree',
        harness,
        instructions: [{ path: 'AGENTS.md', content: instructionContent }],
        prompt: [
          'Devrandom baseline Task',
          `Task ID: ${task.taskId}`,
          `Task Revision SAID: ${task.revisionSaid}`,
          `Title: ${JSON.stringify(task.revision.title)}`,
          `Objective: ${JSON.stringify(task.revision.objective)}`,
          'Deliverables (ordered):',
          '1. repositoryFile id="parser" path="src/parser.ts"',
          'Completion conditions (ordered; executed by the parent verifier):',
          '1. id="public-test" argv=["just","test-public"] timeoutSeconds=120 expectedExitCode=0',
          'Constraints:',
          'dataPolicy="RepositoryContentOnly"',
          'protectedPaths=["secrets/local.json"]',
          'prohibitedEffects=["CredentialAccess"]',
          'Work only inside the managed worktree. Use only the provided tools. Report completion with submit_result; the parent verifier, not model prose, determines acceptance.',
          'After your first focused code change, call submit_result with the current work even if a public check still fails. The trusted verifier runs the completion conditions and returns feedback; revise and resubmit if rejected while the Run budget permits. Submit only locally recorded output artifact SAIDs, or [] if none.',
        ].join('\n'),
      },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenNthCalledWith(
      1,
      {
        worktree: worktree(),
        expectedPaths: ['AGENTS.md'],
      },
      expect.any(AbortSignal),
    );
  });

  it('names each declared command and its matching tool separately from completion conditions', async () => {
    const source = taskSourceFixture();
    const prepared = prepareTaskCommand(
      {
        ...source,
        requestedCapabilities: [
          ...source.requestedCapabilities,
          'RunFormatter',
          'RunStaticAnalysis',
        ],
        toolCommands: [
          {
            capability: 'RunFormatter',
            id: 'format',
            argv: ['just', 'format'],
            timeoutSeconds: 30,
            expected: { kind: 'exitCode', code: 0 },
          },
          {
            capability: 'RunStaticAnalysis',
            id: 'analyze',
            argv: ['just', 'analyze'],
            timeoutSeconds: 45,
            expected: { kind: 'exitCode', code: 0 },
          },
        ],
      },
      '11111111-2222-4333-8444-555555555555',
      preparedRepositoryFixture,
    );
    if (prepared.kind !== 'Prepared') throw new Error('Expected prepared Task');
    const task = taskProjectionFixture(prepared.command);
    const harness = baselineHarnessCommandFixture(task).revision;
    const materializer = new BaselineExecutionInputMaterializer({
      protectedCredentials: new ProtectedCredentials(),
      instructions: {
        inspect: () =>
          Promise.resolve({
            kind: 'Inspected',
            instructions: [{ path: 'AGENTS.md', content: instructionContent }],
          }),
      },
    });
    const outcome = await materializer.materialize(
      { task, harness, worktree: worktree() },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('Materialized');
    if (outcome.kind !== 'Materialized') throw new Error('Expected materialized input');
    expect(outcome.inputs.prompt).toContain(
      '1. tool=run_formatter id="format" argv=["just","format"] timeoutSeconds=30 expectedExitCode=0',
    );
    expect(outcome.inputs.prompt).toContain(
      '2. tool=run_static_analysis id="analyze" argv=["just","analyze"] timeoutSeconds=45 expectedExitCode=0',
    );
    expect(outcome.inputs.prompt).toContain(
      'Declared tool commands (ordered; separate from completion conditions):',
    );
  });

  it('fails closed before filesystem inspection when Task, H1, and worktree bindings differ', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const inspect = vi.fn<ManagedWorktreeInstructions['inspect']>();
    const materializer = new BaselineExecutionInputMaterializer({
      protectedCredentials: new ProtectedCredentials(),
      instructions: { inspect },
    });

    await expect(
      materializer.materialize(
        {
          task,
          harness,
          worktree: {
            ...worktree(),
            repository: { ...worktree().repository, tree: '3'.repeat(40) },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'BindingRejected' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects missing, extra, changed, and unsafe instruction resources', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const cases = [
      {
        inspection: { kind: 'InventoryMismatch' } as const,
        expected: { kind: 'InstructionInventoryMismatch' } as const,
      },
      {
        inspection: { kind: 'UnsafeInstructionPath', path: 'AGENTS.md' } as const,
        expected: { kind: 'UnsafeInstructionPath', path: 'AGENTS.md' } as const,
      },
      {
        inspection: {
          kind: 'Inspected',
          instructions: [{ path: 'AGENTS.md', content: '# Changed\n' }],
        } as const,
        expected: { kind: 'InstructionContentMismatch', path: 'AGENTS.md' } as const,
      },
    ];

    for (const testCase of cases) {
      const materializer = new BaselineExecutionInputMaterializer({
        protectedCredentials: new ProtectedCredentials(),
        instructions: { inspect: () => Promise.resolve(testCase.inspection) },
      });
      await expect(
        materializer.materialize(
          { task, harness, worktree: worktree() },
          new AbortController().signal,
        ),
      ).resolves.toEqual(testCase.expected);
    }
  });
});
