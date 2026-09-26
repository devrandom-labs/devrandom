import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationManifest,
  prepareEvidenceArtifact,
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
import { SourceCustody } from './source-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;

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
    ] as const)(
      'mediates a provider-origin edit with %s parent usage and custody-backed E3 debits',
      async (usage) => {
        const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
        const root = await mkdtemp(join(tmpdir(), 'devrandom-trial-integration-'));
        try {
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
            sourceGitCommit: '3'.repeat(40),
            sourceGitTree: '4'.repeat(40),
            h1InstructionSaid: said('i'),
            h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
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
            taskId: randomUUID(),
            taskRevisionSaid: said('a'),
            originRunId: randomUUID(),
            ownerAid: said('b'),
            personalAgentAid: said('c'),
            taskMandateSaid: said('d'),
            retainedCheckpointSaid: said('e'),
            retainedSealSaid: said('f'),
            policySaid: said('g'),
            revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('n') },
            executionProfileSaid: profile.profile.d,
            sourceInventorySaid: said('m'),
            hypothesisSaid: said('H'),
            verifierSaid: said('v'),
            protectedCaseArtifactSaid: said('o'),
            finalCaseArtifactSaid: said('p'),
            publicConditionIds: ['cesr-current'],
            heldOutCaseCount: 1,
            allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
          });
          expect(manifest.kind).toBe('Prepared');
          if (manifest.kind !== 'Prepared') return;
          const slot = { arm: 'H1' as const, repetition: 1 as const, attempt: 1 as const };
          const binding = {
            kind: 'Evaluation' as const,
            taskId: manifest.manifest.taskId,
            taskRevisionSaid: manifest.manifest.taskRevisionSaid,
            originRunId: manifest.manifest.originRunId,
            personalAgentAid: manifest.manifest.personalAgentAid,
            taskMandateSaid: manifest.manifest.taskMandateSaid,
            harnessRevisionSaid: manifest.manifest.revisions.H1,
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
          const commandTool = ['CommandTool', 'CommandCompleted', 'CommandUnknown'].includes(usage);
          const trial = new DockerContainedTrialExecution({
            profile: profile.profile,
            image,
            model,
            modelProfileSaid: said('q'),
            systemPrompt: 'Use the mediated tools.',
            prompt: 'Change src/lib.rs to after.',
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
                          { path: 'src/lib.rs', content: 'after\n' },
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
                  usageEventSaid: said(input.requestOrdinal === 0 ? 'u' : 'w'),
                  verifiedSpendMicroUsd: usage === 'Unaccountable' ? Number.NaN : 7,
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
            reviewedBehaviorSaid: manifest.manifest.revisions.H1,
            modelProfileSaid: said('q'),
            containerProfileSaid: profile.profile.d,
            signal: new AbortController().signal,
          });
          if (usage === 'UnverifiedCursor' || usage === 'LegacyCursor') {
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
          ).toBe(commandTool ? 'before\n' : 'after\n');
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
            commandTool ? 0 : 7,
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
              changedWorktreeBytes: commandTool ? 0 : 7,
            }),
          );
          expect(elapsed).toContainEqual(
            expect.objectContaining({
              kind: 'EvaluationWallElapsed',
            }),
          );
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
