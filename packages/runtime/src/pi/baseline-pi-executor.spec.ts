import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRun,
  ProtectedCredentials,
  taskBudgetCeilings,
  type Run,
  type TaskToolCapability,
} from '@devrandom/domain';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EvidenceObservation, EvidenceRecording } from '../evidence/evidence-recorder.js';
import { RunResourceBudget, type RunBudgetEvidence } from '../run/run-resource-budget.js';
import type { ToolGatewayProposal } from '../tool-gateway/tool-gateway.js';
import {
  BaselinePiExecutor,
  PinnedPiModelAccess,
  type PiExecutionEvidence,
  type PiModelAccess,
} from './baseline-pi-executor.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const worktrees: string[] = [];

afterEach(async () => {
  await Promise.all(worktrees.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function harness(
  provider: string,
  model: string,
  requestedCapabilities: readonly TaskToolCapability[] = ['ReadRepository'],
): {
  readonly revision: BaselineHarnessRevision;
  readonly instructions: readonly { readonly path: string; readonly content: string }[];
} {
  const instructions = [{ path: 'AGENTS.md', content: '# Test instructions\nUse read_file.\n' }];
  const instruction = identifyHarnessInstruction(instructions[0] ?? { path: '', content: '' });
  const completion = identifyHarnessCompletionCommand(
    {
      id: 'public-test',
      argv: ['just', 'test-public'],
      timeoutSeconds: 120,
      expected: { kind: 'exitCode', code: 0 },
    },
    '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
  );
  if (instruction.kind !== 'Identified' || completion.kind !== 'Identified') {
    throw new Error('Pi fixture inputs must identify');
  }
  const prepared = prepareBaselineHarnessRevision({
    toolCommands: [],
    task: {
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      revisionSaid: said('b'),
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      requestedCapabilities,
    },
    authority: {
      personalAgentAid: said('c'),
      taskMandateSaid: said('d'),
      allowedCapabilities: requestedCapabilities,
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      instructionResources: [instruction.resource],
    },
    completionCommands: [completion.command],
    modelCompatibility: {
      provider,
      model,
      contextWindowTokens: 100_000,
      maximumOutputTokens: 2_000,
      thinkingLevel: 'off',
      credentialSource: 'FAUX_API_KEY',
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
    capabilities: { available: requestedCapabilities, unavailable: [] },
    budgetCeilings: {
      task: taskBudgetCeilings,
      server: taskBudgetCeilings,
      mandate: taskBudgetCeilings,
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`Pi fixture H1 rejected: ${prepared.reason}`);
  }
  return { revision: prepared.revision, instructions };
}

function runningRun(revision: BaselineHarnessRevision): Run {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: said('a'),
    taskId: revision.task.taskId,
    taskRevisionSaid: revision.task.revisionSaid,
    harnessLineageId: revision.task.harnessLineageId,
    personalAgentAid: revision.authority.personalAgentAid,
    taskMandateSaid: revision.authority.taskMandateSaid,
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: revision.d,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: revision.task.harnessLineageId,
      harnessRevisionSaid: revision.d,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: {
      objectFormat: revision.repository.objectFormat,
      commit: revision.repository.commit,
      tree: revision.repository.tree,
    },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('g'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('Pi fixture Run must create');
  }
  return {
    ...created.run,
    version: 2,
    lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
    lease: {
      kind: 'Held',
      incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
      acquiredAt: '2026-09-24T20:00:01.000Z',
      expiresAt: '2026-09-24T20:10:01.000Z',
      lastChange: { kind: 'Acquired', fromRunVersion: 0 },
    },
  };
}

function evidence(observations: EvidenceObservation[]): PiExecutionEvidence & RunBudgetEvidence {
  let sequence = 0;
  let predecessor: string | undefined;
  return {
    storeArtifact(input: { readonly bytes: Uint8Array; readonly mediaType: 'application/json' }) {
      const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
      return prepared.kind === 'Prepared'
        ? { kind: 'Stored', artifact: prepared.artifact }
        : { kind: 'ArtifactRejected' };
    },
    withhold: () => ({ kind: 'Unavailable' }),
    recordBudgetDebit(input): EvidenceRecording {
      let recorded: EvidenceRecording = { kind: 'ObservationRejected' };
      for (const event of input.debits) {
        recorded = this.record({ occurredAt: input.occurredAt, producer: input.producer, event });
        if (recorded.kind !== 'Recorded') return recorded;
      }
      return recorded;
    },
    record(observation: EvidenceObservation): EvidenceRecording {
      observations.push(observation);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          predecessor === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: predecessor },
        taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        taskRevisionSaid: said('b'),
        runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
        incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
        harnessRevisionSaid: said('h'),
        personalAgentAid: said('c'),
        taskMandateSaid: said('d'),
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      if (prepared.kind !== 'Prepared') {
        return { kind: 'ObservationRejected' };
      }
      sequence += 1;
      predecessor = prepared.event.d;
      return { kind: 'Recorded', event: prepared.event };
    },
  };
}

function budget(run: Run, recorder: ReturnType<typeof evidence>): RunResourceBudget {
  return new RunResourceBudget({
    run,
    evidence: recorder,
    now: () => '2026-09-24T20:00:02.000Z',
  });
}

function activeTools(context: TranscriptContext): readonly string[] {
  const system = context.messages.find((message) => message.role === 'system');
  return system?.role === 'system' ? (system.toolsAdded ?? []).map(({ name }) => name) : [];
}

describe('embedded baseline Pi executor', () => {
  it('rejects unsupported raw accounting before requesting credentials', async () => {
    const acquire = vi.fn(() =>
      Promise.resolve({ kind: 'Available' as const, secret: 'synthetic-key' }),
    );
    const access = new PinnedPiModelAccess({ acquire });
    await expect(
      access.open({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        contextWindowTokens: 1_000_000,
        maximumOutputTokens: 512,
        thinkingLevel: 'high',
        credentialSource: 'DEEPSEEK_API_KEY',
        toolCalls: 'Supported',
        usageAccounting: 'Required',
      }),
    ).resolves.toEqual({ kind: 'ConfigurationRequired' });
    expect(acquire).not.toHaveBeenCalled();
  });
  it.each([
    {
      recording: {
        kind: 'SecretDetected',
        dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
        securityViolationEventSaid: 'E'.padEnd(44, 'z'),
      },
      terminal: 'SecretDetected',
    },
    { recording: { kind: 'Unavailable' }, terminal: 'EvidenceUnavailable' },
  ] as const)(
    'stops before opening the provider when prompt withholding returns $recording.kind',
    async ({ recording, terminal }) => {
      const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-private-input-'));
      worktrees.push(directory);
      const plan = harness('devrandom-faux', 'executor');
      const run = runningRun(plan.revision);
      const observations: EvidenceObservation[] = [];
      const withhold = vi.fn<PiExecutionEvidence['withhold']>(() => recording);
      const recorder = { ...evidence(observations), withhold };
      const open = vi.fn<PiModelAccess['open']>(() => Promise.resolve({ kind: 'Unavailable' }));
      const executor = new BaselinePiExecutor({
        protectedCredentials: new ProtectedCredentials(),
        worktree: directory,
        agentDirectory: join(directory, '.agent-unused'),
        harness: plan.revision,
        instructions: plan.instructions,
        prompt: 'Authorization: Bearer synthetic-private-input',
        modelAccess: { open },
        budget: budget(run, recorder),
        gateway: { propose: vi.fn() },
        evidence: recorder,
        now: () => '2026-09-24T20:00:02.000Z',
        sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: () => 'turn-0',
      });
      await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
        kind: terminal,
      });
      expect(open).not.toHaveBeenCalled();
      expect(withhold).toHaveBeenCalledOnce();
      expect(withhold.mock.calls[0]?.[0]).toMatchObject({
        occurredAt: '2026-09-24T20:00:02.000Z',
        producer: { kind: 'PiExecutor' },
        disclosure: { kind: 'WithheldSecret', reason: 'AuthorizationHeader' },
      });
      expect(observations).toEqual([]);
    },
  );

  it.each(['Observation', 'Artifact'] as const)(
    'stops with the exact privacy cause when %s recording is withheld',
    async (boundary) => {
      const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-withholding-'));
      worktrees.push(directory);
      const faux = fauxProvider({
        provider: 'devrandom-private-faux',
        models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
      });
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
      faux.setResponses([fauxAssistantMessage('synthetic private response')]);
      const plan = harness(faux.provider.id, faux.getModel().id);
      const run = runningRun(plan.revision);
      const observations: EvidenceObservation[] = [];
      const base = evidence(observations);
      const recorder: PiExecutionEvidence & RunBudgetEvidence = {
        ...base,
        record: (observation) =>
          boundary === 'Observation' && observation.event.kind === 'ModelRequest'
            ? { kind: 'SecretDetected' }
            : base.record(observation),
        storeArtifact: () => ({ kind: 'SecretDetected' }),
      };
      const executor = new BaselinePiExecutor({
        protectedCredentials: new ProtectedCredentials(),
        worktree: directory,
        agentDirectory: join(directory, '.agent-unused'),
        harness: plan.revision,
        instructions: plan.instructions,
        prompt: 'Inspect the repository.',
        modelAccess: {
          open: () =>
            Promise.resolve({
              kind: 'Opened',
              consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
              runtime,
              model: faux.getModel(),
            }),
        },
        budget: budget(run, recorder),
        gateway: { propose: vi.fn() },
        evidence: recorder,
        now: () => '2026-09-24T20:00:02.000Z',
        sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: (index) => `turn-${String(index)}`,
      });
      await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
        kind: 'SecretDetected',
      });
      expect(faux.state.callCount).toBe(boundary === 'Observation' ? 0 : 1);
      expect(observations.some(({ event }) => event.kind === 'ModelMessageCompleted')).toBe(false);
    },
  );

  it('opens the pinned Concentrate Responses model with provider and model fallbacks disabled', async () => {
    const plan = harness('concentrate', 'deepinfra/gemma-4-e4b');
    const acquire = vi.fn(() =>
      Promise.resolve({ kind: 'Available' as const, secret: 'test-only-concentrate-key' }),
    );
    const access = new PinnedPiModelAccess({ acquire });

    const opened = await access.open({
      ...plan.revision.modelCompatibility,
      contextWindowTokens: 131_072,
      maximumOutputTokens: 32_768,
      thinkingLevel: 'low',
      credentialSource: 'CONCENTRATE_API_KEY',
    });

    expect(acquire).toHaveBeenCalledWith({
      provider: 'concentrate',
      credentialSource: 'CONCENTRATE_API_KEY',
    });
    expect(opened.kind).toBe('Opened');
    if (opened.kind !== 'Opened') return;
    expect(opened.model).toMatchObject({
      provider: 'concentrate',
      id: 'deepinfra/gemma-4-e4b',
      api: 'openai-responses',
      baseUrl: 'https://api.concentrate.ai/v1',
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: true,
      cost: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0 },
      samplingParams: {
        routing: {
          provider: { fallbacks: ['deepinfra'], sort: 'cost' },
          model: { fallbacks: [] },
        },
      },
    });
  });

  it('constructs one in-memory session with only H1 tools and records completed messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    const plan = harness(faux.provider.id, faux.getModel().id);
    const observations: EvidenceObservation[] = [];
    const proposals: ToolGatewayProposal[] = [];
    const outputArtifactSaid = `E${'q'.repeat(43)}`;
    let exposedTools: readonly string[] = [];
    let continuationTranscript = '';
    faux.setResponses([
      (context) => {
        exposedTools = activeTools(context);
        return fauxAssistantMessage(
          fauxToolCall('read_file', { path: 'src/index.ts' }, { id: 'tool-call-1' }),
          { stopReason: 'toolUse' },
        );
      },
      (context) => {
        continuationTranscript = JSON.stringify(context.messages);
        return fauxAssistantMessage('Inspection complete.');
      },
    ]);
    const modelAccess: PiModelAccess = {
      open: () =>
        Promise.resolve({
          kind: 'Opened',
          consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
          runtime,
          model: faux.getModel(),
        }),
    };
    const run = runningRun(plan.revision);
    const recorder = evidence(observations);
    const resourceBudget = budget(run, recorder);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Inspect src/index.ts.',
      modelAccess,
      budget: resourceBudget,
      gateway: {
        propose(proposal) {
          proposals.push(proposal);
          return Promise.resolve({
            kind: 'Completed',
            summary: 'read repository://src/index.ts',
            outputArtifactSaids: [outputArtifactSaid],
          });
        },
      },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'Completed',
      sessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    });
    expect(exposedTools).toEqual(['list_files', 'read_file', 'search_repository']);
    expect(proposals).toEqual([
      {
        piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: 'turn-0',
        toolCallId: 'tool-call-1',
        proposalIndex: 0,
        input: { kind: 'ReadFile', path: 'src/index.ts' },
      },
    ]);
    expect(continuationTranscript).toContain(outputArtifactSaid);
    expect(observations.map(({ event }) => event.kind)).toEqual([
      'ModelRequest',
      'BudgetDebited',
      'BudgetDebited',
      'BudgetDebited',
      'ModelMessageCompleted',
      'ModelRequest',
      'BudgetDebited',
      'BudgetDebited',
      'BudgetDebited',
      'ModelMessageCompleted',
    ]);
    const consumed = resourceBudget.snapshot();
    expect(consumed.providerRequests).toBe(2);
    const completedUsage = observations.flatMap(({ event }) =>
      event.kind === 'ModelMessageCompleted' ? [event.usage] : [],
    );
    expect(completedUsage.some((usage) => usage.cacheReadTokens + usage.cacheWriteTokens > 0)).toBe(
      true,
    );
    expect(consumed.providerInputTokens).toBe(
      completedUsage.reduce(
        (total, usage) =>
          total + usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        0,
      ),
    );
    expect(Number.isSafeInteger(consumed.providerOutputTokens)).toBe(true);
    expect(consumed.providerSpendMicroUsd).toBe(0);
  });

  it('returns the exact unavailable credential disposition without constructing a session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const plan = harness('devrandom-faux', 'executor');
    const open = vi.fn<PiModelAccess['open']>(() =>
      Promise.resolve({ kind: 'CredentialUnavailable' }),
    );
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Inspect src/index.ts.',
      modelAccess: { open },
      budget: budget(run, recorder),
      gateway: { propose: vi.fn() },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'ModelCredentialUnavailable',
    });
    expect(open).toHaveBeenCalledOnce();
  });

  it('aborts the session at a gateway approval boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-approval-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    const plan = harness(faux.provider.id, faux.getModel().id);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('read_file', { path: 'src/index.ts' }, { id: 'tool-call-approval' }),
        { stopReason: 'toolUse' },
      ),
    ]);
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Inspect src/index.ts.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: { propose: () => Promise.resolve({ kind: 'ApprovalRequired' }) },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'ApprovalRequired',
    });
  });

  it.each([
    { outputTokens: 2_001, artifactAdmission: 'Stored' },
    { outputTokens: 100_001, artifactAdmission: 'Stored' },
    { outputTokens: 2_001, artifactAdmission: 'SecretDetected' },
  ] as const)(
    'settles $outputTokens output tokens with $artifactAdmission evidence before budget stop',
    async ({ outputTokens, artifactAdmission }) => {
      const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-budget-completion-'));
      worktrees.push(directory);
      const faux = fauxProvider({
        provider: 'devrandom-completion-budget-faux',
        models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
      });
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
      const toolText = 'read_file:{"path":"src/index.ts"}';
      const message = fauxAssistantMessage(
        [
          { type: 'text', text: 'x'.repeat(outputTokens * 4 - toolText.length - 1) },
          fauxToolCall('read_file', { path: 'src/index.ts' }, { id: 'over-budget-tool' }),
        ],
        { stopReason: 'toolUse' },
      );
      faux.setResponses([message]);
      const plan = harness(faux.provider.id, faux.getModel().id);
      const run = runningRun(plan.revision);
      const observations: EvidenceObservation[] = [];
      const recorder = evidence(observations);
      if (artifactAdmission === 'SecretDetected')
        recorder.storeArtifact = () => ({ kind: 'SecretDetected' });
      const propose = vi.fn();
      const executor = new BaselinePiExecutor({
        protectedCredentials: new ProtectedCredentials(),
        worktree: directory,
        agentDirectory: join(directory, '.agent-unused'),
        harness: plan.revision,
        instructions: plan.instructions,
        prompt: 'Inspect src/index.ts.',
        modelAccess: {
          open: () =>
            Promise.resolve({
              kind: 'Opened',
              consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 17 }),
              runtime,
              model: {
                ...faux.getModel(),
                cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              },
            }),
        },
        budget: budget(run, recorder),
        gateway: { propose },
        evidence: recorder,
        now: () => '2026-09-24T20:00:02.000Z',
        sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: (index) => `turn-${String(index)}`,
      });
      await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
        kind: artifactAdmission === 'SecretDetected' ? 'SecretDetected' : 'BudgetExhausted',
      });
      expect(faux.state.callCount).toBe(1);
      expect(propose).not.toHaveBeenCalled();
      expect(
        observations
          .filter(
            ({ event }) =>
              event.kind === 'BudgetDebited' && event.budget === 'providerSpendMicroUsd',
          )
          .map(({ event }) => event),
      ).toEqual([
        { kind: 'BudgetDebited', budget: 'providerSpendMicroUsd', amount: 17, consumed: 17 },
      ]);
      if (artifactAdmission === 'SecretDetected') {
        expect(observations.some(({ event }) => event.kind === 'ModelMessageCompleted')).toBe(
          false,
        );
        return;
      }
      expect(
        observations.flatMap(({ event }) =>
          event.kind === 'ModelMessageCompleted' ? [event] : [],
        ),
      ).toEqual([
        {
          kind: 'ModelMessageCompleted',
          piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
          modelTurnId: 'turn-0',
          messageArtifactSaid: expect.stringMatching(/^E[A-Za-z0-9_-]{43}$/u) as unknown,
          disposition: 'Completed',
          usage: {
            inputTokens: expect.any(Number) as unknown,
            outputTokens,
            cacheReadTokens: expect.any(Number) as unknown,
            cacheWriteTokens: expect.any(Number) as unknown,
            spendMicroUsd: 17,
          },
        },
      ]);
    },
  );

  it('stops before tool effects when normalized usage lacks a verified raw report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-missing-usage-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-usage-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('read_file', { path: 'src/index.ts' }, { id: 'unaccounted-tool' }),
        { stopReason: 'toolUse' },
      ),
    ]);
    const plan = harness(faux.provider.id, faux.getModel().id);
    const run = runningRun(plan.revision);
    const observations: EvidenceObservation[] = [];
    const recorder = evidence(observations);
    const resourceBudget = budget(run, recorder);
    const propose = vi.fn();
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Inspect src/index.ts.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            runtime,
            model: faux.getModel(),
            consumeUsage: () => ({ kind: 'Unavailable' }),
          }),
      },
      budget: resourceBudget,
      gateway: { propose },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });
    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'ModelUsageUnavailable',
    });
    expect(faux.state.callCount).toBe(1);
    expect(propose).not.toHaveBeenCalled();
    expect(resourceBudget.snapshot()).toEqual({ ...run.consumedBudget, providerRequests: 1 });
    expect(observations.map(({ event }) => event)).toEqual([
      {
        kind: 'ModelRequest',
        piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: 'turn-0',
        provider: faux.provider.id,
        model: faux.getModel().id,
        maximumOutputTokens: 2_000,
      },
      { kind: 'BudgetDebited', budget: 'providerRequests', amount: 1, consumed: 1 },
    ]);
  });

  it('does not start the provider when its conservative request reservation cannot fit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-budget-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    faux.setResponses([fauxAssistantMessage('must not start')]);
    const plan = harness(faux.provider.id, faux.getModel().id);
    const availableRun = runningRun(plan.revision);
    const run: Run = {
      ...availableRun,
      consumedBudget: {
        ...availableRun.consumedBudget,
        providerRequests: availableRun.binding.budget.providerRequests,
      },
    };
    const recorder = evidence([]);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Do not reach the provider.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: { propose: vi.fn() },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'BudgetExhausted',
    });
    expect(faux.state.callCount).toBe(0);
  });

  it('uses the complete UTF-8 input allowance before admitting a provider request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-budget-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    faux.setResponses([fauxAssistantMessage('must not start')]);
    const plan = harness(faux.provider.id, faux.getModel().id);
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: '界'.repeat(35_000),
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: { propose: vi.fn() },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'ContextLimitReached',
      measurement: {
        kind: 'InitialInput',
        encodedBytes: 106_284,
        allowedInputTokens: 98_000,
        providerRequestsAdmitted: 0,
      },
    });
    expect(faux.state.callCount).toBe(0);
  });

  it.each(['Accepted', 'ProviderRejected'] as const)(
    'allows an ASCII continuation within model context while preserving %s provider custody',
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-context-'));
      worktrees.push(directory);
      const faux = fauxProvider({
        provider: 'concentrate',
        models: [{ id: 'deepinfra/gemma-4-e4b', contextWindow: 100_000, maxTokens: 8_000 }],
      });
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
      const text = 'public compatibility observation '.repeat(180);
      faux.setResponses([
        ...Array.from({ length: 18 }, () => fauxAssistantMessage(text)),
        outcome === 'Accepted'
          ? fauxAssistantMessage(
              fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'context-submit' }),
              { stopReason: 'toolUse' },
            )
          : () => {
              throw new Error('provider context_length_exceeded');
            },
      ]);
      const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
      const run = runningRun(plan.revision);
      const observations: EvidenceObservation[] = [];
      const recorder = evidence(observations);
      const propose = vi.fn(() =>
        Promise.resolve({
          kind: 'SubmissionVerified' as const,
          disposition: 'Accepted' as const,
          summary: 'Public verification accepted.',
          outputArtifactSaids: [],
        }),
      );
      const executor = new BaselinePiExecutor({
        protectedCredentials: new ProtectedCredentials(),
        worktree: directory,
        agentDirectory: join(directory, '.agent-unused'),
        harness: plan.revision,
        instructions: plan.instructions,
        prompt: 'Attempt the public task and submit the result.',
        modelAccess: {
          open: () =>
            Promise.resolve({
              kind: 'Opened',
              runtime,
              model: faux.getModel(),
              consumeUsage: (message) =>
                message.stopReason === 'error'
                  ? { kind: 'Unavailable' }
                  : { kind: 'Verified', spendMicroUsd: 0 },
            }),
        },
        budget: budget(run, recorder),
        gateway: { propose },
        evidence: recorder,
        now: () => '2026-09-24T20:00:02.000Z',
        sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: (index) => `turn-${String(index)}`,
      });

      await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual(
        outcome === 'Accepted'
          ? { kind: 'Completed', sessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875' }
          : { kind: 'ModelUsageUnavailable' },
      );
      expect(faux.state.callCount).toBe(19);
      expect(propose).toHaveBeenCalledTimes(outcome === 'Accepted' ? 1 : 0);
      expect(observations.some(({ event }) => event.kind === 'ModelMessageCompleted')).toBe(true);
    },
  );

  it('measures a blocked ASCII continuation after admitted provider requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-context-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'concentrate',
      models: [{ id: 'deepinfra/gemma-4-e4b', contextWindow: 11_000, maxTokens: 2_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    faux.setResponses(
      Array.from({ length: 5 }, () =>
        fauxAssistantMessage('public compatibility observation '.repeat(150)),
      ),
    );
    const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
    const revision = {
      ...plan.revision,
      modelCompatibility: { ...plan.revision.modelCompatibility, contextWindowTokens: 11_000 },
    };
    const run = runningRun(revision);
    const recorder = evidence([]);
    const propose = vi.fn();
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: revision,
      instructions: plan.instructions,
      prompt: 'Attempt the public task and submit the result.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            runtime,
            model: faux.getModel(),
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
          }),
      },
      budget: budget(run, recorder),
      gateway: { propose },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    const outcome = await executor.invoke(run, new AbortController().signal);
    expect(faux.state.callCount).toBeLessThan(5);
    expect(outcome.kind).toBe('ContextLimitReached');
    if (outcome.kind !== 'ContextLimitReached') return;
    expect(outcome.measurement.kind).toBe('ProviderRequest');
    if (outcome.measurement.kind !== 'ProviderRequest') return;
    expect(outcome.measurement.profile).toBe('AsciiGemmaEstimate');
    expect(outcome.measurement.providerRequestsAdmitted).toBeGreaterThan(0);
    expect(outcome.measurement.providerRequestsAdmitted).toBe(faux.state.callCount);
    expect(outcome.measurement.admissionEstimateTokens).toBeGreaterThan(
      outcome.measurement.allowedInputTokens,
    );
    expect(outcome.measurement.encodedBytes).toBeGreaterThan(0);
    expect(outcome.measurement.piEstimateTokens).toBeGreaterThan(0);
    expect(propose).not.toHaveBeenCalled();
  });

  it.each(['Accepted', 'CompatibilityFailure'] as const)(
    'terminates after submit_result establishes %s',
    async (disposition) => {
      const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
      worktrees.push(directory);
      const faux = fauxProvider({
        provider: 'devrandom-submission-faux',
        models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
      });
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'submit-call' }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('This second provider request must never occur.'),
      ]);
      const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
      const run = runningRun(plan.revision);
      const recorder = evidence([]);
      const executor = new BaselinePiExecutor({
        protectedCredentials: new ProtectedCredentials(),
        worktree: directory,
        agentDirectory: join(directory, '.agent-unused'),
        harness: plan.revision,
        instructions: plan.instructions,
        prompt: 'Submit the result.',
        modelAccess: {
          open: () =>
            Promise.resolve({
              kind: 'Opened',
              consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
              runtime,
              model: faux.getModel(),
            }),
        },
        budget: budget(run, recorder),
        gateway: {
          propose: () =>
            Promise.resolve({
              kind: 'SubmissionVerified',
              disposition,
              summary: 'Public verification retained.',
              outputArtifactSaids: [],
            }),
        },
        evidence: recorder,
        now: () => '2026-09-24T20:00:02.000Z',
        sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: (index) => `turn-${String(index)}`,
      });

      await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
        kind: 'Completed',
        sessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      });
      expect(faux.state.callCount).toBe(1);
    },
  );

  it('continues the same Pi session after ordinary submission rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-submission-rejection-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    const outputArtifactSaid = `E${'q'.repeat(43)}`;
    const diagnostic = `public-test: expected 3, received 4\nstdout [${outputArtifactSaid}]: assertion failed`;
    let secondRequest = '';
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'submit-call' }),
        { stopReason: 'toolUse' },
      ),
      (context) => {
        secondRequest = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'submit-again' }),
          { stopReason: 'toolUse' },
        );
      },
    ]);
    const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    let proposals = 0;
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Submit the result.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: {
        propose: () => {
          proposals += 1;
          return Promise.resolve({
            kind: 'SubmissionVerified',
            disposition: proposals === 1 ? 'Rejected' : 'Accepted',
            summary:
              proposals === 1
                ? `Public verification rejected: repair the task.\n${diagnostic}`
                : 'Public verification accepted.',
            outputArtifactSaids: [outputArtifactSaid],
          });
        },
      },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'Completed',
      sessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    });
    expect(faux.state.callCount).toBe(2);
    expect(proposals).toBe(2);
    expect(secondRequest).toContain('Public verification rejected: repair the task.');
    expect(secondRequest).toContain('public-test: expected 3, received 4');
    expect(secondRequest).toContain(`stdout [${outputArtifactSaid}]`);
  });

  it('stops after user interruption following repeated rejected submissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-submission-interrupted-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    let secondRequest = '';
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'first-submit' }),
        { stopReason: 'toolUse' },
      ),
      (context) => {
        secondRequest = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'second-submit' }),
          { stopReason: 'toolUse' },
        );
      },
      fauxAssistantMessage('A third provider request must not occur.'),
    ]);
    const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    const interruption = new AbortController();
    let proposals = 0;
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Submit the result.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: {
        propose: () => {
          proposals += 1;
          if (proposals === 2)
            queueMicrotask(() => {
              interruption.abort();
            });
          return Promise.resolve({
            kind: 'SubmissionVerified',
            disposition: 'Rejected',
            summary: `Public verification rejected attempt ${String(proposals)}.`,
            outputArtifactSaids: [],
          });
        },
      },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, interruption.signal)).resolves.toEqual({ kind: 'Aborted' });
    expect(proposals).toBe(2);
    expect(faux.state.callCount).toBe(2);
    expect(secondRequest).toContain('Public verification rejected attempt 1.');
  });

  it('continues the same session when model prose claims completion without submit_result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-pi-executor-'));
    worktrees.push(directory);
    const faux = fauxProvider({
      provider: 'devrandom-submission-reminder-faux',
      models: [{ id: 'executor', contextWindow: 100_000, maxTokens: 8_000 }],
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, 'test-only-key');
    let secondRequest = '';
    faux.setResponses([
      fauxAssistantMessage('The work is complete.'),
      (context) => {
        secondRequest = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxToolCall('submit_result', { artifactSaids: [] }, { id: 'submit-after-reminder' }),
          { stopReason: 'toolUse' },
        );
      },
    ]);
    const plan = harness(faux.provider.id, faux.getModel().id, ['SubmitResult']);
    const run = runningRun(plan.revision);
    const recorder = evidence([]);
    const executor = new BaselinePiExecutor({
      protectedCredentials: new ProtectedCredentials(),
      worktree: directory,
      agentDirectory: join(directory, '.agent-unused'),
      harness: plan.revision,
      instructions: plan.instructions,
      prompt: 'Submit the result.',
      modelAccess: {
        open: () =>
          Promise.resolve({
            kind: 'Opened',
            consumeUsage: () => ({ kind: 'Verified', spendMicroUsd: 0 }),
            runtime,
            model: faux.getModel(),
          }),
      },
      budget: budget(run, recorder),
      gateway: {
        propose: () =>
          Promise.resolve({
            kind: 'SubmissionVerified',
            disposition: 'Accepted',
            summary: 'Public verification retained.',
            outputArtifactSaids: [],
          }),
      },
      evidence: recorder,
      now: () => '2026-09-24T20:00:02.000Z',
      sessionId: () => '46df3dc0-ff4f-4607-9c25-cad3b378e875',
      modelTurnId: (index) => `turn-${String(index)}`,
    });

    await expect(executor.invoke(run, new AbortController().signal)).resolves.toEqual({
      kind: 'Completed',
      sessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    });
    expect(faux.state.callCount).toBe(2);
    expect(secondRequest).toContain('The Task has no accepted submission');
    expect(secondRequest).toContain('artifactSaids: []');
    expect(secondRequest).toContain('submit the current work even if a public check still fails');
  });
});
