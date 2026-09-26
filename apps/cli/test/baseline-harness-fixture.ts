import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  identifyHarnessToolCommand,
  prepareBaselineHarnessRevision,
  taskBudgetCeilings,
  type AdmitBaselineHarnessBody,
} from '@devrandom/protocol';

import { taskProjectionFixture } from './task-source-fixture.js';

export const harnessPersonalAgentAid = `E${'c'.repeat(43)}`;
export const harnessTaskMandateSaid = `E${'d'.repeat(43)}`;
export const harnessCommandId = '11111111-2222-4333-8444-555555555555';

export function baselineHarnessCommandFixture(
  task = taskProjectionFixture(),
): AdmitBaselineHarnessBody {
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Task repository rules\n',
  });
  const completions = task.revision.completionConditions.map((condition) =>
    identifyHarnessCompletionCommand(
      condition,
      '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
    ),
  );
  if (
    instruction.kind !== 'Identified' ||
    completions.some((completion) => completion.kind !== 'Identified')
  ) {
    throw new Error('baseline harness fixture inputs must be identifiable');
  }
  const prepared = prepareBaselineHarnessRevision({
    toolCommands: (task.revision.toolCommands ?? []).map((declaration) => {
      const identified = identifyHarnessToolCommand(declaration, '/usr/bin/just');
      if (identified.kind !== 'Identified') throw new Error('Expected identified tool command');
      return identified.command;
    }),
    task: {
      taskId: task.taskId,
      revisionSaid: task.revisionSaid,
      harnessLineageId: task.harnessLineageId,
      requestedCapabilities: task.revision.requestedCapabilities,
    },
    authority: {
      personalAgentAid: harnessPersonalAgentAid,
      taskMandateSaid: harnessTaskMandateSaid,
      allowedCapabilities: task.revision.requestedCapabilities,
    },
    repository: {
      ...task.revision.repository,
      instructionResources: [instruction.resource],
    },
    completionCommands: completions.flatMap((completion) =>
      completion.kind === 'Identified' ? [completion.command] : [],
    ),
    modelCompatibility: {
      provider: 'deepseek',
      model: 'deepseek-flash',
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 8_192,
      thinkingLevel: 'low',
      credentialSource: 'DEEPSEEK_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'darwin',
      architecture: 'arm64',
      nodeVersion: '24.20.0',
      gitVersion: '2.51.0',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    capabilities: {
      available: task.revision.requestedCapabilities,
      unavailable: task.revision.unavailableCapabilities,
    },
    budgetCeilings: {
      task: task.revision.budgets,
      server: taskBudgetCeilings,
      mandate: task.revision.budgets,
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`baseline harness fixture rejected: ${prepared.reason}`);
  }
  return { version: 1, commandId: harnessCommandId, revision: prepared.revision };
}
