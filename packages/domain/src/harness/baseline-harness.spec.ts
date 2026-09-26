import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import {
  baselineHarnessServerBudgetCeilings,
  deriveBaselineHarness,
  type BaselineHarnessDerivationInput,
} from './baseline-harness.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function derivationInput(): BaselineHarnessDerivationInput {
  return {
    template: {
      identity: 'coding.default',
      version: 1,
      contentSaid: said('a'),
    },
    task: {
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      revisionSaid: said('b'),
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      requestedCapabilities: ['SubmitResult', 'ReadRepository', 'RunTests'],
    },
    authority: {
      personalAgentAid: said('c'),
      taskMandateSaid: said('d'),
      allowedCapabilities: ['RunTests', 'ReadRepository', 'SubmitResult'],
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      instructionResources: [
        { path: 'src/AGENTS.md', contentSaid: said('f') },
        { path: 'AGENTS.md', contentSaid: said('e') },
      ],
    },
    reviewedResources: [
      {
        kind: 'Workflow',
        identity: 'repository-change',
        version: 1,
        contentSaid: said('g'),
      },
      {
        kind: 'Skill',
        identity: 'compatibility-recovery',
        version: 1,
        contentSaid: said('h'),
      },
    ],
    orchestrationPolicy: {
      identity: 'single-pi-executor',
      version: 1,
      contentSaid: said('i'),
    },
    contextSelectionPolicy: {
      identity: 'task-repository-context',
      version: 1,
      contentSaid: said('j'),
    },
    toolCatalogue: [
      {
        identity: 'submit_result',
        version: 1,
        contentSaid: said('m'),
        requiredCapability: 'SubmitResult',
      },
      {
        identity: 'read_file',
        version: 1,
        contentSaid: said('k'),
        requiredCapability: 'ReadRepository',
      },
      {
        identity: 'run_tests',
        version: 1,
        contentSaid: said('l'),
        requiredCapability: 'RunTests',
      },
    ],
    toolCommands: [],
    completionCommands: [
      {
        identity: 'public-test',
        contentSaid: said('n'),
        executableRealpath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
        argv: ['just', 'test-public'],
        timeoutSeconds: 120,
        expectedExitCode: 0,
      },
    ],
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
      xstateVersion: '5.22.0',
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
    policies: {
      derivation: {
        identity: 'h1-derivation',
        version: 1,
        contentSaid: said('o'),
      },
      redaction: {
        identity: 'credential-redaction',
        version: 1,
        contentSaid: said('p'),
      },
      toolGateway: {
        identity: 'sequential-tool-gateway',
        version: 1,
        contentSaid: said('q'),
      },
      evidence: {
        identity: 'ordered-evidence-chain',
        version: 1,
        contentSaid: said('r'),
      },
      verifier: {
        identity: 'public-task-verifier',
        version: 1,
        contentSaid: said('s'),
      },
    },
  };
}

function toolCommandInput(): BaselineHarnessDerivationInput {
  const input = derivationInput();
  const capabilities = ['RunFormatter', 'RunStaticAnalysis'] as const;
  return {
    ...input,
    task: {
      ...input.task,
      requestedCapabilities: [...input.task.requestedCapabilities, ...capabilities],
    },
    authority: {
      ...input.authority,
      allowedCapabilities: [...input.authority.allowedCapabilities, ...capabilities],
    },
    capabilities: {
      ...input.capabilities,
      available: [...input.capabilities.available, ...capabilities],
    },
    toolCatalogue: [
      ...input.toolCatalogue,
      ...capabilities.map((capability, index) => ({
        identity: capability === 'RunFormatter' ? 'run_formatter' : 'run_static_analysis',
        version: 1,
        contentSaid: said(String(index)),
        requiredCapability: capability,
      })),
    ],
    toolCommands: capabilities.map((capability) => ({
      capability,
      identity: capability === 'RunFormatter' ? 'format' : 'analyze',
      contentSaid: said('u'),
      executableRealpath: '/usr/bin/just',
      argv: ['just', capability === 'RunFormatter' ? 'format' : 'lint'],
      timeoutSeconds: 120,
      expectedExitCode: 0,
    })),
  };
}

describe('baseline Harness derivation', () => {
  it('retains capability-bound tool commands separately from completion commands', () => {
    const input = toolCommandInput();
    const outcome = deriveBaselineHarness(input);
    expect(outcome.kind).toBe('Derived');
    if (outcome.kind !== 'Derived') throw new Error('declared tool bindings must derive');
    expect(outcome.manifest.toolCommands).toEqual(input.toolCommands);
    expect(outcome.manifest.completionCommands).toEqual(input.completionCommands);
    expect(outcome.manifest.toolCommands).not.toBe(input.toolCommands);
  });

  it.each(['Duplicate', 'CompletionCollision', 'Missing', 'Unrequested'] as const)(
    'rejects unlawful tool-command binding: %s',
    (mutation) => {
      const input = toolCommandInput();
      const formatter = input.toolCommands[0];
      if (formatter === undefined) throw new Error('formatter fixture required');
      const outcome = deriveBaselineHarness({
        ...input,
        task:
          mutation === 'Unrequested'
            ? {
                ...input.task,
                requestedCapabilities: input.task.requestedCapabilities.filter(
                  (capability) => capability !== 'RunFormatter',
                ),
              }
            : input.task,
        toolCommands:
          mutation === 'Duplicate'
            ? [...input.toolCommands, formatter]
            : mutation === 'CompletionCollision'
              ? [...input.toolCommands, { ...formatter, identity: 'public-test' }]
              : mutation === 'Missing'
                ? [formatter]
                : input.toolCommands,
      });
      expect(outcome).toEqual(
        mutation === 'Missing'
          ? { kind: 'Rejected', reason: 'MissingToolCommand', capability: 'RunStaticAnalysis' }
          : mutation === 'Unrequested'
            ? {
                kind: 'Rejected',
                reason: 'ToolCommandCapabilityMismatch',
                capability: 'RunFormatter',
              }
            : { kind: 'Rejected', reason: 'DuplicateToolCommand' },
      );
    },
  );

  it('normalizes directory-derived resources and semantic sets without changing ordered selections', () => {
    const first = deriveBaselineHarness(derivationInput());
    const source = derivationInput();
    const reordered: BaselineHarnessDerivationInput = {
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
      toolCatalogue: [...source.toolCatalogue].reverse(),
      capabilities: {
        ...source.capabilities,
        available: [...source.capabilities.available].reverse(),
      },
    };

    const second = deriveBaselineHarness(reordered);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'Derived',
      manifest: {
        kind: 'InitialSpecialization',
        repository: {
          instructionResources: [{ path: 'AGENTS.md' }, { path: 'src/AGENTS.md' }],
        },
        reviewedResources: [
          { kind: 'Workflow', identity: 'repository-change' },
          { kind: 'Skill', identity: 'compatibility-recovery' },
        ],
        activeTools: [
          { identity: 'read_file' },
          { identity: 'run_tests' },
          { identity: 'submit_result' },
        ],
      },
    });
  });

  it('rejects an active capability that is locally unavailable or outside Task Mandate authority', () => {
    const unavailableSource = derivationInput();
    const unavailable: BaselineHarnessDerivationInput = {
      ...unavailableSource,
      capabilities: {
        available: ['ReadRepository', 'SubmitResult'],
        unavailable: ['EditRepository', 'RunTests'],
      },
    };
    expect(deriveBaselineHarness(unavailable)).toEqual({
      kind: 'Rejected',
      reason: 'RequestedCapabilityUnavailable',
      capability: 'RunTests',
    });

    const unauthorizedSource = derivationInput();
    const unauthorized: BaselineHarnessDerivationInput = {
      ...unauthorizedSource,
      authority: {
        ...unauthorizedSource.authority,
        allowedCapabilities: ['ReadRepository', 'RunTests'],
      },
    };
    expect(deriveBaselineHarness(unauthorized)).toEqual({
      kind: 'Rejected',
      reason: 'RequestedCapabilityUnauthorized',
      capability: 'SubmitResult',
    });
  });
});

it('preserves old v1/v2 H1 server ceilings and raises only explicitly requested v2 Run quota', () => {
  for (const version of [1, 2] as const) {
    expect(
      baselineHarnessServerBudgetCeilings({ version, budgets: { runsPerAdmittedUser: 6 } }),
    ).toBe(taskBudgetCeilings);
  }
  expect(
    baselineHarnessServerBudgetCeilings({ version: 1, budgets: { runsPerAdmittedUser: 8 } }),
  ).toBe(taskBudgetCeilings);
  const expanded = baselineHarnessServerBudgetCeilings({
    version: 2,
    budgets: { runsPerAdmittedUser: 8 },
  });
  expect(expanded).toEqual({ ...taskBudgetCeilings, runsPerAdmittedUser: 8 });
  expect(Object.isFrozen(expanded)).toBe(true);
});
