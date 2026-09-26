import { runWorkAccessFixture } from '../test/run-work-access-fixture.js';
import { describe, expect, it } from 'vitest';
import {
  acquireFirstRunLease,
  ProtectedCredentials,
  promotionEvidenceClasses,
} from '@devrandom/domain';
import { personalAgentAid } from '@devrandom/identity';
import { decodeRunProjection, taskBudgetCeilings } from '@devrandom/protocol';

import type { DemoIssuerCompatibility } from './identity/application/demo-issuer-compatibility.js';
import { taskProjectionFixture } from '../test/task-source-fixture.js';
import { baselineHarnessCommandFixture } from '../test/baseline-harness-fixture.js';
import { runIncarnationId, runProjectionFixture } from '../test/run-fixture.js';
import { createProgram, type CliProcess, type DevrandomCommands } from './program.js';
import type { AdmittedTaskRunPreparation } from './task/application/task-run-execution.js';

function commandFixture(): {
  readonly commands: DevrandomCommands;
  readonly invocations: string[];
} {
  const invocations: string[] = [];
  const recovery = {
    kind: 'RecoveryRequired',
    reason: 'CustodyUnavailable',
    detail: 'custody file is absent',
  } as const;
  return {
    invocations,
    commands: {
      status: () =>
        Promise.resolve({
          kind: 'IssuerCompatible',
          issuer: {
            service: 'issuer',
            status: 'ready',
            issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
            issuerOobi:
              'http://keria.test/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
            registryId: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
            schemaId: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
          },
        }),
      initialize: (presentation) => {
        invocations.push(`init:${presentation}`);
        return Promise.resolve(recovery);
      },
      whoami: () => {
        invocations.push('whoami');
        return Promise.resolve(recovery);
      },
      rotate: () => {
        invocations.push('rotate');
        return Promise.resolve(recovery);
      },
      tasks: {
        create: (path) => {
          invocations.push(`task-create:${path}`);
          return Promise.resolve({ kind: 'TaskFileRejected', reason: 'FileUnavailable' });
        },
        list: () => {
          invocations.push('task-list');
          return Promise.resolve({
            kind: 'TasksListed',
            page: { version: 1, tasks: [], nextCursor: null },
          });
        },
        inspect: (label) => {
          invocations.push(`task-inspect:${label}`);
          return Promise.resolve({ kind: 'TaskLabelRejected' });
        },
        run: (label) => {
          invocations.push(`task-run:${label}`);
          return Promise.resolve({ kind: 'CustodyUnavailable' });
        },
        status: (label) => {
          invocations.push(`task-status:${label}`);
          const run = runProjectionFixture();
          return Promise.resolve({
            kind: 'Observed',
            status: {
              task: taskProjectionFixture(),
              run,
              stream: {
                version: 1,
                runId: run.runId,
                evidenceStreamId: run.evidenceStreamId,
                cursor: { kind: 'Empty' },
                checkpoint: { kind: 'Absent' },
                seal: { kind: 'Unsealed' },
              },
            },
          });
        },
        watch: async function* (label) {
          invocations.push(`task-watch:${label}`);
          const run = await Promise.resolve(runProjectionFixture());
          yield {
            kind: 'Observed',
            status: {
              task: taskProjectionFixture(),
              run,
              stream: {
                version: 1,
                runId: run.runId,
                evidenceStreamId: run.evidenceStreamId,
                cursor: { kind: 'Empty' },
                checkpoint: { kind: 'Absent' },
                seal: { kind: 'Unsealed' },
              },
            },
            events: [],
          };
        },
      },
    },
  };
}

function processFixture(): {
  readonly process: CliProcess;
  readonly output: string[];
  readonly errors: string[];
  readonly exitCodes: number[];
  readonly interruptionSignals: AbortSignal[];
  readonly interruptionReleases: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const interruptionSignals: AbortSignal[] = [];
  const interruptionReleases: string[] = [];
  return {
    output,
    errors,
    exitCodes,
    interruptionSignals,
    interruptionReleases,
    process: {
      write: (value) => output.push(value),
      writeError: (value) => errors.push(value),
      setExitCode: (value) => exitCodes.push(value),
      watchInterruption: () => {
        const signal = new AbortController().signal;
        interruptionSignals.push(signal);
        return {
          signal,
          release: () => {
            interruptionReleases.push('released');
          },
        };
      },
    },
  };
}

describe('devrandom command', () => {
  it('exposes the retained identity and Task surface without deferred runtime commands', () => {
    const { commands } = commandFixture();
    const runtime = processFixture();
    const help = createProgram(commands, runtime.process).helpInformation();

    expect(help).toContain('init');
    expect(help).toContain('whoami');
    expect(help).toContain('identity');
    expect(help).toContain('task');
    expect(help).not.toContain('agent create');
  });

  it('exposes durable Task status and bounded cursor-polled watch commands', () => {
    const runtime = processFixture();
    const program = createProgram(commandFixture().commands, runtime.process);
    const task = program.commands.find((command) => command.name() === 'task');

    expect(task?.helpInformation()).toContain('status <label>');
    expect(task?.helpInformation()).toContain('watch <label>');
  });

  it('dispatches Task create, list, and inspect as separate public commands', async () => {
    const { commands, invocations } = commandFixture();
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'create',
      'task.devrandom.json',
    ]);
    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'list',
    ]);
    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'inspect',
      'INVALID',
    ]);

    expect(invocations).toEqual([
      'task-create:task.devrandom.json',
      'task-list',
      'task-inspect:INVALID',
    ]);
    expect(runtime.output).toEqual(['No Tasks found.\n']);
    expect(runtime.errors).toEqual([
      'Task file was rejected: FileUnavailable.\n',
      'Task label is invalid.\n',
    ]);
    expect(runtime.exitCodes).toEqual([2, 0, 2]);
  });

  it('dispatches status and watch without starting or resuming runtime execution', async () => {
    const { commands, invocations } = commandFixture();
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'status',
      'repair-parser',
    ]);
    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'watch',
      'repair-parser',
    ]);

    expect(invocations).toEqual(['task-status:repair-parser', 'task-watch:repair-parser']);
    expect(runtime.output).toHaveLength(2);
    expect(runtime.output[0]).toContain('Task Run Status\n');
    expect(runtime.output[0]).toContain('Run state: Active.Preparing\n');
    expect(runtime.output[1]).toContain('Task Run Timeline\n');
    expect(runtime.output[1]).toContain('No new evidence events.\n');
    expect(runtime.errors).toEqual([]);
    expect(runtime.exitCodes).toEqual([0, 0]);
  });

  it('dispatches Task Run preparation without hiding absent local custody', async () => {
    const { commands, invocations } = commandFixture();
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'run',
      'repair-parser',
    ]);

    expect(invocations).toEqual(['task-run:repair-parser']);
    expect(runtime.output).toEqual([]);
    expect(runtime.errors).toEqual([
      'Task Run preparation failed: local Signify custody is unavailable. No replacement was created.\n',
    ]);
    expect(runtime.exitCodes).toEqual([4]);
    expect(runtime.interruptionSignals).toHaveLength(1);
    expect(runtime.interruptionReleases).toEqual(['released']);
  });

  it('preserves the server rejection code when Task Run Work Access is rejected', async () => {
    const base = commandFixture().commands;
    const commands: DevrandomCommands = {
      ...base,
      tasks: {
        ...base.tasks,
        run: () =>
          Promise.resolve({
            kind: 'TaskAccessRejected',
            access: {
              kind: 'ServerRejected',
              code: 'WorkAccessCapacityExceeded',
              correlationId: 'ac68bb43-8a7b-4838-bcd6-98143fd372af',
            },
          }),
      },
    };
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'run',
      'repair-parser',
    ]);

    expect(runtime.errors).toEqual([
      'Task Run Work Access failed: WorkAccessCapacityExceeded (ac68bb43-8a7b-4838-bcd6-98143fd372af).\n',
    ]);
    expect(runtime.exitCodes).toEqual([3]);
  });

  it('renders the supervised sealed-baseline disposition with its checkpoint and verification', async () => {
    const task = taskProjectionFixture();
    const harnessCommand = baselineHarnessCommandFixture();
    const run = runProjectionFixture();
    const runtime = processFixture();
    const base = commandFixture().commands;
    const commands: DevrandomCommands = {
      ...base,
      tasks: {
        ...base.tasks,
        run: (_label, signal) => {
          expect(signal).toBe(runtime.interruptionSignals[0]);
          const preparation: AdmittedTaskRunPreparation = {
            kind: 'RunLeaseAcquired',
            protectedCredentials: new ProtectedCredentials(),
            task,
            mandates: {
              personalAgent: {
                aid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
                origin: 'existing-principal-verified',
              },
              governor: {
                aid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
                origin: 'existing-principal-verified',
              },
              mandateRegistryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
              taskMandate: {
                credentialSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                holderGrantSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
                holderAdmissionSaid: 'ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
                serverGrantSaid: 'EDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
                expiresAt: '2026-09-24T22:00:00.000Z',
                admittedAt: '2026-09-24T18:16:00.000Z',
                allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
                budgets: { ...taskBudgetCeilings },
                allowedEvolutionClasses: ['C1'],
              },
              promotionMandate: {
                credentialSaid: 'EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
                holderGrantSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
                holderAdmissionSaid: 'EHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
                serverGrantSaid: 'EIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
                expiresAt: '2026-09-24T22:00:00.000Z',
                admittedAt: '2026-09-24T18:17:00.000Z',
                capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
                budgetCeiling: { ...taskBudgetCeilings },
                evolutionClassCeiling: ['C1'],
                requiredEvidenceClasses: promotionEvidenceClasses,
              },
            },
            harness: {
              kind: 'HarnessAdmitted',
              admission: 'Created',
              projection: {
                version: 1,
                ownerAid: task.ownerAid,
                commandId: harnessCommand.commandId,
                acceptedAt: '2026-09-24T19:00:00.000Z',
                revision: harnessCommand.revision,
              },
            },
            run: {
              kind: 'RunLeaseAcquired',
              leaseRequestStartedAt: 0,
              admission: 'Created',
              run,
              lease: {
                version: 1,
                disposition: 'Acquired',
                runId: run.runId,
                incarnationId: runIncarnationId,
                runVersion: 1,
                serverTime: '2026-09-24T20:00:00.000Z',
                expiresAt: '2026-09-24T20:00:45.000Z',
              },
            },
            workAccessRenewal: runWorkAccessFixture(),
            executionAuthority: {
              personalAgentAid: personalAgentAid(task.ownerAid),
              taskMandateCustody: {
                inspectCredential: () => Promise.reject(new Error('not used')),
              },
              evidenceSealExchange: {
                prepare: () => Promise.reject(new Error('not used')),
                deliver: () => Promise.reject(new Error('not used')),
              },
            },
          } as const;
          const decoded = decodeRunProjection(run);
          if (decoded.kind !== 'Accepted') {
            throw new Error('program fixture Run must decode');
          }
          const acquired = acquireFirstRunLease(decoded.run, {
            incarnationId: preparation.run.lease.incarnationId,
            expectedRunVersion: decoded.run.version,
            serverTime: preparation.run.lease.serverTime,
          });
          if (acquired.kind !== 'Acquired') {
            throw new Error('program fixture lease must acquire');
          }
          return Promise.resolve({
            kind: 'RunSupervised',
            preparation,
            calibrations: { confirmed: 5, excluded: 0 },
            supervision: {
              kind: 'Stopped',
              run: {
                ...acquired.run,
                version: acquired.run.version + 2,
                lifecycle: {
                  kind: 'Active',
                  phase: {
                    kind: 'Blocked',
                    reason: 'HarnessCompatibilityFailure',
                    checkpointSaid: `E${'q'.repeat(43)}`,
                  },
                },
                submissionVerification: { kind: 'Rejected' },
              },
              cause: {
                kind: 'ExecutorSettled',
                disposition: { kind: 'Completed', sessionId: crypto.randomUUID() },
              },
              latestHostedRunVersion: preparation.run.lease.runVersion,
            },
          });
        },
      },
    };

    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'run',
      task.label,
    ]);

    expect(runtime.output).toHaveLength(1);
    expect(runtime.output[0]).toContain('Run Supervision Stopped\n');
    expect(runtime.output[0]).toContain('Personal-agent authority: ExecutePrivateTask\n');
    expect(runtime.output[0]).toContain(
      'Task Mandate allowed capabilities: ReadRepository, RunTests, SubmitResult\n',
    );
    expect(runtime.output[0]).toContain('Governor authority: ActivateEvaluatedSuccessor\n');
    expect(runtime.output[0]).toContain(
      `Promotion Mandate required evidence: ${promotionEvidenceClasses.join(', ')}\n`,
    );
    expect(runtime.output[0]).toContain(`H1 SAID: ${harnessCommand.revision.d}\n`);
    expect(runtime.output[0]).toContain(
      'H1 meaning: initial specialization, not learned improvement.\n',
    );
    expect(runtime.output[0]).toContain('H1 model: deepseek/deepseek-flash\n');
    expect(runtime.output[0]).toContain('Run admission: Created\n');
    expect(runtime.output[0]).toContain(`Run ID: ${run.runId}\n`);
    expect(runtime.output[0]).toContain('Run state: Active.Blocked(HarnessCompatibilityFailure)\n');
    expect(runtime.output[0]).toContain(`Checkpoint SAID: E${'q'.repeat(43)}\n`);
    expect(runtime.output[0]).toContain('Submission verification: Rejected\n');
    expect(runtime.output[0]).toContain(`Run incarnation ID: ${runIncarnationId}\n`);
    expect(runtime.output[0]).toContain('Run lease expires at: 2026-09-24T20:00:45.000Z\n');
    expect(runtime.output[0]).not.toContain('Runtime: not started.');
    expect(runtime.output[0]).not.toContain('restored');
    expect(runtime.output[0]).not.toContain('resumed');
    expect(runtime.interruptionReleases).toEqual(['released']);
    expect(runtime.exitCodes).toEqual([0]);
  });

  it('reports rejected Task secrets without echoing source content or a digest', async () => {
    const fixture = commandFixture();
    const runtime = processFixture();
    await createProgram(
      {
        ...fixture.commands,
        tasks: {
          ...fixture.commands.tasks,
          create: () => Promise.resolve({ kind: 'TaskSecretDetected' }),
        },
      },
      runtime.process,
    ).parseAsync(['node', 'devrandom', 'task', 'create', 'task.devrandom.json']);

    expect(runtime.errors).toEqual([
      'Task content was rejected: protected credential material was detected.\n',
    ]);
    expect(runtime.output).toEqual([]);
    expect(runtime.exitCodes).toEqual([6]);
  });

  it.each([
    {
      outcome: { kind: 'ModelCredentialUnavailable' } as const,
      message: 'H1 preparation failed: the configured model credential is unavailable.\n',
    },
    {
      outcome: { kind: 'RepositoryInspectionRejected', reason: 'SecretDetected' } as const,
      message: 'H1 repository inspection failed: SecretDetected.\n',
    },
  ])('reports H1 privacy preparation rejection: $outcome.kind', async ({ outcome, message }) => {
    const fixture = commandFixture();
    const runtime = processFixture();
    await createProgram(
      {
        ...fixture.commands,
        tasks: { ...fixture.commands.tasks, run: () => Promise.resolve(outcome) },
      },
      runtime.process,
    ).parseAsync(['node', 'devrandom', 'task', 'run', 'repair-parser']);

    expect(runtime.errors).toEqual([message]);
    expect(runtime.output).toEqual([]);
    expect(runtime.exitCodes).toEqual([4]);
    expect(runtime.interruptionReleases).toEqual(['released']);
  });

  it.each([
    'ManagedWorktreeConflict',
    'EvidenceUnavailable',
    'SecretDetected',
    'ModelCredentialUnavailable',
  ] as const)(
    'reports %s as uncompleted preparation, not a sealed calibration result',
    async (failure) => {
      const decoded = decodeRunProjection(runProjectionFixture());
      if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
      const base = commandFixture().commands;
      const commands: DevrandomCommands = {
        ...base,
        tasks: {
          ...base.tasks,
          run: () =>
            Promise.resolve({
              kind: 'CalibrationRunUnsettled',
              ordinal: 1,
              supervision: {
                kind: 'Stopped',
                run: decoded.run,
                cause: { kind: 'PreparationRejected', failure: { kind: failure } },
                latestHostedRunVersion: decoded.run.version,
              },
            }),
        },
      };
      const runtime = processFixture();
      await createProgram(commands, runtime.process).parseAsync([
        'node',
        'devrandom',
        'task',
        'run',
        'repair-parser',
      ]);
      expect(runtime.exitCodes).toEqual([6]);
      expect(runtime.errors.join('')).toContain(`Run ID: ${decoded.run.binding.runId}`);
      expect(runtime.errors.join('')).toContain('Run state: Active.Preparing');
      expect(runtime.errors.join('')).toContain(`Run stop cause: PreparationRejected(${failure})`);
      expect(runtime.errors.join('')).toContain('Completed calibration attempt: none');
      expect(runtime.errors.join('')).toContain('Checkpoint: Absent');
      expect(runtime.errors.join('')).not.toContain('CalibrationExcluded');
    },
  );

  it('reports a numeric context preflight without disclosing Run content', async () => {
    const decoded = decodeRunProjection(runProjectionFixture());
    if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
    const base = commandFixture().commands;
    const commands: DevrandomCommands = {
      ...base,
      tasks: {
        ...base.tasks,
        run: () =>
          Promise.resolve({
            kind: 'CalibrationRunUnsettled',
            ordinal: 1,
            supervision: {
              kind: 'Stopped',
              run: decoded.run,
              cause: {
                kind: 'ExecutorSettled',
                disposition: {
                  kind: 'ContextLimitReached',
                  measurement: {
                    kind: 'ProviderRequest',
                    piEstimateTokens: 24_000,
                    encodedBytes: 122_880,
                    profile: 'AsciiGemmaEstimate',
                    admissionEstimateTokens: 65_440,
                    allowedInputTokens: 120_000,
                    providerRequestsAdmitted: 10,
                  },
                },
              },
              latestHostedRunVersion: decoded.run.version,
            },
          }),
      },
    };
    const runtime = processFixture();
    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'run',
      'repair-parser',
    ]);

    expect(runtime.exitCodes).toEqual([6]);
    expect(runtime.errors.join('')).toContain(
      'Run stop cause: ExecutorSettled(ContextLimitReached)',
    );
    expect(runtime.errors.join('')).toContain(
      'Context preflight: ProviderRequest profile=AsciiGemmaEstimate piEstimateTokens=24000 encodedBytes=122880 admissionEstimateTokens=65440 allowedInputTokens=120000 providerRequestsAdmitted=10',
    );
    expect(runtime.errors.join('')).not.toContain('secret prompt');
  });

  it('reports the typed evidence delivery boundary when calibration remains unsettled', async () => {
    const decoded = decodeRunProjection(runProjectionFixture());
    if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
    const base = commandFixture().commands;
    const commands: DevrandomCommands = {
      ...base,
      tasks: {
        ...base.tasks,
        run: () =>
          Promise.resolve({
            kind: 'CalibrationRunUnsettled',
            ordinal: 2,
            supervision: {
              kind: 'SettlementUnavailable',
              run: decoded.run,
              cause: { kind: 'ExecutorSettled', disposition: { kind: 'ModelUsageUnavailable' } },
              failure: {
                kind: 'EvidenceDeliveryRejected',
                delivery: {
                  kind: 'BatchDeliveryRejected',
                  failure: {
                    kind: 'RequestRejected',
                    code: 'EvidenceConflict',
                    reason: 'SequenceGap',
                    expectedStartingSequence: 2,
                    receivedStartingSequence: 0,
                  },
                },
              },
              latestHostedRunVersion: decoded.run.version,
            },
          }),
      },
    };
    const runtime = processFixture();
    await createProgram(commands, runtime.process).parseAsync([
      'node',
      'devrandom',
      'task',
      'run',
      'repair-parser',
    ]);

    expect(runtime.exitCodes).toEqual([6]);
    expect(runtime.errors.join('')).toContain(
      'Run settlement: EvidenceDeliveryRejected BatchDeliveryRejected RequestRejected EvidenceConflict SequenceGap expectedStartingSequence=2 receivedStartingSequence=0',
    );
    expect(runtime.errors.join('')).not.toContain('bearer');
  });

  it('dispatches print-only init, whoami, and explicit rotation independently', async () => {
    const { commands, invocations } = commandFixture();
    const runtime = processFixture();
    const program = createProgram(commands, runtime.process);

    await program.parseAsync(['node', 'devrandom', 'init', '--no-open']);
    await program.parseAsync(['node', 'devrandom', 'whoami']);
    await program.parseAsync(['node', 'devrandom', 'identity', 'rotate']);

    expect(invocations).toEqual(['init:PrintBrowserUrl', 'whoami', 'rotate']);
    expect(runtime.errors).toHaveLength(3);
    expect(runtime.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('custody file is absent')]),
    );
    expect(runtime.exitCodes).toEqual([4, 4, 4]);
  });

  it('reports the closed cryptographic reason for rejected AID proof', async () => {
    const proofRejected = {
      kind: 'RegistrationRejected',
      disposition: 'ProofRejected',
      detail: 'challenge response recipient does not match the Devrandom issuer',
    } as const;
    const commands: DevrandomCommands = {
      status: () => commandFixture().commands.status(),
      initialize: () => Promise.resolve(proofRejected),
      whoami: () => Promise.resolve(proofRejected),
      rotate: () => Promise.resolve(proofRejected),
      tasks: commandFixture().commands.tasks,
    };
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync(['node', 'devrandom', 'init']);

    expect(runtime.errors).toEqual([
      expect.stringContaining(
        'Evidence: challenge response recipient does not match the Devrandom issuer',
      ),
    ]);
    expect(runtime.exitCodes).toEqual([6]);
  });

  it('refuses demo readiness when the live issuer does not match the CLI pins', async () => {
    const incompatibility: DemoIssuerCompatibility = {
      kind: 'IssuerIncompatible',
      field: 'issuerAid',
      expected: 'EPinnedIssuer',
      actual: 'EOtherIssuer',
    };
    const commands = {
      ...commandFixture().commands,
      status: () => Promise.resolve(incompatibility),
    };
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync(['node', 'devrandom', 'status']);

    expect(runtime.output).toEqual([]);
    expect(runtime.errors).toEqual([
      'Devrandom services are incompatible: issuerAid expected EPinnedIssuer but received EOtherIssuer.\n',
    ]);
    expect(runtime.exitCodes).toEqual([7]);
  });
});
