import { acquireFirstRunLease, createRun, startRunExecution, type Run } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  preparePublicVerifierReceipt,
  prepareTaskCommand,
  prepareTaskCommandV2,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  type BaselineHarnessRevision,
  type PublicVerifierReceipt,
  type TaskProjection,
  type TaskSourceCommand,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import type { RetainedSubmittedVerification } from './public-task-verification.js';
import {
  PreparedCompatibilityClassifier,
  preparedCompatibilityVerifierReadOnlyPaths,
  type PreparedCompatibilityFailures,
} from './prepared-compatibility.js';

const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const said = (character: string): string => `E${character.repeat(43)}`;

describe('prepared public verifier source custody', () => {
  it('keeps exact public verifier sources readable and outside the editable repository surface', () => {
    const { task } = fixture();
    expect(preparedCompatibilityVerifierReadOnlyPaths(task)).toEqual([
      'Cargo.toml',
      'Cargo.lock',
      'AGENTS.md',
      'build.rs',
      '.cargo',
      'rust-toolchain',
      'rust-toolchain.toml',
      'tests',
    ]);
    expect(preparedCompatibilityVerifierReadOnlyPaths(fixture(2).task)).toEqual(
      preparedCompatibilityVerifierReadOnlyPaths(task),
    );
    expect(
      preparedCompatibilityVerifierReadOnlyPaths({
        ...task,
        label: 'cesr-compat-recovery-20260929a',
      }),
    ).toEqual(preparedCompatibilityVerifierReadOnlyPaths(task));
    const legacy = task.revision.completionConditions[2];
    if (legacy === undefined) throw new Error('Prepared legacy condition is missing');
    expect(
      preparedCompatibilityVerifierReadOnlyPaths({
        ...task,
        revision: {
          ...task.revision,
          completionConditions: [
            ...task.revision.completionConditions.slice(0, 2),
            {
              ...legacy,
              argv: ['cargo', 'test', '--locked', '--test', 'different'],
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});

function fixture(version: 1 | 2 = 1): {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly run: Run;
} {
  const source: TaskSourceCommand = {
    version: 1,
    label: 'cesr-compat',
    title: 'Repair CESR receipt compatibility',
    objective:
      'Accept the prepared legacy and current CESR receipt representations without weakening tamper rejection.',
    repository: { kind: 'currentHead' },
    deliverables: [{ kind: 'repositoryFile', id: 'decoder', path: 'src/lib.rs' }],
    completionConditions: [
      {
        id: 'cesr-current',
        argv: ['cargo', 'test', '--locked', '--test', 'cesr-current'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
      {
        id: 'cesr-tamper',
        argv: ['cargo', 'test', '--locked', '--test', 'cesr-tamper'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
      {
        id: 'cesr-legacy',
        argv: ['cargo', 'test', '--locked', '--test', 'cesr-legacy'],
        timeoutSeconds: 120,
        expected: { kind: 'exitCode', code: 0 },
      },
    ],
    constraints: {
      protectedPaths: ['tests/vectors'],
      prohibitedEffects: ['NetworkAccess', 'PackageInstall', 'CredentialAccess'],
      dataPolicy: 'RepositoryContentOnly',
    },
    requestedCapabilities: ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'],
    unavailableCapabilities: [],
    budgets: { ...taskBudgetCeilings },
    expiresAt: '2027-09-24T20:00:00.000Z',
    evolutionClasses: ['C1', 'C2', 'C3'],
    checkpointExpectations: [
      { kind: 'completionCondition', completionConditionId: 'cesr-current' },
      { kind: 'completionCondition', completionConditionId: 'cesr-tamper' },
      { kind: 'completionCondition', completionConditionId: 'cesr-legacy' },
    ],
  };
  const commandId = '97e16745-4b76-4de3-9ae5-a183496e73e8';
  const repository = {
    objectFormat: 'sha1' as const,
    commit: '1111111111111111111111111111111111111111',
    tree: '2222222222222222222222222222222222222222',
  };
  const preparedTask =
    version === 1
      ? prepareTaskCommand(source, commandId, repository)
      : prepareTaskCommandV2(
          {
            ...source,
            version: 2,
            constraints: {
              ...source.constraints,
              dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
              experience: {
                corpusSaid: said('c'),
                repositoryResourceSaid: said('r'),
                disclosure: 'AuthorizedAnalogy',
              },
            },
            requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
            budgets: { ...taskEvaluationBudgetCeilings },
          },
          commandId,
          repository,
        );
  if (preparedTask.kind !== 'Prepared') throw new Error('Task fixture must prepare');
  const task = {
    version,
    taskId,
    ownerAid: said('u'),
    label: preparedTask.command.label,
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    revisionSaid: preparedTask.command.revision.d,
    lifecycle: { kind: 'Open' },
    commandId: preparedTask.command.commandId,
    createdAt: '2026-09-24T18:00:00.000Z',
    expectedVersion: 0,
    revision: preparedTask.command.revision,
  } as TaskProjection;
  const harnessTools = task.revision.requestedCapabilities.filter(
    (capability) => capability !== 'ReadTaskMemory',
  ) as BaselineHarnessRevision['task']['requestedCapabilities'];
  const unavailableHarnessTools = task.revision.unavailableCapabilities.filter(
    (capability) => capability !== 'ReadTaskMemory',
  ) as BaselineHarnessRevision['task']['requestedCapabilities'];
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Prepared CESR fixture\n',
  });
  const commands = task.revision.completionConditions.map((condition) =>
    identifyHarnessCompletionCommand(
      condition,
      '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-cargo-1.98.1/bin/cargo',
    ),
  );
  if (
    instruction.kind !== 'Identified' ||
    commands.some((command) => command.kind !== 'Identified')
  ) {
    throw new Error('H1 fixture resources must identify');
  }
  const preparedHarness = prepareBaselineHarnessRevision({
    toolCommands: [],
    task: {
      taskId: task.taskId,
      revisionSaid: task.revisionSaid,
      harnessLineageId: task.harnessLineageId,
      requestedCapabilities: harnessTools,
    },
    authority: {
      personalAgentAid: said('a'),
      taskMandateSaid: said('d'),
      allowedCapabilities: harnessTools,
    },
    repository: {
      ...task.revision.repository,
      instructionResources: [instruction.resource],
    },
    completionCommands: commands.flatMap((command) =>
      command.kind === 'Identified' ? [command.command] : [],
    ),
    modelCompatibility: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      maximumOutputTokens: 8_192,
      thinkingLevel: 'low',
      credentialSource: 'ANTHROPIC_API_KEY',
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
      available: harnessTools,
      unavailable: unavailableHarnessTools,
    },
    budgetCeilings: {
      task: task.revision.budgets,
      server: taskBudgetCeilings,
      mandate: task.revision.budgets,
    },
  });
  if (preparedHarness.kind !== 'Prepared') throw new Error('H1 fixture must prepare');
  const created = createRun({
    runId,
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: preparedHarness.revision.authority.personalAgentAid,
    taskMandateSaid: preparedHarness.revision.authority.taskMandateSaid,
    governorAid: said('g'),
    promotionMandateSaid: said('p'),
    initialHarnessRevisionSaid: preparedHarness.revision.d,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: preparedHarness.revision.d,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: task.revision.repository,
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('e'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: task.revision.budgets,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error('Run fixture must create');
  const leased = acquireFirstRunLease(created.run, {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('Run fixture must lease');
  const started = startRunExecution(leased.run, {
    incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('Run fixture must start');
  return { task, harness: preparedHarness.revision, run: started.run };
}

function receipt(
  condition: BaselineHarnessRevision['completionCommands'][number],
  outcome: PublicVerifierReceipt['outcome'],
): PublicVerifierReceipt {
  const prepared = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: condition.identity,
    commandSaid: condition.contentSaid,
    recordedAt: '2026-09-24T20:00:05.000Z',
    outcome,
  });
  if (prepared.kind !== 'Prepared') throw new Error('receipt fixture must prepare');
  return prepared.receipt;
}

function exactVerification(harness: BaselineHarnessRevision): RetainedSubmittedVerification {
  const [current, tamper, legacy] = harness.completionCommands;
  if (current === undefined || tamper === undefined || legacy === undefined) {
    throw new Error('prepared fixture must have three commands');
  }
  return {
    kind: 'Rejected',
    feedback: 'Public completion condition rejected; output artifacts retain the details.',
    receipts: [
      receipt(current, {
        kind: 'Accepted',
        observedExitCode: 0,
        elapsedMilliseconds: 100,
        outputArtifactSaids: [said('x')],
      }),
      receipt(tamper, {
        kind: 'Accepted',
        observedExitCode: 0,
        elapsedMilliseconds: 120,
        outputArtifactSaids: [said('y')],
      }),
      receipt(legacy, {
        kind: 'Rejected',
        reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
        elapsedMilliseconds: 140,
        outputArtifactSaids: [said('z')],
      }),
    ],
    outputArtifactSaids: [said('x'), said('y'), said('z')],
  };
}

describe('prepared CESR compatibility classification', () => {
  it('classifies exact bound evidence for a versioned Task label', () => {
    const input = fixture(2);
    expect(
      new PreparedCompatibilityClassifier().classify({
        ...input,
        task: { ...input.task, label: 'cesr-compat-recovery-20260929a' },
        verification: exactVerification(input.harness),
      }).kind,
    ).toBe('Confirmed');
  });

  it('confirms the same exact public pattern for an authorized v2 Task without granting H1 a memory tool', () => {
    const input = fixture(2);
    expect(input.task.revision.requestedCapabilities).toContain('ReadTaskMemory');
    expect(input.harness.task.requestedCapabilities).not.toContain('ReadTaskMemory');
    expect(
      new PreparedCompatibilityClassifier().classify({
        ...input,
        verification: exactVerification(input.harness),
      }).kind,
    ).toBe('Confirmed');
  });

  it('confirms only the exact Task, H1, Run, and prepared receipt pattern', () => {
    const input = fixture();
    const failures: PreparedCompatibilityFailures = new PreparedCompatibilityClassifier();

    const classification = failures.classify({
      ...input,
      verification: exactVerification(input.harness),
    });
    expect(classification.kind).toBe('Confirmed');
    if (classification.kind !== 'Confirmed') return;
    expect(classification.category).toEqual({
      version: 1,
      taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessRevisionSaid: input.harness.d,
      currentCommandSaid: input.harness.completionCommands[0]?.contentSaid,
      tamperCommandSaid: input.harness.completionCommands[1]?.contentSaid,
      legacyCommandSaid: input.harness.completionCommands[2]?.contentSaid,
      legacyObservedExitCode: 101,
    });
    expect(classification.verifierReceiptSaids).toHaveLength(3);
    for (const receiptSaid of classification.verifierReceiptSaids) {
      expect(receiptSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
    }
  });

  it('does not confirm a passing H1 or a different public-condition failure', () => {
    const input = fixture();
    const failures = new PreparedCompatibilityClassifier();
    const rejected = exactVerification(input.harness);
    const [current, tamper, legacy] = input.harness.completionCommands;
    if (current === undefined || tamper === undefined || legacy === undefined) {
      throw new Error('prepared fixture must have three commands');
    }
    expect(
      failures.classify({
        ...input,
        verification: {
          kind: 'Accepted',
          receipts: [
            receipt(current, {
              kind: 'Accepted',
              observedExitCode: 0,
              elapsedMilliseconds: 1,
              outputArtifactSaids: [],
            }),
            receipt(tamper, {
              kind: 'Accepted',
              observedExitCode: 0,
              elapsedMilliseconds: 1,
              outputArtifactSaids: [],
            }),
            receipt(legacy, {
              kind: 'Accepted',
              observedExitCode: 0,
              elapsedMilliseconds: 1,
              outputArtifactSaids: [],
            }),
          ],
          outputArtifactSaids: [],
        },
      }),
    ).toEqual({ kind: 'NotConfirmed', reason: 'H1Passed' });
    const different = rejected.receipts.map((value, index) =>
      index === 2
        ? receipt(legacy, {
            kind: 'Rejected',
            reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 1 },
            elapsedMilliseconds: 1,
            outputArtifactSaids: [],
          })
        : value,
    );
    expect(
      failures.classify({
        ...input,
        verification: { ...rejected, receipts: different },
      }),
    ).toEqual({ kind: 'NotConfirmed', reason: 'ReceiptPatternMismatch' });
  });

  it('keeps blocked verification and binding drift out of compatibility evidence', () => {
    const input = fixture();
    const failures = new PreparedCompatibilityClassifier();
    expect(
      failures.classify({
        ...input,
        verification: {
          kind: 'Blocked',
          reason: 'OutboxBackpressure',
          receipts: [],
          outputArtifactSaids: [],
        },
      }),
    ).toEqual({ kind: 'InfrastructureFailure', reason: 'OutboxBackpressure' });
    expect(
      failures.classify({
        ...input,
        task: { ...input.task, taskId: 'd4fd5b0d-ff60-4ca9-96f7-56241557ee47' },
        verification: exactVerification(input.harness),
      }),
    ).toEqual({ kind: 'NotConfirmed', reason: 'FixtureBindingMismatch' });
  });
});
