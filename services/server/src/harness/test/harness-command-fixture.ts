import type { TaskToolCapability } from '@devrandom/domain';

import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  identifyHarnessToolCommand,
  prepareBaselineHarnessRevision,
  taskBudgetCeilings,
  type AdmitBaselineHarnessBody,
  type TaskProjection,
} from '@devrandom/protocol';

import { taskCommandFixture, taskOwnerAid } from '../../task/test/task-command-fixture.js';

export const harnessTaskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
export const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
export const harnessPersonalAgentAid = `E${'c'.repeat(43)}`;
export const harnessTaskMandateSaid = `E${'d'.repeat(43)}`;
export const harnessCommandId = '11111111-2222-4333-8444-555555555555';
const taskCommand = taskCommandFixture('2026-09-24T14:00:00.000Z');

export const harnessTask: TaskProjection = {
  version: 1,
  taskId: harnessTaskId,
  ownerAid: taskOwnerAid,
  label: taskCommand.label,
  harnessLineageId,
  revisionSaid: taskCommand.revision.d,
  revision: taskCommand.revision,
  lifecycle: { kind: 'Open' },
  commandId: taskCommand.commandId,
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0,
};

export function baselineHarnessCommandFixture(
  commandId = harnessCommandId,
  model = 'claude-sonnet-4-5',
  selectedTask: TaskProjection = harnessTask,
): AdmitBaselineHarnessBody {
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Task repository rules\n',
  });
  const completion = selectedTask.revision.completionConditions.map((condition) =>
    identifyHarnessCompletionCommand(
      condition,
      '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
    ),
  );
  if (
    instruction.kind !== 'Identified' ||
    completion.some((identified) => identified.kind !== 'Identified')
  ) {
    throw new Error('Harness fixture inputs must be identifiable');
  }
  const completionCommands = completion.flatMap((identified) =>
    identified.kind === 'Identified' ? [identified.command] : [],
  );
  const toolCapabilities = selectedTask.revision.requestedCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
  const unavailableToolCapabilities = selectedTask.revision.unavailableCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
  const prepared = prepareBaselineHarnessRevision({
    toolCommands: (selectedTask.revision.toolCommands ?? []).map((declaration) => {
      const identified = identifyHarnessToolCommand(declaration, '/usr/bin/just');
      if (identified.kind !== 'Identified') throw new Error('Expected identified tool command');
      return identified.command;
    }),
    task: {
      taskId: harnessTaskId,
      revisionSaid: selectedTask.revisionSaid,
      harnessLineageId,
      requestedCapabilities: toolCapabilities,
    },
    authority: {
      personalAgentAid: harnessPersonalAgentAid,
      taskMandateSaid: harnessTaskMandateSaid,
      allowedCapabilities: toolCapabilities,
    },
    repository: {
      ...selectedTask.revision.repository,
      instructionResources: [instruction.resource],
    },
    completionCommands,
    modelCompatibility: {
      provider: 'anthropic',
      model,
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
      available: toolCapabilities,
      unavailable: unavailableToolCapabilities,
    },
    budgetCeilings: {
      task: selectedTask.revision.budgets,
      server: taskBudgetCeilings,
      mandate: selectedTask.revision.budgets,
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`Harness fixture must prepare: ${prepared.reason}`);
  }
  return { version: 1, commandId, revision: prepared.revision };
}
