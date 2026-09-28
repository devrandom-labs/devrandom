import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  decodeTaskRevision,
  decodeTaskRevisionV2,
  prepareTaskCommand,
  prepareTaskCommandV2,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  taskCommandFingerprint,
  taskSourceCommandSchema,
  type PreparedRepository,
  type TaskRevision,
  type TaskSourceCommand,
} from './task-command.js';

const commandId = '97e16745-4b76-4de3-9ae5-a183496e73e8';
const binding: PreparedRepository = {
  objectFormat: 'sha1',
  commit: '1111111111111111111111111111111111111111',
  tree: '2222222222222222222222222222222222222222',
};

function source(): TaskSourceCommand {
  return {
    version: 1,
    label: 'repair-parser',
    title: 'Repair the parser',
    objective: 'Make the prepared compatibility fixture pass.',
    repository: { kind: 'currentHead' },
    deliverables: [
      { kind: 'repositoryFile', id: 'parser', path: 'src/parser.ts' },
      {
        kind: 'namedResult',
        id: 'verification',
        name: 'Verification report',
        description: 'The exact public verifier outcome.',
      },
    ],
    completionConditions: [
      {
        id: 'public-test',
        argv: ['just', 'test-public'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
    ],
    constraints: {
      protectedPaths: ['secrets/local.json', '.env'],
      prohibitedEffects: ['NetworkAccess', 'CredentialAccess'],
      dataPolicy: 'RepositoryContentOnly',
    },
    requestedCapabilities: ['SubmitResult', 'ReadRepository', 'RunTests'],
    unavailableCapabilities: ['EditRepository'],
    budgets: {
      workAccessAttemptLifetimeSeconds: 300,
      workAccessGrantLifetimeSeconds: 1_800,
      nonterminalAttemptsPerUserClient: 2,
      activeGrantsPerUserClient: 2,
      publicAttemptCreationsPerMinutePerLoopbackSource: 20,
      nonterminalAttemptsGlobally: 32,
      requestsPerGrant: 2_000,
      tasksPerAdmittedUser: 4,
      runsPerAdmittedUser: 4,
      activeRunsPerAdmittedUser: 1,
      hostedWorkTasksGlobally: 16,
      hostedWorkRunsGlobally: 16,
      activeHostedWorkRunsGlobally: 1,
      ordinaryJsonRequestBodyBytes: 262_144,
      evidenceBatchBodyBytes: 262_144,
      artifactRequestBodyBytes: 589_824,
      evidencePlusArtifactsPerRunBytes: 67_108_864,
      acceptedEvidencePlusArtifactsGloballyBytes: 268_435_456,
      runWallTimeSeconds: 3_600,
      providerRequests: 50,
      providerInputTokens: 500_000,
      providerOutputTokens: 100_000,
      toolProposals: 500,
      aggregateChildCommandTimeSeconds: 1_800,
      oneChildCommandTimeSeconds: 300,
      changedFiles: 256,
      changedWorktreeBytes: 16_777_216,
      providerSpendMicroUsd: 5_000_000,
    },
    expiresAt: '2026-09-24T18:00:00.000Z',
    evolutionClasses: ['C3', 'C1'],
    checkpointExpectations: [
      { kind: 'deliverable', deliverableId: 'parser' },
      { kind: 'completionCondition', completionConditionId: 'public-test' },
    ],
  };
}

describe('Task command schemas', () => {
  it('prepares a separately versioned Task with bounded analogous experience and comparison authority', () => {
    const old = source();
    const fresh = {
      ...old,
      version: 2,
      constraints: {
        ...old.constraints,
        dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
        experience: {
          corpusSaid: `E${'c'.repeat(43)}`,
          repositoryResourceSaid: `E${'r'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy',
        },
      },
      requestedCapabilities: [...old.requestedCapabilities, 'ReadTaskMemory'],
      budgets: { ...old.budgets, ...taskEvaluationBudgetCeilings },
    } as const;
    expect(Value.Check(taskSourceCommandSchema, fresh)).toBe(false);
    expect(
      prepareTaskCommand(
        { ...old, budgets: { ...old.budgets, runsPerAdmittedUser: 8 } },
        commandId,
        binding,
      ).kind,
    ).toBe('Rejected');
    expect(
      prepareTaskCommandV2(
        { ...fresh, budgets: { ...fresh.budgets, runsPerAdmittedUser: 9 } },
        commandId,
        binding,
      ).kind,
    ).toBe('Prepared');
    expect(
      prepareTaskCommandV2(
        { ...fresh, budgets: { ...fresh.budgets, runsPerAdmittedUser: 11 } },
        commandId,
        binding,
      ).kind,
    ).toBe('Rejected');
    const prepared = prepareTaskCommandV2(fresh, commandId, binding);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('expected v2 task');
    expect(prepared.command.revision.version).toBe(2);
    expect(decodeTaskRevisionV2(prepared.command.revision)).toEqual({
      kind: 'Accepted',
      revision: prepared.command.revision,
    });
    expect(decodeTaskRevision(prepared.command.revision)).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });
  it('rejects two repository deliverables naming the same path under different IDs', () => {
    const duplicatePath = source();
    duplicatePath.deliverables = [
      { kind: 'repositoryFile', id: 'parser', path: 'src/parser.ts' },
      { kind: 'repositoryFile', id: 'copy', path: 'src/parser.ts' },
    ];
    expect(prepareTaskCommand(duplicatePath, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'DuplicateDeliverablePath',
    });
  });

  it('rejects an impossible calendar deadline before signing a Task command', () => {
    expect(
      prepareTaskCommand(
        { ...source(), expiresAt: '2027-02-30T12:00:00.000Z' },
        commandId,
        binding,
      ),
    ).toEqual({ kind: 'Rejected', reason: 'DeadlineInvalid' });
    const prepared = prepareTaskCommand(source(), commandId, binding);
    if (prepared.kind !== 'Prepared') throw new Error('valid Task fixture did not prepare');
    expect(
      decodeTaskRevision({
        ...prepared.command.revision,
        expiresAt: '2027-02-30T12:00:00.000Z',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'DeadlineInvalid' });
  });

  it('publishes the exact immutable server budget ceilings', () => {
    expect(taskBudgetCeilings).toMatchObject({
      tasksPerAdmittedUser: 4,
      hostedWorkTasksGlobally: 16,
      providerSpendMicroUsd: 5_000_000,
    });
    expect(Object.isFrozen(taskBudgetCeilings)).toBe(true);
  });

  it('accepts only the closed version-one source document', () => {
    const valid = source();

    expect(Value.Check(taskSourceCommandSchema, valid)).toBe(true);
    expect(Value.Check(taskSourceCommandSchema, { ...valid, personality: 'eager' })).toBe(false);
    expect(
      Value.Check(taskSourceCommandSchema, {
        ...valid,
        repository: { kind: 'gitCommit', commit: 'not-a-git-object-id' },
      }),
    ).toBe(false);
    expect(
      Value.Check(taskSourceCommandSchema, {
        ...valid,
        requestedCapabilities: ['Shell'],
      }),
    ).toBe(false);
  });
});

describe('Task preparation', () => {
  it('binds ordered formatter and analysis declarations separately from completion conditions', () => {
    const task = source();
    const toolCommands = [
      {
        capability: 'RunFormatter' as const,
        id: 'format',
        argv: ['just', 'format'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode' as const, code: 0 },
      },
      {
        capability: 'RunStaticAnalysis' as const,
        id: 'analyze',
        argv: ['just', 'lint'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode' as const, code: 0 },
      },
    ];
    const input = {
      ...task,
      requestedCapabilities: [
        ...task.requestedCapabilities,
        'RunFormatter' as const,
        'RunStaticAnalysis' as const,
      ],
      toolCommands,
    };
    const prepared = prepareTaskCommand(input, commandId, binding);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('declared Task commands must prepare');
    expect(prepared.command.revision.toolCommands).toEqual(toolCommands);
    expect(prepared.command.revision.completionConditions).toEqual(task.completionConditions);
    expect(decodeTaskRevision(prepared.command.revision)).toEqual({
      kind: 'Accepted',
      revision: prepared.command.revision,
    });
    const reversed = prepareTaskCommand(
      { ...input, toolCommands: [...toolCommands].reverse() },
      commandId,
      binding,
    );
    expect(reversed.kind).toBe('Prepared');
    if (reversed.kind !== 'Prepared') throw new Error('reordered commands must prepare');
    expect(reversed.command.revision.d).not.toBe(prepared.command.revision.d);
    for (const change of [
      { capability: 'RunStaticAnalysis' as const },
      { id: 'format-other' },
      { argv: ['just', 'format-check'] },
      { timeoutSeconds: 119 },
      { expected: { kind: 'exitCode' as const, code: 1 } },
    ]) {
      const first = toolCommands[0];
      const second = toolCommands[1];
      if (first === undefined || second === undefined)
        throw new Error('formatter fixture required');
      const changed = prepareTaskCommand(
        { ...input, toolCommands: [{ ...first, ...change }, second] },
        commandId,
        binding,
      );
      expect(changed.kind).toBe('Prepared');
      if (changed.kind !== 'Prepared') throw new Error('changed command must prepare');
      expect(changed.command.revision.d).not.toBe(prepared.command.revision.d);
    }
  });

  it.each([
    ['Duplicate', 'DuplicateToolCommandId'],
    ['CompletionCollision', 'DuplicateToolCommandId'],
    ['Unrequested', 'ToolCommandCapabilityUnrequested'],
    ['Timeout', 'ToolCommandTimeoutExceedsBudget'],
    ['Shell', 'ShellSyntaxNotAccepted'],
    ['Utf8', 'TextConstraintViolation'],
    ['Empty', 'SchemaInvalid'],
    ['UnsupportedRole', 'SchemaInvalid'],
    ['Checkpoint', 'UnknownCheckpointReference'],
  ] as const)('rejects unlawful tool command declaration: %s', (mutation, reason) => {
    const task = source();
    const command = {
      capability: 'RunFormatter' as const,
      id: mutation === 'CompletionCollision' ? 'public-test' : 'format',
      argv:
        mutation === 'Shell'
          ? ['just', 'format && upload']
          : mutation === 'Utf8'
            ? ['just', 'é'.repeat(600)]
            : ['just', 'format'],
      timeoutSeconds: mutation === 'Timeout' ? 181 : 120,
      expected: { kind: 'exitCode' as const, code: 0 },
    };
    const input = {
      ...task,
      requestedCapabilities:
        mutation === 'Unrequested'
          ? task.requestedCapabilities
          : [...task.requestedCapabilities, 'RunFormatter' as const],
      budgets: { ...task.budgets, oneChildCommandTimeSeconds: 180 },
      toolCommands:
        mutation === 'Empty' ? [] : mutation === 'Duplicate' ? [command, command] : [command],
      checkpointExpectations:
        mutation === 'Checkpoint'
          ? [{ kind: 'completionCondition' as const, completionConditionId: 'format' }]
          : task.checkpointExpectations,
    };
    if (mutation === 'UnsupportedRole') {
      expect(
        Value.Check(taskSourceCommandSchema, {
          ...input,
          toolCommands: [{ ...command, capability: 'RunTests' }],
        }),
      ).toBe(false);
    } else {
      expect(prepareTaskCommand(input, commandId, binding)).toEqual({ kind: 'Rejected', reason });
    }
  });

  it('uses the pinned Signify SAID over a fixed recursively rebuilt document', () => {
    const result = prepareTaskCommand(source(), commandId, binding);

    expect(result.kind).toBe('Prepared');
    if (result.kind !== 'Prepared') {
      return;
    }

    expect(result.command.revision.d).toBe('EGKA7Mm5Rz49_OF7P6jvz9c6aYY75xveRupNPBLeDsC_');
    expect(Object.keys(result.command.revision)).toEqual([
      'version',
      'd',
      'title',
      'objective',
      'repository',
      'deliverables',
      'completionConditions',
      'constraints',
      'requestedCapabilities',
      'unavailableCapabilities',
      'budgets',
      'expiresAt',
      'evolutionClasses',
      'checkpointExpectations',
    ]);
    expect(Object.keys(result.command.revision.repository)).toEqual([
      'objectFormat',
      'commit',
      'tree',
    ]);
    expect(Object.keys(result.command.revision.deliverables[0] ?? {})).toEqual([
      'kind',
      'id',
      'path',
    ]);
    expect(Object.keys(result.command.revision.completionConditions[0] ?? {})).toEqual([
      'id',
      'argv',
      'timeoutSeconds',
      'expected',
    ]);
    expect(Object.keys(result.command.revision.constraints)).toEqual([
      'protectedPaths',
      'prohibitedEffects',
      'dataPolicy',
    ]);
    expect(result.command.revision.constraints.protectedPaths).toEqual([
      '.env',
      'secrets/local.json',
    ]);
    expect(result.command.revision.constraints.prohibitedEffects).toEqual([
      'CredentialAccess',
      'NetworkAccess',
    ]);
    expect(result.command.revision.requestedCapabilities).toEqual([
      'ReadRepository',
      'RunTests',
      'SubmitResult',
    ]);
    expect(result.command.revision.evolutionClasses).toEqual(['C1', 'C3']);

    expect(decodeTaskRevision(result.command.revision)).toEqual({
      kind: 'Accepted',
      revision: result.command.revision,
    });
  });

  it('excludes label and source-repository convenience from revision identity', () => {
    const first = prepareTaskCommand(source(), commandId, binding);
    const renamed = prepareTaskCommand(
      {
        ...source(),
        label: 'another-label',
        repository: { kind: 'gitCommit', commit: binding.commit },
      },
      '4df838a8-5109-49fd-bdad-805880a3ecee',
      binding,
    );

    expect(first.kind).toBe('Prepared');
    expect(renamed.kind).toBe('Prepared');
    if (first.kind !== 'Prepared' || renamed.kind !== 'Prepared') {
      return;
    }
    expect(first.command.label).not.toBe(renamed.command.label);
    expect(first.command.revision.d).toBe(renamed.command.revision.d);
    expect(taskCommandFingerprint(first.command)).toBe(
      'sha256:ce679f987a05d7b1c9a87ac8b6955c329378eceab91434c6454d5df13d7190bc',
    );
    expect(taskCommandFingerprint(first.command)).not.toBe(taskCommandFingerprint(renamed.command));
    expect(
      taskCommandFingerprint({
        ...first.command,
        commandId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      }),
    ).toBe(taskCommandFingerprint(first.command));
  });

  it('retains contract order where order is meaningful', () => {
    const first = prepareTaskCommand(source(), commandId, binding);
    const reordered = source();
    reordered.deliverables.reverse();
    const second = prepareTaskCommand(reordered, commandId, binding);

    expect(first.kind).toBe('Prepared');
    expect(second.kind).toBe('Prepared');
    if (first.kind !== 'Prepared' || second.kind !== 'Prepared') {
      return;
    }
    expect(first.command.revision.d).not.toBe(second.command.revision.d);
  });

  it('rejects duplicate and undeclared checkpoint references', () => {
    const undeclared = source();
    undeclared.checkpointExpectations = [{ kind: 'deliverable', deliverableId: 'not-declared' }];
    const duplicated = source();
    duplicated.checkpointExpectations = [
      { kind: 'deliverable', deliverableId: 'parser' },
      { kind: 'deliverable', deliverableId: 'parser' },
    ];

    expect(prepareTaskCommand(undeclared, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'UnknownCheckpointReference',
    });
    expect(prepareTaskCommand(duplicated, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'DuplicateCheckpointReference',
    });
  });

  it('rejects capability overlap and child timeouts outside Task budgets', () => {
    const overlap = source();
    overlap.unavailableCapabilities = ['ReadRepository'];
    const timeout = source();
    const firstCondition = timeout.completionConditions[0];
    if (firstCondition !== undefined) {
      firstCondition.timeoutSeconds = 300;
    }
    timeout.budgets.oneChildCommandTimeSeconds = 299;

    expect(prepareTaskCommand(overlap, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'CapabilitySetsOverlap',
    });
    expect(prepareTaskCommand(timeout, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'CompletionTimeoutExceedsBudget',
    });
  });

  it('rejects a changed requested commit and shell syntax in argv', () => {
    const changedCommit = source();
    changedCommit.repository = {
      kind: 'gitCommit',
      commit: '3333333333333333333333333333333333333333',
    };
    const shellSyntax = source();
    const condition = shellSyntax.completionConditions[0];
    if (condition !== undefined) {
      condition.argv = ['just', '$DEVRANDOM_TEST_RECIPE'];
    }

    expect(prepareTaskCommand(changedCommit, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'RepositoryBindingMismatch',
    });
    expect(prepareTaskCommand(shellSyntax, commandId, binding)).toEqual({
      kind: 'Rejected',
      reason: 'ShellSyntaxNotAccepted',
    });
  });

  it('rejects a revision whose content no longer matches its SAID', () => {
    const result = prepareTaskCommand(source(), commandId, binding);
    if (result.kind !== 'Prepared') {
      return;
    }

    expect(
      decodeTaskRevision({
        ...result.command.revision,
        objective: 'Changed after identity was assigned.',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });

  it('classifies a malformed prepared repository as a schema invalidity', () => {
    const result = prepareTaskCommand(source(), commandId, binding);
    if (result.kind !== 'Prepared') {
      return;
    }

    expect(
      decodeTaskRevision({
        ...result.command.revision,
        repository: { ...result.command.revision.repository, objectFormat: 'sha512' },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it.each([
    [
      'TextConstraintViolation',
      (revision: TaskRevision) => ({ ...revision, objective: '\u754c'.repeat(3_000) }),
    ],
    [
      'DuplicateDeliverableId',
      (revision: TaskRevision) => ({
        ...revision,
        deliverables: revision.deliverables.flatMap((deliverable) => [deliverable, deliverable]),
      }),
    ],
    [
      'DuplicateDeliverablePath',
      (revision: TaskRevision) => ({
        ...revision,
        deliverables: [
          { kind: 'repositoryFile' as const, id: 'parser', path: 'src/parser.ts' },
          { kind: 'repositoryFile' as const, id: 'copy', path: 'src/parser.ts' },
        ],
      }),
    ],
    [
      'DuplicateCompletionConditionId',
      (revision: TaskRevision) => ({
        ...revision,
        completionConditions: revision.completionConditions.flatMap((condition) => [
          condition,
          condition,
        ]),
      }),
    ],
    [
      'UnknownCheckpointReference',
      (revision: TaskRevision) => ({
        ...revision,
        checkpointExpectations: [
          { kind: 'deliverable', deliverableId: 'not-declared' },
        ] satisfies TaskRevision['checkpointExpectations'],
      }),
    ],
    [
      'DuplicateCheckpointReference',
      (revision: TaskRevision) => ({
        ...revision,
        checkpointExpectations: [
          { kind: 'deliverable', deliverableId: 'parser' },
          { kind: 'deliverable', deliverableId: 'parser' },
        ] satisfies TaskRevision['checkpointExpectations'],
      }),
    ],
    [
      'CapabilitySetsOverlap',
      (revision: TaskRevision) => ({
        ...revision,
        unavailableCapabilities: [
          'ReadRepository',
        ] satisfies TaskRevision['unavailableCapabilities'],
      }),
    ],
    [
      'CompletionTimeoutExceedsBudget',
      (revision: TaskRevision) => ({
        ...revision,
        budgets: { ...revision.budgets, oneChildCommandTimeSeconds: 119 },
      }),
    ],
    [
      'ShellSyntaxNotAccepted',
      (revision: TaskRevision) => ({
        ...revision,
        completionConditions: revision.completionConditions.map((condition) => ({
          ...condition,
          argv: ['just', '$RECIPE'],
        })),
      }),
    ],
  ] satisfies readonly [string, (revision: TaskRevision) => TaskRevision][])(
    'preserves the semantic invalidity %s while decoding',
    (reason, alter) => {
      const result = prepareTaskCommand(source(), commandId, binding);
      if (result.kind !== 'Prepared') {
        return;
      }

      expect(decodeTaskRevision(alter(result.command.revision))).toEqual({
        kind: 'Rejected',
        reason,
      });
    },
  );

  it('distinguishes noncanonical normalized content from a mismatched SAID', () => {
    const result = prepareTaskCommand(source(), commandId, binding);
    if (result.kind !== 'Prepared') {
      return;
    }

    expect(
      decodeTaskRevision({
        ...result.command.revision,
        requestedCapabilities: [...result.command.revision.requestedCapabilities].reverse(),
      }),
    ).toEqual({ kind: 'Rejected', reason: 'NonCanonical' });
  });
});
