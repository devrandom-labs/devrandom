import { ProtectedCredentials } from '@devrandom/domain';
import {
  identifyHarnessInstruction,
  identifyHarnessToolCommand,
  prepareTaskCommand,
  prepareTaskCommandV2,
  taskBudgetCeilings,
  type AdmitBaselineHarnessBody,
  type BaselineHarnessProjection,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';
import { inspectPiModelCompatibility } from '@devrandom/runtime';

import {
  baselineHarnessCommandFixture,
  harnessCommandId,
  harnessPersonalAgentAid,
  harnessTaskMandateSaid,
} from '../../../test/baseline-harness-fixture.js';
import {
  preparedRepositoryFixture,
  taskProjectionFixture,
  taskSourceFixture,
} from '../../../test/task-source-fixture.js';
import {
  BaselineHarnessPreparation,
  type BaselineHarnessAdmissions,
  type BaselineHarnessInspection,
  type BaselineHarnessModelInspection,
  type HostedBaselineHarnesses,
} from './baseline-harness-preparation.js';

function inspection(): BaselineHarnessInspection {
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Task repository rules\n',
  });
  if (instruction.kind !== 'Identified') {
    throw new Error('instruction fixture must be identifiable');
  }
  return {
    inspect: () =>
      Promise.resolve({
        kind: 'Inspected',
        snapshot: {
          repository: {
            ...taskProjectionFixture().revision.repository,
            instructionResources: [instruction.resource],
          },
          commandExecutables: [
            {
              commandId: 'public-test',
              executableRealpath: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
            },
          ],
          environmentCompatibility: {
            operatingSystem: 'darwin',
            architecture: 'arm64',
            nodeVersion: '24.20.0',
            gitVersion: '2.51.0',
            piSdkVersion: '0.87.1',
            xstateVersion: '5.33.2',
          },
        },
      }),
  };
}

function modelInspection(): BaselineHarnessModelInspection {
  return {
    inspect: () =>
      Promise.resolve({
        kind: 'Compatible',
        compatibility: {
          provider: 'deepseek',
          model: 'deepseek-flash',
          contextWindowTokens: 1_000_000,
          maximumOutputTokens: 8_192,
          thinkingLevel: 'low',
          credentialSource: 'DEEPSEEK_API_KEY',
          toolCalls: 'Supported',
          usageAccounting: 'Required',
        },
      }),
  };
}

describe('baseline Harness preparation', () => {
  it.each(['Unavailable', 'Throws'] as const)(
    'does not inspect or admit H1 when credential acquisition is %s',
    async (acquisition) => {
      const task = taskProjectionFixture();
      const inspect = vi.fn<BaselineHarnessInspection['inspect']>((task, credentials) =>
        inspection().inspect(task, credentials),
      );
      const acquire = vi.fn();
      const admit = vi.fn();
      const application = new BaselineHarnessPreparation({
        repository: { inspect },
        model: modelInspection(),
        modelCredential: {
          acquire: () =>
            acquisition === 'Unavailable'
              ? Promise.resolve({ kind: 'Unavailable' })
              : Promise.reject(new Error('opaque-private-provider-error')),
        },
        availableCapabilities: task.revision.requestedCapabilities,
        admissions: { acquire, acknowledge: vi.fn() },
        wait: () => Promise.resolve(),
      });
      await expect(
        application.prepare({
          task,
          protectedCredentials: new ProtectedCredentials(),
          authority: {
            personalAgentAid: harnessPersonalAgentAid,
            taskMandateSaid: harnessTaskMandateSaid,
            allowedCapabilities: task.revision.requestedCapabilities,
            mandateBudgets: task.revision.budgets,
          },
          hosted: { admit },
        }),
      ).resolves.toEqual({ kind: 'ModelCredentialUnavailable' });
      expect(inspect).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it('protects the selected provider credential before inspecting repository instructions', async () => {
    const task = taskProjectionFixture();
    const secret = 'opaque-provider-fixture-972345';
    const protectedCredentials = new ProtectedCredentials();
    const admit = vi.fn();
    const acquire = vi.fn();
    const inspect = vi.fn<BaselineHarnessInspection['inspect']>((_task, credentials) => {
      expect(credentials).toBe(protectedCredentials);
      expect(credentials.inspect(new TextEncoder().encode(secret))).toMatchObject({
        kind: 'WithheldSecret',
        reason: 'Credential',
      });
      return Promise.resolve({ kind: 'Rejected', reason: 'SecretDetected' });
    });
    const application = new BaselineHarnessPreparation({
      availableCapabilities: task.revision.requestedCapabilities,
      repository: { inspect },
      model: modelInspection(),
      modelCredential: { acquire: () => Promise.resolve({ kind: 'Available', secret }) },
      admissions: { acquire, acknowledge: vi.fn() },
      wait: () => Promise.resolve(),
    });

    await expect(
      application.prepare({
        task,
        protectedCredentials,
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities,
          mandateBudgets: task.revision.budgets,
        },
        hosted: { admit },
      }),
    ).resolves.toEqual({ kind: 'RepositoryInspectionRejected', reason: 'SecretDetected' });
    expect(inspect).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('rejects unsupported accounting before allocating an H1 admission command or contacting the server', async () => {
    const task = taskProjectionFixture();
    const acquire = vi.fn(() =>
      Promise.resolve({ kind: 'Acquired' as const, commandId: harnessCommandId }),
    );
    const admit = vi.fn<HostedBaselineHarnesses['admit']>(() =>
      Promise.resolve({ kind: 'ServerUnavailable' }),
    );
    const acquireCredential = vi.fn();
    const inspectRepository = vi.fn<BaselineHarnessInspection['inspect']>((task, credentials) =>
      inspection().inspect(task, credentials),
    );
    const preparation = new BaselineHarnessPreparation({
      modelCredential: { acquire: acquireCredential },
      repository: { inspect: inspectRepository },
      model: {
        inspect: () =>
          inspectPiModelCompatibility({
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            thinkingLevel: 'high',
            maximumOutputTokens: 512,
            credentialSource: 'DEEPSEEK_API_KEY',
          }),
      },
      availableCapabilities: ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'],
      admissions: { acquire, acknowledge: vi.fn() },
      wait: () => Promise.resolve(),
    });
    await expect(
      preparation.prepare({
        task,
        protectedCredentials: new ProtectedCredentials(),
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities,
          mandateBudgets: task.revision.budgets,
        },
        hosted: { admit },
      }),
    ).resolves.toEqual({ kind: 'ModelInspectionRejected', reason: 'UsageAccountingUnsupported' });
    expect(acquireCredential).not.toHaveBeenCalled();
    expect(inspectRepository).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it.each(['RunFormatter', 'RunStaticAnalysis'] as const)(
    'rejects requested %s when the local runtime cannot execute it',
    async (capability) => {
      const source = taskSourceFixture();
      const prepared = prepareTaskCommand(
        { ...source, requestedCapabilities: [...source.requestedCapabilities, capability] },
        harnessCommandId,
        preparedRepositoryFixture,
      );
      if (prepared.kind !== 'Prepared') throw new Error('Task fixture must prepare');
      const task = taskProjectionFixture(prepared.command);
      const acquire = vi.fn(() =>
        Promise.resolve({ kind: 'Acquired' as const, commandId: harnessCommandId }),
      );
      const admit = vi.fn<HostedBaselineHarnesses['admit']>(() =>
        Promise.resolve({ kind: 'ServerUnavailable' }),
      );
      const application = new BaselineHarnessPreparation({
        modelCredential: {
          acquire: () =>
            Promise.resolve({ kind: 'Available', secret: 'opaque-fixture-provider-value' }),
        },
        repository: inspection(),
        model: modelInspection(),
        availableCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
        admissions: { acquire, acknowledge: vi.fn() },
        wait: () => Promise.resolve(),
      });
      await expect(
        application.prepare({
          task,
          protectedCredentials: new ProtectedCredentials(),
          authority: {
            personalAgentAid: harnessPersonalAgentAid,
            taskMandateSaid: harnessTaskMandateSaid,
            allowedCapabilities: task.revision.requestedCapabilities,
            mandateBudgets: task.revision.budgets,
          },
          hosted: { admit },
        }),
      ).resolves.toEqual({
        kind: 'HarnessPreparationRejected',
        reason: 'RequestedCapabilityUnavailable',
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    },
  );
  it.each(['Resolved', 'Missing'] as const)(
    'requires an inspected executable binding for every declared tool (%s)',
    async (binding) => {
      const source = taskSourceFixture();
      const declaration = {
        capability: 'RunFormatter' as const,
        id: 'format',
        argv: ['just', 'format'],
        timeoutSeconds: 30,
        expected: { kind: 'exitCode' as const, code: 0 },
      };
      const prepared = prepareTaskCommand(
        {
          ...source,
          requestedCapabilities: [...source.requestedCapabilities, 'RunFormatter'],
          toolCommands: [declaration],
        },
        harnessCommandId,
        preparedRepositoryFixture,
      );
      if (prepared.kind !== 'Prepared') throw new Error('Expected prepared Task');
      const task = taskProjectionFixture(prepared.command);
      const acquire = vi.fn(() =>
        Promise.resolve({ kind: 'Acquired' as const, commandId: harnessCommandId }),
      );
      const admit = vi.fn<HostedBaselineHarnesses['admit']>((command) =>
        Promise.resolve({
          kind: 'Created',
          projection: {
            version: 1,
            ownerAid: task.ownerAid,
            commandId: command.commandId,
            acceptedAt: '2026-09-24T19:00:00.000Z',
            revision: command.revision,
          },
        }),
      );
      const application = new BaselineHarnessPreparation({
        modelCredential: {
          acquire: () =>
            Promise.resolve({ kind: 'Available', secret: 'opaque-fixture-provider-value' }),
        },
        model: modelInspection(),
        repository: {
          inspect: async (task, credentials) => {
            const inspected = await inspection().inspect(task, credentials);
            if (inspected.kind !== 'Inspected') return inspected;
            return {
              ...inspected,
              snapshot: {
                ...inspected.snapshot,
                commandExecutables: [
                  ...inspected.snapshot.commandExecutables,
                  ...(binding === 'Resolved'
                    ? [{ commandId: 'format', executableRealpath: '/usr/bin/just' }]
                    : []),
                ],
              },
            };
          },
        },
        availableCapabilities: task.revision.requestedCapabilities,
        admissions: { acquire, acknowledge: () => Promise.resolve({ kind: 'Acknowledged' }) },
        wait: () => Promise.resolve(),
      });
      const outcome = await application.prepare({
        task,
        protectedCredentials: new ProtectedCredentials(),
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities,
          mandateBudgets: task.revision.budgets,
        },
        hosted: { admit },
      });
      if (binding === 'Missing') {
        expect(outcome).toEqual({ kind: 'HarnessPreparationRejected', reason: 'SchemaInvalid' });
        expect(acquire).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
      } else {
        expect(outcome.kind).toBe('HarnessAdmitted');
        const identified = identifyHarnessToolCommand(declaration, '/usr/bin/just');
        if (identified.kind !== 'Identified') throw new Error('Expected identified command');
        expect(admit).toHaveBeenCalledOnce();
        expect(admit.mock.calls[0]?.[0].revision.toolCommands).toEqual([identified.command]);
      }
    },
  );

  it.each([
    { version: 1, quota: 6 },
    { version: 2, quota: 6 },
    { version: 2, quota: 8 },
  ] as const)(
    'derives stable H1 for v$version quota$quota without changing spending',
    async ({ version, quota }) => {
      let task = taskProjectionFixture();
      if (version === 2) {
        const old = taskSourceFixture();
        const prepared = prepareTaskCommandV2(
          {
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
            budgets: { ...old.budgets, runsPerAdmittedUser: quota },
          },
          harnessCommandId,
          preparedRepositoryFixture,
        );
        expect(prepared.kind).toBe('Prepared');
        if (prepared.kind !== 'Prepared') return;
        task = {
          ...task,
          revision: prepared.command.revision,
          revisionSaid: prepared.command.revision.d,
        };
      }
      const admitted: BaselineHarnessProjection[] = [];
      const hosted: HostedBaselineHarnesses = {
        admit: vi.fn((command: AdmitBaselineHarnessBody) => {
          const projection: BaselineHarnessProjection = {
            version: 1,
            ownerAid: task.ownerAid,
            commandId: command.commandId,
            acceptedAt: '2026-09-24T19:00:00.000Z',
            revision: command.revision,
          };
          admitted.push(projection);
          return Promise.resolve({ kind: 'Created', projection } as const);
        }),
      };
      const admissions: BaselineHarnessAdmissions = {
        acquire: vi.fn(() =>
          Promise.resolve({ kind: 'Acquired', commandId: harnessCommandId } as const),
        ),
        acknowledge: vi.fn(() => Promise.resolve({ kind: 'Acknowledged' } as const)),
      };
      const application = new BaselineHarnessPreparation({
        modelCredential: {
          acquire: () =>
            Promise.resolve({ kind: 'Available', secret: 'opaque-fixture-provider-value' }),
        },
        availableCapabilities: ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'],
        repository: inspection(),
        model: modelInspection(),
        admissions,
        wait: () => Promise.resolve(),
      });
      const input = {
        task,
        protectedCredentials: new ProtectedCredentials(),
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities.filter(
            (capability) => capability !== 'ReadTaskMemory',
          ),
          mandateBudgets: task.revision.budgets,
        },
        hosted,
      } as const;

      const first = await application.prepare(input);
      const second = await application.prepare(input);

      expect(first).toMatchObject({ kind: 'HarnessAdmitted', admission: 'Created' });
      expect(second).toMatchObject({ kind: 'HarnessAdmitted', admission: 'Created' });
      expect(admitted).toHaveLength(2);
      expect(admitted[0]?.revision.d).toBe(admitted[1]?.revision.d);
      expect(admitted[0]?.revision.authority).toEqual({
        personalAgentAid: harnessPersonalAgentAid,
        taskMandateSaid: harnessTaskMandateSaid,
        allowedCapabilities: task.revision.requestedCapabilities.filter(
          (capability) => capability !== 'ReadTaskMemory',
        ),
      });
      expect(admitted[0]?.revision.budgetCeilings.server).toEqual({
        ...taskBudgetCeilings,
        runsPerAdmittedUser: quota,
      });
      expect(JSON.stringify(admitted[0])).not.toContain('governor');
      expect(JSON.stringify(admitted[0])).not.toContain('promotionMandate');
    },
  );

  it('does not obtain a command identity or contact the server when Git inspection rejects', async () => {
    const acquire = vi.fn();
    const hosted = { admit: vi.fn() };
    const application = new BaselineHarnessPreparation({
      modelCredential: {
        acquire: () =>
          Promise.resolve({ kind: 'Available', secret: 'opaque-fixture-provider-value' }),
      },
      availableCapabilities: ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'],
      repository: {
        inspect: () => Promise.resolve({ kind: 'Rejected', reason: 'WorktreeDirty' }),
      },
      model: modelInspection(),
      admissions: { acquire, acknowledge: vi.fn() },
      wait: () => Promise.resolve(),
    });
    const task = taskProjectionFixture();

    await expect(
      application.prepare({
        task,
        protectedCredentials: new ProtectedCredentials(),
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities,
          mandateBudgets: task.revision.budgets,
        },
        hosted,
      }),
    ).resolves.toEqual({ kind: 'RepositoryInspectionRejected', reason: 'WorktreeDirty' });
    expect(acquire).not.toHaveBeenCalled();
    expect(hosted.admit).not.toHaveBeenCalled();
  });

  it('does not acknowledge a successful HTTP response attributed to another owner', async () => {
    const task = taskProjectionFixture();
    const command = baselineHarnessCommandFixture();
    const acknowledge = vi.fn();
    const application = new BaselineHarnessPreparation({
      modelCredential: {
        acquire: () =>
          Promise.resolve({ kind: 'Available', secret: 'opaque-fixture-provider-value' }),
      },
      availableCapabilities: ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'],
      repository: inspection(),
      model: modelInspection(),
      admissions: {
        acquire: () => Promise.resolve({ kind: 'Acquired', commandId: harnessCommandId } as const),
        acknowledge,
      },
      wait: () => Promise.resolve(),
    });

    await expect(
      application.prepare({
        task,
        protectedCredentials: new ProtectedCredentials(),
        authority: {
          personalAgentAid: harnessPersonalAgentAid,
          taskMandateSaid: harnessTaskMandateSaid,
          allowedCapabilities: task.revision.requestedCapabilities,
          mandateBudgets: task.revision.budgets,
        },
        hosted: {
          admit: (prepared) =>
            Promise.resolve({
              kind: 'Created',
              projection: {
                version: 1,
                ownerAid: command.revision.authority.personalAgentAid,
                commandId: prepared.commandId,
                acceptedAt: '2026-09-24T19:00:00.000Z',
                revision: prepared.revision,
              },
            }),
        },
      }),
    ).resolves.toEqual({
      kind: 'HarnessAdmissionRejected',
      outcome: { kind: 'ResponseInvalid' },
    });
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
