import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvaluationExecutionProfile,
  prepareEvaluationManifest,
  prepareEvidenceArtifact,
  prepareEvolutionHypothesis,
  prepareSuccessorHarnessRevision,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { createConcentrateProvider } from '../../pi/concentrate-provider.js';
import { ConcentrateUsage } from '../../pi/concentrate-usage.js';
import {
  DockerContainedTrialExecution,
  measureEvaluationSourceChanges,
} from './contained-trial-execution.js';
import { digestEvaluationRuntimeMounts } from './runtime-mount-digest.js';
import { digestRunRuntimePrompt } from '../../run/run-execution-profile-custody.js';
import { GitCandidateTreatmentCustody } from './git-candidate-treatment-custody.js';
import { GitC2WorkflowTreatmentCustody } from './git-c2-workflow-treatment-custody.js';
import { ReviewedC3ContextSelection } from '../application/c3-context-selection.js';
import { SourceCustody } from './source-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const exec = promisify(execFile);
async function git(directory: string, ...arguments_: string[]): Promise<string> {
  return (await exec('git', ['-C', directory, ...arguments_], { encoding: 'utf8' })).stdout.trim();
}

it('measures added, removed, and rewritten stopped source bytes before budget debit', () => {
  const bytes = (value: string): Uint8Array => Buffer.from(value);
  expect(
    measureEvaluationSourceChanges(
      [
        { path: 'modified', bytes: bytes('before\n') },
        { path: 'deleted', bytes: bytes('old') },
        { path: 'unchanged', bytes: bytes('same') },
      ],
      [
        { path: 'modified', bytes: bytes('after\n') },
        { path: 'added', bytes: bytes('added') },
        { path: 'unchanged', bytes: bytes('same') },
      ],
    ),
  ).toEqual({
    changedFiles: 3,
    changedWorktreeBytes: 15,
    paths: ['added', 'deleted', 'modified'],
  });
  expect(
    measureEvaluationSourceChanges(
      [
        { path: 'duplicate', bytes: bytes('a') },
        { path: 'duplicate', bytes: bytes('b') },
      ],
      [],
    ),
  ).toBeUndefined();
});

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'real parent to contained trial relay',
  () => {
    it.each([
      'Verified',
      'Unaccountable',
      'UnverifiedCursor',
      'LegacyCursor',
      'Cumulative',
      'CommandTool',
      'CommandCompleted',
      'CommandUnknown',
      'C1Verified',
      'C3Selected',
      'C2Blocked',
      'C3Blocked',
    ] as const)(
      'mediates a provider-origin edit with %s parent usage and custody-backed E3 debits',
      async (usage) => {
        const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
        const root = await mkdtemp(join(tmpdir(), 'devrandom-trial-integration-'));
        try {
          const c1 = usage === 'C1Verified';
          const c3 = usage === 'C3Selected';
          const baseSystemPrompt = 'Use the mediated tools.';
          const taskPrompt = 'Change src/lib.rs to after.';
          const taskId = randomUUID();
          const originRunId = randomUUID();
          let h1:
            | Extract<
                ReturnType<typeof prepareBaselineHarnessRevision>,
                { kind: 'Prepared' }
              >['revision']
            | undefined;
          let candidateCommit = '';
          let candidateTree = '';
          let treatmentBytes = new Uint8Array();
          let implementationBytes = new Uint8Array();
          const candidateRepository = join(root, 'candidate-repository');
          if (c1 || c3) {
            await git(root, 'init', candidateRepository);
            await writeFile(join(candidateRepository, 'README.md'), 'H1 source\n');
            await git(candidateRepository, 'add', 'README.md');
            await git(
              candidateRepository,
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.test',
              'commit',
              '-m',
              'H1',
            );
            const parentCommit = await git(candidateRepository, 'rev-parse', 'HEAD');
            const parentTree = await git(candidateRepository, 'rev-parse', 'HEAD^{tree}');
            const instruction = identifyHarnessInstruction({
              path: 'AGENTS.md',
              content: '# H1\n',
            });
            const completion = identifyHarnessCompletionCommand(
              {
                id: 'public-test',
                argv: ['just', 'test-public'],
                timeoutSeconds: 120,
                expected: { kind: 'exitCode', code: 0 },
              },
              '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
            );
            if (instruction.kind !== 'Identified' || completion.kind !== 'Identified')
              throw new Error('H1 fixture');
            const prepared = prepareBaselineHarnessRevision({
              task: {
                taskId,
                revisionSaid: said('a'),
                harnessLineageId: randomUUID(),
                requestedCapabilities: ['ReadRepository'],
              },
              authority: {
                personalAgentAid: said('c'),
                taskMandateSaid: said('d'),
                allowedCapabilities: ['ReadRepository'],
              },
              repository: {
                objectFormat: 'sha1',
                commit: parentCommit,
                tree: parentTree,
                instructionResources: [instruction.resource],
              },
              completionCommands: [completion.command],
              toolCommands: [],
              modelCompatibility: {
                provider: 'concentrate',
                model: 'deepinfra/gemma-4-e4b',
                contextWindowTokens: 100000,
                maximumOutputTokens: 128,
                thinkingLevel: 'off',
                credentialSource: 'TEST_API_KEY',
                toolCalls: 'Supported',
                usageAccounting: 'Required',
              },
              environmentCompatibility: {
                operatingSystem: 'linux',
                architecture: 'arm64',
                nodeVersion: '24.20.0',
                gitVersion: '2.51.0',
                piSdkVersion: '0.87.1',
                xstateVersion: '5.33.2',
              },
              capabilities: { available: ['ReadRepository'], unavailable: [] },
              budgetCeilings: {
                task: taskBudgetCeilings,
                server: taskBudgetCeilings,
                mandate: taskBudgetCeilings,
              },
            });
            if (prepared.kind !== 'Prepared') throw new Error('H1 fixture rejected');
            h1 = prepared.revision;
            await mkdir(join(candidateRepository, '.devrandom/evolution'), { recursive: true });
            treatmentBytes = Buffer.from(
              JSON.stringify(
                c1
                  ? {
                      version: 1,
                      arm: 'C1',
                      instructionText: 'Use the reviewed C1 instruction.',
                    }
                  : {
                      version: 1,
                      arm: 'C3',
                      formatMarker: 'CESR-v1',
                      triggerPaths: ['src/lib.rs'],
                      priority: ['Failure', 'Contract', 'Edit'],
                      maximumItems: 1,
                      maximumContextBytes: 4096,
                    },
              ),
            );
            await writeFile(
              join(candidateRepository, '.devrandom/evolution/treatment.json'),
              treatmentBytes,
            );
            if (c3) {
              implementationBytes = Buffer.from(
                JSON.stringify({
                  version: 1,
                  kind: 'VersionedFormatContextSelection',
                  algorithm: 'ExactPublicHistoryV1',
                }),
              );
              await writeFile(
                join(candidateRepository, '.devrandom/evolution/implementation.bin'),
                implementationBytes,
              );
            }
            await git(candidateRepository, 'add', '.devrandom/evolution');
            await git(
              candidateRepository,
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.test',
              'commit',
              '-m',
              c1 ? 'C1' : 'C3',
            );
            candidateCommit = await git(candidateRepository, 'rev-parse', 'HEAD');
            candidateTree = await git(candidateRepository, 'rev-parse', 'HEAD^{tree}');
          }
          const workerMounts = [
            {
              hostPath: resolve('packages/runtime/dist'),
              containerPath: '/app/packages/runtime/dist',
              writable: false,
            },
            {
              hostPath: resolve('packages/runtime/package.json'),
              containerPath: '/app/packages/runtime/package.json',
              writable: false,
            },
            {
              hostPath: resolve('packages/runtime/node_modules'),
              containerPath: '/app/packages/runtime/node_modules',
              writable: false,
            },
            {
              hostPath: resolve('node_modules/.pnpm'),
              containerPath: '/app/node_modules/.pnpm',
              writable: false,
            },
          ] as const;
          const runtimeDigest = await digestEvaluationRuntimeMounts(workerMounts);
          const source = join(root, 'clean');
          await mkdir(join(source, 'src'), { recursive: true });
          await writeFile(join(source, 'src/lib.rs'), 'before\n');
          const custody = new SourceCustody(join(root, 'custody'), {
            maximumFiles: 64,
            maximumBytes: 1024 * 1024,
            maximumPathBytes: 256,
          });
          const clean = await custody.capture(source, () => Promise.resolve(false));
          expect(clean.kind).toBe('Captured');
          if (clean.kind !== 'Captured') return;
          const profile = prepareEvaluationExecutionProfile({
            os: 'linux',
            architecture: 'aarch64',
            imageDigest: image.slice(image.lastIndexOf('@') + 1),
            runtimeDigest,
            toolchainDigest: `sha256:${'2'.repeat(64)}`,
            sourceGitCommit: h1?.repository.commit ?? '3'.repeat(40),
            sourceGitTree: h1?.repository.tree ?? '4'.repeat(40),
            h1InstructionSaid: said('i'),
            h1RuntimePromptDigest:
              c1 || c3
                ? digestRunRuntimePrompt(baseSystemPrompt, taskPrompt)
                : `sha256:${'5'.repeat(64)}`,
            effectiveLimitsReceiptSaid: said('l'),
            parentDeathCleanupReceiptSaid: said('p'),
            modelProvider: 'concentrate',
            modelId: 'deepinfra/gemma-4-e4b',
            thinkingLevel: 'off',
            maximumOutputTokens: 128,
            limits: {
              cpuCount: 1,
              memoryBytes: 512 * 1024 * 1024,
              processCount: 32,
              scratchBytes: 128 * 1024 * 1024,
              outputBytes: 128 * 1024,
              wallTimeSeconds: 60,
            },
            containment: {
              nonRoot: true,
              readOnlyRuntime: true,
              networkDisabled: true,
              privilegesDropped: true,
              restrictedIpc: true,
              parentDeathCleanup: true,
            },
          });
          expect(profile.kind).toBe('Prepared');
          if (profile.kind !== 'Prepared') return;
          const c1Artifact = c1
            ? prepareEvidenceArtifact(treatmentBytes, 'application/json')
            : undefined;
          if (c1 && c1Artifact?.kind !== 'Prepared') throw new Error('C1 artifact fixture');
          const c1Successor =
            c1 && h1 !== undefined && c1Artifact?.kind === 'Prepared'
              ? prepareSuccessorHarnessRevision({
                  parentRevisionSaid: h1.d,
                  arm: 'C1',
                  h0Said: said('H'),
                  taskRevisionSaid: h1.task.revisionSaid,
                  sourceInventorySaid: said('m'),
                  executionProfileSaid: profile.profile.d,
                  configurationArtifactSaid: c1Artifact.artifact.d,
                  treatment: { kind: 'Instruction' },
                })
              : undefined;
          if (c1 && c1Successor?.kind !== 'Prepared') throw new Error('C1 successor fixture');
          const c3Hypothesis =
            c3 && h1 !== undefined
              ? prepareEvolutionHypothesis({
                  taskId,
                  taskRevisionSaid: said('a'),
                  originRunId,
                  retainedCheckpointSaid: said('e'),
                  retainedSealSaid: said('f'),
                  parentRevisionSaid: h1.d,
                  personalAgentAid: said('c'),
                  sourceInventorySaid: said('m'),
                  retrievalReceiptSaid: said('Q'),
                  failure: { eventSaid: said('F'), rawEvidenceSaid: said('R') },
                  source: { episodeSaid: said('S'), rawEvidenceSaid: said('T') },
                  implicatedComponent: 'ContextSelection',
                  predictedCorrection: 'Select relevant public CESR history.',
                  publicReplay: {
                    failureWindowSaid: said('W'),
                    configurationSaid: said('G'),
                    nonTreatmentInputsSaid: said('N'),
                    failureQuery: 'CESR versioned format',
                    predictedAction: 'Apply current version formatting',
                    predictedSourceChoiceSaid: said('C'),
                    assertion: 'Relevant history changes the format choice.',
                  },
                  falsifier: 'Selection fails to change the format choice.',
                  regressionRisks: ['Protected context disclosure'],
                  rejectedExplanations: ['Citation-only change'],
                })
              : undefined;
          if (c3 && c3Hypothesis?.kind !== 'Prepared') throw new Error('C3 H0 fixture');
          const c3Configuration = c3
            ? prepareEvidenceArtifact(treatmentBytes, 'application/json')
            : undefined;
          const c3Implementation = c3
            ? prepareEvidenceArtifact(implementationBytes, 'application/octet-stream')
            : undefined;
          const c3Replay = c3
            ? prepareEvidenceArtifact(
                Buffer.from('{"version":1,"kind":"ReviewedPublicReplay"}'),
                'application/json',
              )
            : undefined;
          if (
            c3 &&
            (c3Configuration?.kind !== 'Prepared' ||
              c3Implementation?.kind !== 'Prepared' ||
              c3Replay?.kind !== 'Prepared')
          )
            throw new Error('C3 treatment artifact fixture');
          const c3Successor =
            c3 &&
            h1 !== undefined &&
            c3Hypothesis?.kind === 'Prepared' &&
            c3Configuration?.kind === 'Prepared' &&
            c3Implementation?.kind === 'Prepared' &&
            c3Replay?.kind === 'Prepared'
              ? prepareSuccessorHarnessRevision({
                  parentRevisionSaid: h1.d,
                  arm: 'C3',
                  h0Said: c3Hypothesis.hypothesis.d,
                  taskRevisionSaid: h1.task.revisionSaid,
                  sourceInventorySaid: said('m'),
                  executionProfileSaid: profile.profile.d,
                  configurationArtifactSaid: c3Configuration.artifact.d,
                  treatment: {
                    kind: 'ContextSelection',
                    reviewedImplementationSaid: c3Implementation.artifact.d,
                    publicReplayReceiptSaid: c3Replay.artifact.d,
                  },
                })
              : undefined;
          if (c3 && c3Successor?.kind !== 'Prepared') throw new Error('C3 successor fixture');
          const allowance = {
            providerRequests: 3,
            providerInputTokens: 3000,
            providerOutputTokens: 300,
            providerSpendMicroUsd: 300,
            runWallTimeSeconds: 60,
            toolProposals: 10,
            aggregateChildCommandTimeSeconds: 60,
            changedFiles: 3,
            changedWorktreeBytes: 10_000,
            evidencePlusArtifactsPerRunBytes: 100_000,
          };
          const manifest = prepareEvaluationManifest({
            evaluationId: randomUUID(),
            taskId,
            taskRevisionSaid: said('a'),
            originRunId,
            ownerAid: said('b'),
            personalAgentAid: said('c'),
            taskMandateSaid: said('d'),
            retainedCheckpointSaid: said('e'),
            retainedSealSaid: said('f'),
            policySaid: said('g'),
            revisions: {
              H1: h1?.d ?? said('h'),
              C1: c1Successor?.kind === 'Prepared' ? c1Successor.revision.d : said('j'),
              C2: said('k'),
              C3: c3Successor?.kind === 'Prepared' ? c3Successor.revision.d : said('n'),
            },
            executionProfileSaid: profile.profile.d,
            sourceInventorySaid: said('m'),
            hypothesisSaid:
              c3Hypothesis?.kind === 'Prepared' ? c3Hypothesis.hypothesis.d : said('H'),
            verifierSaid: said('v'),
            protectedCaseArtifactSaid: said('o'),
            finalCaseArtifactSaid: said('p'),
            publicConditionIds: ['cesr-current'],
            heldOutCaseCount: 1,
            allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
          });
          expect(manifest.kind).toBe('Prepared');
          if (manifest.kind !== 'Prepared') return;
          const slot = {
            arm: c1
              ? ('C1' as const)
              : usage === 'C2Blocked'
                ? ('C2' as const)
                : usage === 'C3Blocked' || usage === 'C3Selected'
                  ? ('C3' as const)
                  : ('H1' as const),
            repetition: 1 as const,
            attempt: 1 as const,
          };
          const binding = {
            kind: 'Evaluation' as const,
            taskId: manifest.manifest.taskId,
            taskRevisionSaid: manifest.manifest.taskRevisionSaid,
            originRunId: manifest.manifest.originRunId,
            personalAgentAid: manifest.manifest.personalAgentAid,
            taskMandateSaid: manifest.manifest.taskMandateSaid,
            harnessRevisionSaid:
              slot.arm === 'H1'
                ? manifest.manifest.revisions.H1
                : manifest.manifest.revisions[slot.arm],
            evaluationId: manifest.manifest.evaluationId,
            evaluationLeaseId: randomUUID(),
            evidenceStreamId: randomUUID(),
            phase: { kind: 'Trial' as const, manifestSaid: manifest.manifest.d, ...slot },
          };
          const models = await ModelRuntime.create({
            modelsPath: null,
            allowModelNetwork: false,
            refreshOnCreate: false,
          });
          models.registerNativeProvider(createConcentrateProvider(new ConcentrateUsage()));
          const model = models.getModel('concentrate', 'deepinfra/gemma-4-e4b');
          expect(model).toBeDefined();
          if (model === undefined) return;
          const events: EvaluationEvidenceEvent[] = [];
          const rawSaids: string[] = [];
          const toolCalls: unknown[] = [];
          const modelContexts: unknown[] = [];
          const currentHistoryBytes = Buffer.from('Reviewed public CESR-v1 format failure.');
          const staleHistoryBytes = Buffer.from('Legacy CESR-v0 history.');
          const currentHistory = prepareEvidenceArtifact(
            currentHistoryBytes,
            'text/plain; charset=utf-8',
          );
          const staleHistory = prepareEvidenceArtifact(
            staleHistoryBytes,
            'text/plain; charset=utf-8',
          );
          if (currentHistory.kind !== 'Prepared' || staleHistory.kind !== 'Prepared')
            throw new Error('C3 source fixture');
          const commandTool = ['CommandTool', 'CommandCompleted', 'CommandUnknown'].includes(usage);
          const trial = new DockerContainedTrialExecution({
            profile: profile.profile,
            image,
            model,
            modelProfileSaid: said('q'),
            systemPrompt: baseSystemPrompt,
            prompt: taskPrompt,
            ...(c1 &&
            h1 !== undefined &&
            c1Successor?.kind === 'Prepared' &&
            c1Artifact?.kind === 'Prepared'
              ? {
                  c1Treatment: {
                    reviewed: {
                      h1,
                      successorRevisionSaid: c1Successor.revision.d,
                      binding: {
                        parentRevisionSaid: h1.d,
                        arm: 'C1' as const,
                        h0Said: said('H'),
                        taskRevisionSaid: h1.task.revisionSaid,
                        sourceInventorySaid: said('m'),
                        executionProfileSaid: profile.profile.d,
                      },
                      treatment: c1Successor.revision.treatment,
                      configuration: c1Artifact.artifact,
                    },
                    successorBytes: Buffer.from(JSON.stringify(c1Successor.revision)),
                    repositoryDirectory: candidateRepository,
                    candidateCommit,
                    candidateTree,
                    custody: new GitCandidateTreatmentCustody(),
                  },
                }
              : {}),
            ...(c3 &&
            h1 !== undefined &&
            c3Hypothesis?.kind === 'Prepared' &&
            c3Successor?.kind === 'Prepared' &&
            c3Configuration?.kind === 'Prepared' &&
            c3Implementation?.kind === 'Prepared' &&
            c3Replay?.kind === 'Prepared'
              ? {
                  c3Selection: new ReviewedC3ContextSelection({
                    hypothesis: c3Hypothesis.hypothesis,
                    reviewed: {
                      h1,
                      successorRevisionSaid: c3Successor.revision.d,
                      binding: {
                        parentRevisionSaid: h1.d,
                        arm: 'C3' as const,
                        h0Said: c3Hypothesis.hypothesis.d,
                        taskRevisionSaid: h1.task.revisionSaid,
                        sourceInventorySaid: said('m'),
                        executionProfileSaid: profile.profile.d,
                      },
                      treatment: c3Successor.revision.treatment,
                      configuration: c3Configuration.artifact,
                      implementation: c3Implementation.artifact,
                      replay: c3Replay.artifact,
                    },
                    successorBytes: Buffer.from(JSON.stringify(c3Successor.revision)),
                    repositoryDirectory: candidateRepository,
                    candidateCommit,
                    candidateTree,
                    custody: new GitC2WorkflowTreatmentCustody(),
                    history: {
                      read: () =>
                        Promise.resolve({
                          kind: 'Read' as const,
                          taskId,
                          taskRevisionSaid: said('a'),
                          sourceInventorySaid: said('m'),
                          sources: [
                            {
                              sourceId: currentHistory.artifact.d,
                              artifact: currentHistory.artifact,
                              bytes: currentHistoryBytes,
                              kind: 'Failure' as const,
                              version: 'CESR-v1',
                              custody: 'Public' as const,
                            },
                            {
                              sourceId: staleHistory.artifact.d,
                              artifact: staleHistory.artifact,
                              bytes: staleHistoryBytes,
                              kind: 'Contract' as const,
                              version: 'CESR-v0',
                              custody: 'Public' as const,
                            },
                          ],
                        }),
                    },
                    projection: {
                      project: (source) =>
                        Promise.resolve({
                          kind: 'Projected' as const,
                          sourceId: source.sourceId,
                          text: 'Use the current public CESR-v1 receipt format.',
                        }),
                    },
                  }),
                }
              : {}),
            enabledTools: ['write_file', 'run_tests'],
            maximumPrompts: 1,
            workerMounts,
            workerProgram: '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js',
            source: custody,
            cursor:
              usage === 'LegacyCursor'
                ? ({
                    nextSequence: 17,
                    previousEventSaid: said('z'),
                    consumed: {
                      providerRequests: 4,
                      providerInputTokens: 100,
                      providerOutputTokens: 20,
                      providerSpendMicroUsd: 3,
                      toolProposals: 2,
                    },
                  } as unknown as ConstructorParameters<
                    typeof DockerContainedTrialExecution
                  >[0]['cursor'])
                : usage === 'Cumulative'
                  ? {
                      nextSequence: 17,
                      previousEventSaid: said('z'),
                      consumed: {
                        providerRequests: 4,
                        providerInputTokens: 100,
                        providerOutputTokens: 20,
                        providerSpendMicroUsd: 3,
                        toolProposals: 2,
                        runWallTimeSeconds: 10,
                        aggregateChildCommandTimeSeconds: 2,
                        changedFiles: 1,
                        changedWorktreeBytes: 7,
                      },
                    }
                  : usage === 'UnverifiedCursor'
                    ? { nextSequence: 17, previousEventSaid: said('z') }
                    : { nextSequence: 0 },
            now: () => '2026-09-26T04:30:00.000Z',
            modelInference: {
              complete(input) {
                modelContexts.push(input.context);
                const content =
                  input.requestOrdinal === 0
                    ? commandTool
                      ? fauxToolCall(
                          'run_tests',
                          { commandId: 'public-test' },
                          { id: 'provider-call-1' },
                        )
                      : fauxToolCall(
                          'write_file',
                          {
                            path: 'src/lib.rs',
                            content: c3 ? 'after // CESR-v1\n' : 'after\n',
                          },
                          { id: 'provider-call-1' },
                        )
                    : 'Finished.';
                const message = {
                  ...fauxAssistantMessage(content, {
                    stopReason: input.requestOrdinal === 0 ? 'toolUse' : 'stop',
                  }),
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                };
                return Promise.resolve({
                  kind: 'Completed' as const,
                  message,
                  verifiedSpendMicroUsd: usage === 'Unaccountable' ? Number.NaN : 7,
                  providerReportBytes: new TextEncoder().encode(
                    JSON.stringify({
                      type: 'response.completed',
                      response: {
                        id: message.responseId,
                        model: message.model,
                        cost: { total: 0.000007 },
                        usage: {
                          input_tokens:
                            message.usage.input +
                            message.usage.cacheRead +
                            message.usage.cacheWrite,
                          output_tokens: message.usage.output,
                          total_tokens: message.usage.totalTokens,
                          input_tokens_details: {
                            cached_tokens: message.usage.cacheRead,
                            cache_write_tokens: message.usage.cacheWrite,
                          },
                        },
                      },
                    }),
                  ),
                });
              },
            },
            rawArtifacts: {
              async record(input) {
                const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
                if (prepared.kind !== 'Prepared') return { kind: 'Rejected' as const };
                const artifact = prepared.artifact;
                try {
                  await writeFile(join(root, artifact.d), input.bytes, { flag: 'wx' });
                } catch (error) {
                  if (
                    !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
                    !Buffer.from(await readFile(join(root, artifact.d))).equals(
                      Buffer.from(input.bytes),
                    )
                  )
                    throw error;
                }
                rawSaids.push(artifact.d);
                return { kind: 'Stored' as const, artifact };
              },
            },
            evidence: {
              record(event) {
                events.push(event);
                return Promise.resolve({
                  kind: 'Recorded' as const,
                  sequence: event.sequence,
                  headSaid: event.d,
                });
              },
              acknowledge(input) {
                return Promise.resolve({
                  kind: 'Acknowledged' as const,
                  throughSequence: input.throughSequence,
                  headSaid: input.expectedHeadSaid,
                });
              },
            },
            gatewayFor(compartment) {
              return {
                async propose(_binding, proposal) {
                  toolCalls.push(proposal);
                  if (proposal.input.kind === 'RunTests') {
                    if (usage === 'CommandTool')
                      return { kind: 'Rejected' as const, reason: 'CapabilityNotGranted' as const };
                    const effect = compartment.execute(['node', '-e', 'setTimeout(() => {}, 25)']);
                    const code = await new Promise<number | null>((resolveExit) =>
                      effect.once('close', resolveExit),
                    );
                    if (code !== 0)
                      return { kind: 'Rejected' as const, reason: 'ResourceDenied' as const };
                    return usage === 'CommandUnknown'
                      ? { kind: 'DependencyUnavailable' as const }
                      : {
                          kind: 'Completed' as const,
                          summary: 'native command completed',
                          outputArtifactSaids: [],
                        };
                  }
                  if (proposal.input.kind !== 'WriteFile')
                    return { kind: 'Rejected' as const, reason: 'CapabilityNotGranted' as const };
                  const effect = compartment.execute([
                    'node',
                    '-e',
                    'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
                    '/work/source/src/lib.rs',
                    proposal.input.content,
                  ]);
                  const code = await new Promise<number | null>((resolveExit) =>
                    effect.once('close', resolveExit),
                  );
                  return code === 0
                    ? {
                        kind: 'Completed' as const,
                        summary: 'file changed',
                        outputArtifactSaids: [],
                      }
                    : { kind: 'Rejected' as const, reason: 'ResourceDenied' as const };
                },
              };
            },
          });
          const result = await trial.run({
            binding,
            manifest: manifest.manifest,
            slot,
            cleanSourceSaid: clean.sourceSaid,
            reviewedBehaviorSaid:
              slot.arm === 'H1'
                ? manifest.manifest.revisions.H1
                : manifest.manifest.revisions[slot.arm],
            modelProfileSaid: said('q'),
            containerProfileSaid: profile.profile.d,
            signal: new AbortController().signal,
          });
          if (
            usage === 'UnverifiedCursor' ||
            usage === 'LegacyCursor' ||
            usage === 'C2Blocked' ||
            usage === 'C3Blocked'
          ) {
            expect(result).toMatchObject({ kind: 'Invalid', reason: 'ProfileDrift' });
            expect(events).toHaveLength(0);
            return;
          }
          if (usage === 'Unaccountable') {
            expect(result).toMatchObject({ kind: 'Invalid', reason: 'UnknownUsage' });
            expect(events.some((event) => event.detail.kind === 'TrialStopped')).toBe(false);
            expect(toolCalls).toHaveLength(0);
            return;
          }
          if (usage === 'CommandUnknown') {
            expect(result).toMatchObject({ kind: 'Invalid', reason: 'UnknownUsage' });
            expect(events.some((event) => event.detail.kind === 'TrialStopped')).toBe(false);
            return;
          }
          expect(result).toMatchObject({ kind: 'Stopped' });
          if (result.kind !== 'Stopped') return;
          if (commandTool) expect(result.capturedSourceSaid).toBe(clean.sourceSaid);
          else expect(result.capturedSourceSaid).not.toBe(clean.sourceSaid);
          const captured = await custody.open(result.capturedSourceSaid);
          expect(
            Buffer.from(
              captured?.files.find((file) => file.path === 'src/lib.rs')?.bytes ?? [],
            ).toString('utf8'),
          ).toBe(commandTool ? 'before\n' : c3 ? 'after // CESR-v1\n' : 'after\n');
          if (c3) {
            expect(JSON.stringify(modelContexts[0])).not.toContain('Reviewed public history');
            expect(JSON.stringify(modelContexts[1])).toContain('Reviewed public history');
            expect(JSON.stringify(modelContexts[1])).toContain(currentHistory.artifact.d);
            expect(JSON.stringify(modelContexts[1])).not.toContain(staleHistory.artifact.d);
            const receipts = await Promise.all(
              rawSaids.map(async (artifactSaid) => {
                try {
                  return JSON.parse(await readFile(join(root, artifactSaid), 'utf8')) as unknown;
                } catch {
                  return undefined;
                }
              }),
            );
            const selectionReceipt = receipts.find(
              (value) =>
                typeof value === 'object' &&
                value !== null &&
                'kind' in value &&
                value.kind === 'C3ContextSelectionApplied',
            );
            expect(selectionReceipt).toMatchObject({
              includedSourceIds: [currentHistory.artifact.d],
              excludedSourceIds: [staleHistory.artifact.d],
            });
            if (
              typeof selectionReceipt !== 'object' ||
              selectionReceipt === null ||
              !('providerInputTokensForRequest' in selectionReceipt)
            )
              throw new Error('C3 input-cost receipt missing.');
            expect(typeof selectionReceipt.providerInputTokensForRequest).toBe('number');
          }
          expect(toolCalls).toHaveLength(1);
          expect(events.map((event) => event.detail.kind)).toContain('ToolAuthorization');
          const debits = events.flatMap((event) =>
            event.detail.kind === 'EvaluationBudgetDebited' ? [event.detail] : [],
          );
          expect(debits.map((debit) => debit.budget)).toEqual([
            'providerRequests',
            'providerInputTokens',
            'providerOutputTokens',
            'providerSpendMicroUsd',
            'toolProposals',
            ...(commandTool ? ['aggregateChildCommandTimeSeconds'] : []),
            'providerRequests',
            'providerInputTokens',
            'providerOutputTokens',
            'providerSpendMicroUsd',
            'changedFiles',
            'changedWorktreeBytes',
            ...(commandTool ? [] : ['aggregateChildCommandTimeSeconds']),
            'runWallTimeSeconds',
          ]);
          if (usage === 'Cumulative') {
            expect(debits[0]?.consumed).toBe(5);
            expect(debits.find((debit) => debit.budget === 'toolProposals')?.consumed).toBe(3);
            expect(debits.find((debit) => debit.budget === 'changedFiles')?.consumed).toBe(2);
            expect(debits.find((debit) => debit.budget === 'changedWorktreeBytes')?.consumed).toBe(
              14,
            );
          }
          expect(debits.find((debit) => debit.budget === 'changedFiles')?.amount).toBe(
            commandTool ? 0 : 1,
          );
          expect(debits.find((debit) => debit.budget === 'changedWorktreeBytes')?.amount).toBe(
            commandTool ? 0 : c3 ? 17 : 7,
          );
          expect(
            debits.find((debit) => debit.budget === 'runWallTimeSeconds')?.amount,
          ).toBeGreaterThan(0);
          const childSeconds = debits.find(
            (debit) => debit.budget === 'aggregateChildCommandTimeSeconds',
          )?.amount;
          if (usage === 'CommandCompleted') expect(childSeconds).toBeGreaterThan(0);
          else expect(childSeconds).toBe(0);
          for (const debit of debits) {
            expect(rawSaids).toContain(debit.receiptArtifactSaid);
            expect(
              events.some(
                (event) =>
                  event.detail.kind === 'ArtifactCaptured' &&
                  event.detail.artifactSaid === debit.receiptArtifactSaid &&
                  event.detail.custody === 'Public',
              ),
            ).toBe(true);
            expect(events.some((event) => event.d === debit.sourceEventSaid)).toBe(true);
          }
          const elapsed = await Promise.all(
            rawSaids.map(
              async (rawSaid) => JSON.parse(await readFile(join(root, rawSaid), 'utf8')) as unknown,
            ),
          );
          expect(elapsed).toContainEqual(
            expect.objectContaining({
              kind: 'EvaluationToolElapsed',
              toolCallId: 'provider-call-1',
              childCommandDuration:
                usage === 'CommandTool'
                  ? 'NotExecuted'
                  : usage === 'CommandCompleted'
                    ? 'GatewayRoundTripUpperBound'
                    : 'NotApplicable',
            }),
          );
          expect(elapsed).toContainEqual(
            expect.objectContaining({
              kind: 'EvaluationSourceChanges',
              changedFiles: commandTool ? 0 : 1,
              changedWorktreeBytes: commandTool ? 0 : c3 ? 17 : 7,
            }),
          );
          expect(elapsed).toContainEqual(
            expect.objectContaining({
              kind: 'EvaluationWallElapsed',
            }),
          );
          if (c1 && c1Artifact?.kind === 'Prepared') {
            expect(elapsed).toContainEqual(
              expect.objectContaining({
                kind: 'C1TrialBehaviorBound',
                treatmentArtifactSaid: c1Artifact.artifact.d,
                successorRevisionSaid: manifest.manifest.revisions.C1,
              }),
            );
            expect(elapsed).toContainEqual(
              expect.objectContaining({
                kind: 'C1TrialWorkerStart',
                treatmentArtifactSaid: c1Artifact.artifact.d,
                successorRevisionSaid: manifest.manifest.revisions.C1,
              }),
            );
            expect(await custody.open(clean.sourceSaid)).toBeDefined();
          }
          expect(events.at(-1)?.detail).toEqual({ kind: 'TrialStopped', reason: 'Completed' });
          expect(rawSaids).toContain(result.cleanupReceiptSaid);
          expect(rawSaids).toContain(result.capturedSourceSaid);
          expect(await readFile(join(root, result.cleanupReceiptSaid))).toBeDefined();
          expect(await readFile(join(root, result.capturedSourceSaid))).toBeDefined();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      90_000,
    );
  },
);
