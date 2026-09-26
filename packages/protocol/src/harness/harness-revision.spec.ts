import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/task-command.js';
import {
  decodeBaselineHarnessRevision,
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  identifyHarnessToolCommand,
  prepareBaselineHarnessRevision,
  type BaselineHarnessPreparationInput,
} from './harness-revision.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function preparationInput(): BaselineHarnessPreparationInput {
  const rootInstruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Repository instructions\n',
  });
  const nestedInstruction = identifyHarnessInstruction({
    path: 'src/AGENTS.md',
    content: '# Source instructions\n',
  });
  const command = identifyHarnessCompletionCommand(
    {
      id: 'public-test',
      argv: ['just', 'test-public'],
      timeoutSeconds: 120,
      expected: { kind: 'exitCode', code: 0 },
    },
    '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
  );
  if (
    rootInstruction.kind !== 'Identified' ||
    nestedInstruction.kind !== 'Identified' ||
    command.kind !== 'Identified'
  ) {
    throw new Error('Harness preparation fixture identities must be valid');
  }
  return {
    task: {
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      revisionSaid: said('a'),
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      requestedCapabilities: ['SubmitResult', 'ReadRepository', 'RunTests'],
    },
    authority: {
      personalAgentAid: said('b'),
      taskMandateSaid: said('c'),
      allowedCapabilities: ['RunTests', 'ReadRepository', 'SubmitResult'],
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      instructionResources: [nestedInstruction.resource, rootInstruction.resource],
    },
    completionCommands: [command.command],
    toolCommands: [],
    modelCompatibility: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      maximumOutputTokens: 16_384,
      thinkingLevel: 'medium',
      credentialSource: 'ANTHROPIC_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.8.0',
      gitVersion: '2.51.0',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    capabilities: {
      available: ['SubmitResult', 'RunTests', 'ReadRepository'],
      unavailable: ['EditRepository'],
    },
    budgetCeilings: {
      task: taskBudgetCeilings,
      server: taskBudgetCeilings,
      mandate: taskBudgetCeilings,
    },
  };
}

describe('baseline Harness Revision protocol', () => {
  it('produces one canonical SAID for equivalent normalized H1 inputs', () => {
    const source = preparationInput();
    const first = prepareBaselineHarnessRevision(source);
    const permuted = prepareBaselineHarnessRevision({
      ...source,
      task: {
        ...source.task,
        requestedCapabilities: [...source.task.requestedCapabilities].reverse(),
      },
      authority: {
        ...source.authority,
        allowedCapabilities: [...source.authority.allowedCapabilities].reverse(),
      },
      repository: {
        ...source.repository,
        instructionResources: [...source.repository.instructionResources].reverse(),
      },
      capabilities: {
        available: [...source.capabilities.available].reverse(),
        unavailable: [...source.capabilities.unavailable].reverse(),
      },
    });

    expect(first).toEqual(permuted);
    expect(first).toMatchObject({
      kind: 'Prepared',
      revision: {
        version: 1,
        kind: 'InitialSpecialization',
        repository: {
          instructionResources: [{ path: 'AGENTS.md' }, { path: 'src/AGENTS.md' }],
        },
        completionCommands: [
          {
            identity: 'public-test',
            executableRealpath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
          },
        ],
      },
    });
    if (first.kind !== 'Prepared') {
      throw new Error(`expected prepared H1: ${first.reason}`);
    }
    expect(first.revision.d).toMatchInlineSnapshot(
      `"EB9f2xIWk07udO6F5ZtrYGrXadrzzsWgtamSPownajPt"`,
    );
    expect(decodeBaselineHarnessRevision(first.revision)).toEqual({
      kind: 'Accepted',
      revision: first.revision,
    });
  });

  it('binds tool command capabilities and execution parameters independently of completion', () => {
    const source = preparationInput();
    const declarations = [
      {
        capability: 'RunFormatter' as const,
        id: 'format',
        argv: ['just', 'format'],
        timeoutSeconds: 30,
        expected: { kind: 'exitCode' as const, code: 0 },
      },
      {
        capability: 'RunStaticAnalysis' as const,
        id: 'analyze',
        argv: ['just', 'analyze'],
        timeoutSeconds: 45,
        expected: { kind: 'exitCode' as const, code: 0 },
      },
    ];
    const toolCommands = declarations.map((declaration) => {
      const identified = identifyHarnessToolCommand(declaration, '/usr/bin/just');
      if (identified.kind !== 'Identified') throw new Error('Expected identified command');
      return identified.command;
    });
    const capabilities = [
      ...source.task.requestedCapabilities,
      ...declarations.map((declaration) => declaration.capability),
    ];
    const prepared = prepareBaselineHarnessRevision({
      ...source,
      toolCommands,
      task: { ...source.task, requestedCapabilities: capabilities },
      authority: { ...source.authority, allowedCapabilities: capabilities },
      capabilities: { ...source.capabilities, available: capabilities },
    });
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    expect(prepared.revision.toolCommands).toEqual(toolCommands);
    expect(prepared.revision.completionCommands).toEqual(source.completionCommands);
    expect(decodeBaselineHarnessRevision(prepared.revision)).toEqual({
      kind: 'Accepted',
      revision: prepared.revision,
    });
    for (const alteration of [
      { capability: 'RunStaticAnalysis' as const },
      { identity: 'replacement' },
      { argv: ['just', 'other'] },
      { executableRealpath: '/other/just' },
      { timeoutSeconds: 31 },
      { expectedExitCode: 1 },
    ]) {
      expect(
        decodeBaselineHarnessRevision({
          ...prepared.revision,
          toolCommands: [{ ...toolCommands[0], ...alteration }, toolCommands[1]],
        }),
      ).toEqual({ kind: 'Rejected', reason: 'ToolCommandSaidMismatch' });
    }
    const reordered = prepareBaselineHarnessRevision({
      ...source,
      toolCommands: [...toolCommands].reverse(),
      task: { ...source.task, requestedCapabilities: capabilities },
      authority: { ...source.authority, allowedCapabilities: capabilities },
      capabilities: { ...source.capabilities, available: capabilities },
    });
    expect(reordered.kind).toBe('Prepared');
    if (reordered.kind !== 'Prepared') throw new Error(reordered.reason);
    expect(reordered.revision.d).not.toBe(prepared.revision.d);
  });

  it('rejects noncanonical order, changed content, and undeclared candidate fields', () => {
    const prepared = prepareBaselineHarnessRevision(preparationInput());
    if (prepared.kind !== 'Prepared') {
      throw new Error(`expected prepared H1: ${prepared.reason}`);
    }
    const noncanonical = {
      ...prepared.revision,
      repository: {
        ...prepared.revision.repository,
        instructionResources: [...prepared.revision.repository.instructionResources].reverse(),
      },
    };
    expect(decodeBaselineHarnessRevision(noncanonical)).toEqual({
      kind: 'Rejected',
      reason: 'NonCanonical',
    });

    const changed = {
      ...prepared.revision,
      modelCompatibility: {
        ...prepared.revision.modelCompatibility,
        model: 'different-model',
      },
    };
    expect(decodeBaselineHarnessRevision(changed)).toEqual({
      kind: 'Rejected',
      reason: 'SaidMismatch',
    });

    const candidateField = { ...prepared.revision, C3: { toolInventory: [] } };
    expect(decodeBaselineHarnessRevision(candidateField)).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });
});
