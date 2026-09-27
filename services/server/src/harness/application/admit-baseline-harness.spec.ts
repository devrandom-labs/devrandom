import { describe, expect, it, vi } from 'vitest';

import {
  ProtectedCredentials,
  verifyTaskMandate,
  type CurrentTaskMandate,
  type TaskToolCapability,
} from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  identifyHarnessToolCommand,
  type BaselineHarnessPreparationInput,
  prepareBaselineHarnessRevision,
  prepareTaskCommandV2,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';

import type { CurrentTaskMandateAuthorization } from '../../mandate/application/current-task-mandate.js';
import { taskCommandFixture, taskOwnerAid } from '../../task/test/task-command-fixture.js';
import {
  admitBaselineHarness,
  type AdmitBaselineHarnessDependencies,
} from './admit-baseline-harness.js';

const userCredentialSaid = `E${'b'.repeat(43)}`;
const personalAgentAid = `E${'c'.repeat(43)}`;
const taskMandateSaid = `E${'d'.repeat(43)}`;
const taskMandateAttributeSaid = `E${'e'.repeat(43)}`;
const registryId = `E${'f'.repeat(43)}`;
const issuerAnchorSaid = `E${'g'.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const commandId = '11111111-2222-4333-8444-555555555555';
const observedAt = '2026-09-24T12:30:00.000Z';
const taskCommand = taskCommandFixture('2026-09-24T14:00:00.000Z');
const task = {
  version: 1 as const,
  taskId,
  ownerAid: taskOwnerAid,
  label: taskCommand.label,
  harnessLineageId,
  revisionSaid: taskCommand.revision.d,
  revision: taskCommand.revision,
  lifecycle: { kind: 'Open' as const },
  commandId: taskCommand.commandId,
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0 as const,
};

function currentTaskMandate(selectedTask: TaskProjection = task): CurrentTaskMandate {
  const schemaSaid =
    selectedTask.revision.version !== 2
      ? taskMandateSchemaSaid
      : selectedTask.revision.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser
        ? taskMandateV3SchemaSaid
        : taskMandateV2SchemaSaid;
  const experience =
    selectedTask.revision.version === 2
      ? { experience: selectedTask.revision.constraints.experience }
      : {};
  const verified = verifyTaskMandate(
    {
      credential: {
        issuerAid: taskOwnerAid,
        issueeAid: personalAgentAid,
        registryId,
        schemaSaid,
        credentialSaid: taskMandateSaid,
      },
      task: {
        taskId,
        ownerAid: taskOwnerAid,
        revisionSaid: selectedTask.revisionSaid,
        harnessLineageId,
        repository: selectedTask.revision.repository,
        requestedCapabilities: selectedTask.revision.requestedCapabilities,
        unavailableCapabilities: selectedTask.revision.unavailableCapabilities,
        budgets: selectedTask.revision.budgets,
        evolutionClasses: selectedTask.revision.evolutionClasses,
        expiresAt: selectedTask.revision.expiresAt,
        ...experience,
      },
      observedAt,
    },
    {
      credential: {
        credentialSaid: taskMandateSaid,
        attributeSaid: taskMandateAttributeSaid,
        issuerAid: taskOwnerAid,
        issueeAid: personalAgentAid,
        registryId,
        schemaSaid,
        issuedAt: '2026-09-24T12:00:00.000Z',
        credentialSaidBinding: { kind: 'Verified' },
        attributeSaidBinding: { kind: 'Verified' },
        schemaDocument: { kind: 'Resolved', schemaSaid },
        telState: { kind: 'Issued' },
        issuerAnchor: { kind: 'Anchored', eventSaid: issuerAnchorSaid },
      },
      authority: 'ExecutePrivateTask',
      taskId,
      taskRevisionSaid: selectedTask.revisionSaid,
      harnessLineageId,
      repository: selectedTask.revision.repository,
      allowedCapabilities: selectedTask.revision.requestedCapabilities,
      budgets: selectedTask.revision.budgets,
      allowedEvolutionClasses: selectedTask.revision.evolutionClasses,
      notBefore: '2026-09-24T12:00:00.000Z',
      expiresAt: selectedTask.revision.expiresAt,
      ...experience,
    },
  );
  if (verified.kind !== 'Current') {
    throw new Error('Harness fixture Task Mandate must be current');
  }
  return verified.mandate;
}

function command(
  selectedTask: TaskProjection = task,
  toolCommands: BaselineHarnessPreparationInput['toolCommands'] = [],
  model = 'claude-sonnet-4-5',
  server = taskBudgetCeilings,
) {
  const toolCapabilities = selectedTask.revision.requestedCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
  const unavailableToolCapabilities = selectedTask.revision.unavailableCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
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
  const prepared = prepareBaselineHarnessRevision({
    toolCommands,
    task: {
      taskId,
      revisionSaid: selectedTask.revisionSaid,
      harnessLineageId,
      requestedCapabilities: toolCapabilities,
    },
    authority: {
      personalAgentAid,
      taskMandateSaid,
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
      server,
      mandate: selectedTask.revision.budgets,
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`Harness fixture must prepare: ${prepared.reason}`);
  }
  return { version: 1 as const, commandId, revision: prepared.revision };
}

function authorization(selectedTask: TaskProjection = task): CurrentTaskMandateAuthorization {
  return {
    kind: 'CurrentTaskMandateAuthorized',
    task: selectedTask,
    mandate: currentTaskMandate(selectedTask),
  };
}

function dependencies(
  create = vi.fn<AdmitBaselineHarnessDependencies['revisions']['create']>(),
): AdmitBaselineHarnessDependencies {
  create.mockResolvedValue({ kind: 'HarnessRevisionCreated' });
  return {
    currentUserCredential: {
      verify: () => Promise.resolve({ kind: 'UserCredentialCurrent' }),
    },
    currentTaskMandate: { authorize: () => Promise.resolve(authorization()) },
    revisions: {
      reconcile: () => Promise.resolve({ kind: 'NoHarnessRevision' }),
      create,
      findAccepted: () => Promise.resolve({ kind: 'HarnessNotFound' }),
    },
    now: () => observedAt,
  };
}

describe('baseline Harness admission', () => {
  it.each([6, 8, 9])(
    'admits v2 quota%s without widening per-Run spending or Pi tools',
    async (quota) => {
      const source = taskCommand.revision;
      const experience = {
        corpusSaid: `E${'q'.repeat(43)}`,
        repositoryResourceSaid: `E${'s'.repeat(43)}`,
        disclosure: 'AuthorizedAnalogy' as const,
      };
      const prepared = prepareTaskCommandV2(
        {
          version: 2,
          label: task.label,
          title: source.title,
          objective: source.objective,
          repository: { kind: 'gitCommit', commit: source.repository.commit },
          deliverables: source.deliverables,
          completionConditions: source.completionConditions,
          constraints: {
            ...source.constraints,
            dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
            experience,
          },
          requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
          unavailableCapabilities: source.unavailableCapabilities,
          budgets: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: quota },
          expiresAt: source.expiresAt,
          evolutionClasses: source.evolutionClasses,
          checkpointExpectations: source.checkpointExpectations,
        },
        task.commandId,
        source.repository,
      );
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') return;
      const scopedTask: TaskProjection = {
        ...task,
        revision: prepared.command.revision,
        revisionSaid: prepared.command.revision.d,
      };
      const configured = dependencies();
      const outcome = await admitBaselineHarness(
        {
          protectedCredentials: new ProtectedCredentials(),
          owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
          command: command(scopedTask, [], 'claude-sonnet-4-5', {
            ...taskBudgetCeilings,
            runsPerAdmittedUser: quota,
          }),
        },
        {
          ...configured,
          currentTaskMandate: { authorize: () => Promise.resolve(authorization(scopedTask)) },
        },
      );
      expect(outcome).toMatchObject({ kind: 'HarnessRevisionCreated' });
      const substituted = await admitBaselineHarness(
        {
          protectedCredentials: new ProtectedCredentials(),
          owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
          command: command(scopedTask, [], 'claude-sonnet-4-5', {
            ...taskBudgetCeilings,
            runsPerAdmittedUser: quota === 8 ? 6 : 8,
          }),
        },
        {
          ...configured,
          currentTaskMandate: { authorize: () => Promise.resolve(authorization(scopedTask)) },
        },
      );
      expect(substituted).toMatchObject({
        kind: 'HarnessRevisionRejected',
        reason: 'BudgetCeilingMismatch',
      });
    },
  );
  it('rejects the current Grant bearer before H1 reconciliation or persistence', async () => {
    const bearer = 's'.repeat(43);
    const reconcile = vi.fn<AdmitBaselineHarnessDependencies['revisions']['reconcile']>();
    const create = vi.fn<AdmitBaselineHarnessDependencies['revisions']['create']>();
    const configured = dependencies(create);
    const outcome = await admitBaselineHarness(
      {
        protectedCredentials: new ProtectedCredentials([bearer]),
        owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
        command: command(task, [], bearer),
      },
      { ...configured, revisions: { ...configured.revisions, reconcile } },
    );

    expect(outcome).toEqual({ kind: 'HarnessRevisionRejected', reason: 'SecretDetected' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('persists one immutable H1 only after exact current authority and binding checks', async () => {
    const create = vi.fn<AdmitBaselineHarnessDependencies['revisions']['create']>();
    const outcome = await admitBaselineHarness(
      {
        protectedCredentials: new ProtectedCredentials(),
        owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
        command: command(),
      },
      dependencies(create),
    );

    expect(outcome).toMatchObject({
      kind: 'HarnessRevisionCreated',
      projection: {
        ownerAid: taskOwnerAid,
        commandId,
        acceptedAt: observedAt,
        revision: {
          task: { taskId, revisionSaid: task.revisionSaid, harnessLineageId },
          authority: { personalAgentAid, taskMandateSaid },
        },
      },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects correctly identified commands that differ from the authoritative Task declaration', async () => {
    const declaration = {
      capability: 'RunFormatter' as const,
      id: 'format',
      argv: ['just', 'format'],
      timeoutSeconds: 30,
      expected: { kind: 'exitCode' as const, code: 0 },
    };
    const declared = taskCommandFixture(undefined, undefined, undefined, undefined, [declaration]);
    const selectedTask = {
      ...task,
      revision: declared.revision,
      revisionSaid: declared.revision.d,
    };
    for (const argv of [['just', 'other'], declaration.argv]) {
      const identified = identifyHarnessToolCommand({ ...declaration, argv }, '/usr/bin/just');
      if (identified.kind !== 'Identified') throw new Error('Expected identified command');
      const create = vi.fn<AdmitBaselineHarnessDependencies['revisions']['create']>();
      const configured = dependencies(create);
      const outcome = await admitBaselineHarness(
        {
          protectedCredentials: new ProtectedCredentials(),
          owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
          command: command(selectedTask, [identified.command]),
        },
        {
          ...configured,
          currentTaskMandate: {
            authorize: () =>
              Promise.resolve({
                kind: 'CurrentTaskMandateAuthorized',
                task: selectedTask,
                mandate: currentTaskMandate(selectedTask),
              }),
          },
        },
      );
      if (argv === declaration.argv) {
        expect(outcome.kind).toBe('HarnessRevisionCreated');
        expect(create).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toEqual({ kind: 'HarnessRevisionRejected', reason: 'ToolCommandMismatch' });
        expect(create).not.toHaveBeenCalled();
      }
    }
  });

  it('does not persist when the exact Task Mandate is no longer current', async () => {
    const create = vi.fn<AdmitBaselineHarnessDependencies['revisions']['create']>();
    const configured = dependencies(create);
    const outcome = await admitBaselineHarness(
      {
        protectedCredentials: new ProtectedCredentials(),
        owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
        command: command(),
      },
      {
        ...configured,
        currentTaskMandate: {
          authorize: () => Promise.resolve({ kind: 'TaskMandateRevoked' }),
        },
      },
    );

    expect(outcome).toEqual({ kind: 'HarnessAdmissionForbidden', reason: 'TaskMandateRevoked' });
    expect(create).not.toHaveBeenCalled();
  });
});
