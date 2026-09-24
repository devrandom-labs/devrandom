import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import type { ToolAccessEvidence } from '../evidence/tool-access-evidence.js';
import type { ToolAccessRequest } from '../tool-access/request.js';
import {
  createPiToolInterceptor,
  createPiToolInterceptorExtension,
  type PiToolInterceptor,
} from './tool-interceptor.js';

interface PiFixture {
  readonly cwd: string;
  readonly session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  readonly setResponses: ReturnType<typeof fauxProvider>['setResponses'];
  close(): void;
}

interface ExternalWriteInput {
  readonly resource: string;
  readonly value: string;
}

function externalWriteInput(input: unknown): ExternalWriteInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('resource' in input) ||
    !('value' in input) ||
    typeof input.resource !== 'string' ||
    typeof input.value !== 'string'
  ) {
    throw new Error('expected external write strings');
  }
  return { resource: input.resource, value: input.value };
}

function externalWriteTool(
  effect: (toolCallId: string, input: ExternalWriteInput) => Promise<void> | void,
): ToolDefinition {
  return {
    name: 'external_write',
    label: 'External write',
    description: 'Writes to a controlled external test resource',
    parameters: Type.Object({ resource: Type.String(), value: Type.String() }),
    async execute(toolCallId, input) {
      const exactInput = externalWriteInput(input);
      await effect(toolCallId, exactInput);
      return {
        content: [{ type: 'text', text: `wrote ${exactInput.resource}` }],
        details: { resource: exactInput.resource },
      };
    },
  };
}

function externalWriteAccessMapping() {
  return {
    toolName: 'external_write',
    requiredCapability: 'external.write',
    identifyResource: (input: unknown) => `external://${externalWriteInput(input).resource}`,
  } as const;
}

async function createPiFixture(options: {
  readonly tools: string[];
  readonly customTools?: ToolDefinition[];
  readonly extensionFactories?: (cwd: string) => ExtensionFactory[];
}): Promise<PiFixture> {
  const root = mkdtempSync(join(tmpdir(), 'devrandom-pi-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd);
  mkdirSync(agentDir);

  const modelProvider = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(modelProvider.provider);
  await modelRuntime.setRuntimeApiKey(modelProvider.provider.id, 'e0-faux-key');

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(options.extensionFactories ? { extensionFactories: options.extensionFactories(cwd) } : {}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelProvider.getModel(),
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: options.tools,
    ...(options.customTools ? { customTools: options.customTools } : {}),
  });

  return {
    cwd,
    session,
    setResponses: modelProvider.setResponses,
    close() {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Pi tool interceptor', () => {
  it('binds a consequential access request to its exact origin before dispatch', async () => {
    const requests: ToolAccessRequest[] = [];
    const interceptor = createPiToolInterceptor({
      origin: {
        runId: 'run-1',
        taskRevisionId: 'task-revision-1',
        harnessRevisionId: 'harness-revision-1',
        modelTurnId: 'model-turn-1',
      },
      authorizer: {
        authorize(request) {
          requests.push(request);
          return Promise.resolve({ kind: 'denied', reason: 'mandate scope denied' });
        },
      },
    });

    await expect(
      interceptor.intercept({
        toolCallId: 'tool-call-1',
        toolName: 'write',
        input: { path: './proof.txt', content: 'must not be written' },
      }),
    ).resolves.toEqual({ block: true, kind: 'denied', reason: 'mandate scope denied' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      runId: 'run-1',
      taskRevisionId: 'task-revision-1',
      harnessRevisionId: 'harness-revision-1',
      modelTurnId: 'model-turn-1',
      toolCallId: 'tool-call-1',
      toolName: 'write',
      requiredCapability: 'workspace.write',
      resourceId: '/workspace/proof.txt',
    });
    expect(request?.argumentsDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('intercepts and rejects a real Pi built-in before the filesystem effect', async () => {
    const events: ToolAccessEvidence[] = [];
    let interceptor: PiToolInterceptor | undefined;
    const fixture = await createPiFixture({
      tools: ['write'],
      extensionFactories: (cwd) => {
        interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-builtin',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          authorizer: {
            authorize: () => Promise.resolve({ kind: 'denied', reason: 'write denied' }),
          },
          evidenceRecorder: {
            record(event) {
              events.push(event);
            },
          },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });
    const target = join(fixture.cwd, 'blocked.txt');

    try {
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall('write', { path: target, content: 'forbidden' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('write was rejected'),
      ]);

      if (!interceptor) throw new Error('Pi interceptor extension was not initialized');
      interceptor.assertAllActiveToolsMediated(fixture.session.getActiveToolNames());
      await fixture.session.prompt('write blocked.txt');

      expect(existsSync(target)).toBe(false);
      const evidence = events.find((event) => event.kind === 'access_disposition');
      expect(evidence).toBeDefined();
      if (!evidence) throw new Error('expected tool-access disposition evidence');
      expect(evidence.request).toMatchObject({
        runId: 'run-builtin',
        taskRevisionId: 'task-revision-1',
        harnessRevisionId: 'harness-revision-1',
        modelTurnId: 'model-turn-1',
        toolName: 'write',
        requiredCapability: 'workspace.write',
        resourceId: target,
      });
      expect(evidence.request.toolCallId).not.toHaveLength(0);
      expect(evidence.request.argumentsDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(evidence.disposition).toEqual({ kind: 'denied', reason: 'write denied' });
    } finally {
      fixture.close();
    }
  });

  it.each(['sdk custom', 'extension registered'] as const)(
    'rejects a real Pi %s tool before its effect implementation',
    async (source) => {
      const executions: ExternalWriteInput[] = [];
      const tool = externalWriteTool((_toolCallId, input) => {
        executions.push(input);
      });
      let interceptor: PiToolInterceptor | undefined;
      const fixture = await createPiFixture({
        tools: ['external_write'],
        ...(source === 'sdk custom' ? { customTools: [tool] } : {}),
        extensionFactories: (cwd) => {
          interceptor = createPiToolInterceptor({
            workspace: cwd,
            origin: {
              runId: `run-${source}`,
              taskRevisionId: 'task-revision-1',
              harnessRevisionId: 'harness-revision-1',
              modelTurnId: 'model-turn-1',
            },
            mappings: [externalWriteAccessMapping()],
            authorizer: {
              authorize: () => Promise.resolve({ kind: 'denied', reason: 'external write denied' }),
            },
          });
          const factories: ExtensionFactory[] = [createPiToolInterceptorExtension(interceptor)];
          if (source === 'extension registered') {
            factories.unshift((pi) => {
              pi.registerTool(tool);
            });
          }
          return factories;
        },
      });

      try {
        fixture.setResponses([
          fauxAssistantMessage(
            fauxToolCall('external_write', { resource: 'record-1', value: 'forbidden' }),
            {
              stopReason: 'toolUse',
            },
          ),
          fauxAssistantMessage('external write was rejected'),
        ]);
        if (!interceptor) throw new Error('Pi interceptor extension was not initialized');
        expect(fixture.session.getActiveToolNames()).toEqual(['external_write']);
        interceptor.assertAllActiveToolsMediated(fixture.session.getActiveToolNames());

        await fixture.session.prompt('write the external record');

        expect(executions).toEqual([]);
      } finally {
        fixture.close();
      }
    },
  );

  it('rejects malformed tool arguments before the interceptor hook or effect runs', async () => {
    const events: ToolAccessEvidence[] = [];
    let executions = 0;
    const tool = externalWriteTool(() => {
      executions += 1;
    });
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [tool],
      extensionFactories: (cwd) => {
        const interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-malformed',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          mappings: [externalWriteAccessMapping()],
          authorizer: { authorize: () => Promise.resolve({ kind: 'permitted' }) },
          evidenceRecorder: {
            record(event) {
              events.push(event);
            },
          },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });

    try {
      fixture.setResponses([
        fauxAssistantMessage(fauxToolCall('external_write', { value: 'missing resource' }), {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('malformed call failed'),
      ]);

      await fixture.session.prompt('send malformed arguments');

      expect(events).toEqual([]);
      expect(executions).toBe(0);
      expect(fixture.session.messages).toContainEqual(
        expect.objectContaining({ role: 'toolResult', isError: true }),
      );
    } finally {
      fixture.close();
    }
  });

  it('turns an authorizer failure into typed fail-closed evidence', async () => {
    const events: ToolAccessEvidence[] = [];
    let executions = 0;
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [
        externalWriteTool(() => {
          executions += 1;
        }),
      ],
      extensionFactories: (cwd) => {
        const interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-authorizer-failure',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          mappings: [externalWriteAccessMapping()],
          authorizer: {
            authorize: () => Promise.reject(new Error('authorizer unavailable')),
          },
          evidenceRecorder: {
            record(event) {
              events.push(event);
            },
          },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });

    try {
      fixture.setResponses([
        fauxAssistantMessage(
          fauxToolCall('external_write', { resource: 'record-1', value: 'blocked' }),
          {
            stopReason: 'toolUse',
          },
        ),
      ]);

      await fixture.session.prompt('attempt the write');

      expect(executions).toBe(0);
      const evidence = events.find((event) => event.kind === 'mediation_failure');
      expect(evidence).toBeDefined();
      if (!evidence) throw new Error('expected mediation-failure evidence');
      expect(evidence).toMatchObject({
        runId: 'run-authorizer-failure',
        taskRevisionId: 'task-revision-1',
        harnessRevisionId: 'harness-revision-1',
        modelTurnId: 'model-turn-1',
        toolName: 'external_write',
        reason: 'authorizer unavailable',
      });
      expect(evidence.toolCallId).not.toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it('preflights parallel access requests independently before any permitted effect', async () => {
    const executions: string[] = [];
    let interceptor: PiToolInterceptor | undefined;
    const tool = externalWriteTool((toolCallId, input) => {
      if (!interceptor) throw new Error('Pi interceptor was not initialized');
      interceptor.consumeExecutionGrant({ toolCallId, toolName: 'external_write', input });
      executions.push(input.resource);
    });
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [tool],
      extensionFactories: (cwd) => {
        interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-parallel',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          mappings: [externalWriteAccessMapping()],
          authorizer: {
            authorize: (request) =>
              Promise.resolve(
                request.resourceId === 'external://allowed'
                  ? { kind: 'permitted' }
                  : { kind: 'denied', reason: 'resource denied' },
              ),
          },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });

    try {
      fixture.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('external_write', { resource: 'allowed', value: 'one' }),
            fauxToolCall('external_write', { resource: 'denied', value: 'two' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('parallel batch settled'),
      ]);

      await fixture.session.prompt('run both writes');

      expect(executions).toEqual(['allowed']);
    } finally {
      fixture.close();
    }
  });

  it('invalidates the one-time grant when a later hook mutates authorized arguments', async () => {
    const effects: ExternalWriteInput[] = [];
    let interceptor: PiToolInterceptor | undefined;
    const tool = externalWriteTool((toolCallId, input) => {
      if (!interceptor) throw new Error('Pi interceptor was not initialized');
      interceptor.consumeExecutionGrant({ toolCallId, toolName: 'external_write', input });
      effects.push(input);
    });
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [tool],
      extensionFactories: (cwd) => {
        interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-mutation',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          mappings: [externalWriteAccessMapping()],
          authorizer: { authorize: () => Promise.resolve({ kind: 'permitted' }) },
        });
        const mutateAfterAuthorization: ExtensionFactory = (pi) => {
          pi.on('tool_call', (event) => {
            if (event.toolName === 'external_write')
              event.input.value = 'mutated after authorization';
          });
        };
        return [createPiToolInterceptorExtension(interceptor), mutateAfterAuthorization];
      },
    });

    try {
      fixture.setResponses([
        fauxAssistantMessage(
          fauxToolCall('external_write', { resource: 'record-1', value: 'original' }),
          {
            stopReason: 'toolUse',
          },
        ),
        fauxAssistantMessage('mutation was rejected'),
      ]);

      await fixture.session.prompt('write the original value');

      expect(effects).toEqual([]);
      expect(fixture.session.messages).toContainEqual(
        expect.objectContaining({ role: 'toolResult', isError: true }),
      );
    } finally {
      fixture.close();
    }
  });

  it('fails inventory audit when an active tool has no access mapping', async () => {
    let interceptor: PiToolInterceptor | undefined;
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [externalWriteTool(() => {})],
      extensionFactories: (cwd) => {
        interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-inventory',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          authorizer: { authorize: () => Promise.resolve({ kind: 'permitted' }) },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });

    try {
      const activeInterceptor = interceptor;
      if (!activeInterceptor) throw new Error('Pi interceptor extension was not initialized');
      expect(() => {
        activeInterceptor.assertAllActiveToolsMediated(fixture.session.getActiveToolNames());
      }).toThrow('Active Pi tools without an access mapping: external_write');
    } finally {
      fixture.close();
    }
  });

  it('aborts a parallel batch when one access request is pending approval', async () => {
    const effects: string[] = [];
    const events: ToolAccessEvidence[] = [];
    let interceptor: PiToolInterceptor | undefined;
    const tool = externalWriteTool((toolCallId, input) => {
      if (!interceptor) throw new Error('Pi interceptor was not initialized');
      interceptor.consumeExecutionGrant({ toolCallId, toolName: 'external_write', input });
      effects.push(input.resource);
    });
    const fixture = await createPiFixture({
      tools: ['external_write'],
      customTools: [tool],
      extensionFactories: (cwd) => {
        interceptor = createPiToolInterceptor({
          workspace: cwd,
          origin: {
            runId: 'run-approval',
            taskRevisionId: 'task-revision-1',
            harnessRevisionId: 'harness-revision-1',
            modelTurnId: 'model-turn-1',
          },
          mappings: [externalWriteAccessMapping()],
          authorizer: {
            authorize: (request) =>
              Promise.resolve(
                request.resourceId === 'external://approval'
                  ? {
                      kind: 'pending_approval',
                      approvalRequestId: 'approval-request-1',
                      reason: 'human approval required',
                    }
                  : { kind: 'permitted' },
              ),
          },
          evidenceRecorder: {
            record(event) {
              events.push(event);
            },
          },
        });
        return [createPiToolInterceptorExtension(interceptor)];
      },
    });

    try {
      fixture.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('external_write', { resource: 'otherwise-allowed', value: 'one' }),
            fauxToolCall('external_write', { resource: 'approval', value: 'two' }),
          ],
          { stopReason: 'toolUse' },
        ),
      ]);

      await fixture.session.prompt('run the approval batch');

      expect(effects).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'access_disposition',
          disposition: {
            kind: 'pending_approval',
            approvalRequestId: 'approval-request-1',
            reason: 'human approval required',
          },
        }),
      );
    } finally {
      fixture.close();
    }
  });
});
