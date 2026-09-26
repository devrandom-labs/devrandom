import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { DockerEvaluationCompartment } from '../../evaluation/infrastructure/docker-compartment.js';
import { FramedRelay } from '../../evaluation/infrastructure/framed-relay.js';
import { createConcentrateProvider } from '../concentrate-provider.js';
import { ConcentrateUsage } from '../concentrate-usage.js';

const said = (character: string): string => `E${character.repeat(43)}`;

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'real contained Pi SDK relay',
  () => {
    it('runs Pi in a networkless OCI compartment and forwards model and tool requests through framed stdio', async () => {
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const prepared = prepareEvaluationExecutionProfile({
        os: 'linux',
        architecture: 'aarch64',
        imageDigest: image,
        runtimeDigest: `sha256:${'1'.repeat(64)}`,
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
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') return;
      const root = resolve('.');
      const opened = await DockerEvaluationCompartment.open({
        profile: prepared.profile,
        image,
        signal: new AbortController().signal,
        mounts: [
          {
            hostPath: resolve(root, 'packages/runtime/dist'),
            containerPath: '/app/packages/runtime/dist',
            writable: false,
          },
          {
            hostPath: resolve(root, 'packages/runtime/package.json'),
            containerPath: '/app/packages/runtime/package.json',
            writable: false,
          },
          {
            hostPath: resolve(root, 'packages/runtime/node_modules'),
            containerPath: '/app/packages/runtime/node_modules',
            writable: false,
          },
          {
            hostPath: resolve(root, 'node_modules/.pnpm'),
            containerPath: '/app/node_modules/.pnpm',
            writable: false,
          },
        ],
      });
      expect(opened.kind).toBe('Opened');
      if (opened.kind !== 'Opened') return;
      try {
        const setup = opened.compartment.execute(['mkdir', '-p', '/work/source', '/tmp/agent']);
        expect(
          await new Promise<number | null>((resolveExit) => setup.once('close', resolveExit)),
        ).toBe(0);
        const binding = randomUUID();
        const worker = opened.compartment.execute([
          'node',
          '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js',
          binding,
        ]);
        const workerExit = new Promise<number | null>((resolveExit) =>
          worker.once('close', resolveExit),
        );
        let stderr = '';
        worker.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        const relay = new FramedRelay(worker.stdout, worker.stdin, binding, 2 * 1024 * 1024);
        const models = await ModelRuntime.create({
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        models.registerNativeProvider(createConcentrateProvider(new ConcentrateUsage()));
        const model = models.getModel('concentrate', 'deepinfra/gemma-4-e4b');
        expect(model).toBeDefined();
        if (model === undefined) return;
        await relay.send('Start', {
          piSessionId: randomUUID(),
          modelProfileSaid: said('m'),
          model: { ...model, maxTokens: 128 },
          thinkingLevel: 'off',
          systemPrompt: 'Use the available tools.',
          prompt: 'Read one file.',
          maximumPrompts: 1,
          enabledTools: ['read_file', 'submit_result'],
        });
        expect((await relay.receive()).kind).toBe('Ready');
        const request = await relay.receive();
        expect(request.kind).toBe('ModelRequest');
        expect(request.payload).toMatchObject({ requestOrdinal: 0, modelProfileSaid: said('m') });
        const toolCall = fauxToolCall('read_file', { path: 'src/lib.rs' }, { id: 'call-1' });
        const answer = {
          ...fauxAssistantMessage(toolCall, { stopReason: 'toolUse' }),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        await relay.send('ModelResponse', {
          kind: 'Completed',
          requestOrdinal: 0,
          message: answer,
          usageEventSaid: said('u'),
        });
        const proposal = await relay.receive();
        expect(proposal.kind).toBe('ToolProposal');
        expect(proposal.payload).toMatchObject({
          toolCallId: 'call-1',
          proposalIndex: 0,
          input: { kind: 'ReadFile', path: 'src/lib.rs' },
        });
        await relay.send('ToolOutcome', {
          kind: 'Completed',
          summary: 'read file',
          outputArtifactSaids: [said('a')],
        });
        const next = await relay.receive();
        expect(next.kind).toBe('ModelRequest');
        const second = {
          ...fauxAssistantMessage('Done.'),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        await relay.send('ModelResponse', {
          kind: 'Completed',
          requestOrdinal: 1,
          message: second,
          usageEventSaid: said('v'),
        });
        expect((await relay.receive()).kind).toBe('Stopped');
        expect(await workerExit).toBe(0);
        expect(stderr).toBe('');
      } finally {
        expect(await opened.compartment.close()).toBe(true);
      }
    }, 90_000);
  },
);
