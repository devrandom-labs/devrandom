import { fileURLToPath } from 'node:url';

import {
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import type {
  ToolGatewayOutcome,
  ToolInput,
  ToolName,
  ToolGatewayProposal,
} from '../../tool-gateway/tool-gateway.js';
import { FramedRelay } from '../../evaluation/infrastructure/framed-relay.js';
import { digestRunRuntimePrompt } from '../../run/runtime-prompt-digest.js';

interface WorkerStart {
  readonly piSessionId: string;
  readonly modelProfileSaid: string;
  readonly model: Model<Api>;
  readonly thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly maximumPrompts: number;
  readonly enabledTools: readonly ToolName[];
  readonly requiresWorkflowContext?: true;
}

const pathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\\\\\u0000-\\u001f])[^/]+(?:/[^/]+)*$',
});
const commandSchema = Type.Object(
  { commandId: Type.String({ minLength: 1, maxLength: 120, pattern: '^[a-z][a-z0-9-]*$' }) },
  { additionalProperties: false },
);
const toolSchemas: Readonly<Record<ToolName, TSchema>> = {
  read_file: Type.Object({ path: pathSchema }, { additionalProperties: false }),
  list_files: Type.Object({ path: pathSchema }, { additionalProperties: false }),
  search_repository: Type.Object(
    { path: pathSchema, query: Type.String({ minLength: 1, maxLength: 1024 }) },
    { additionalProperties: false },
  ),
  write_file: Type.Object(
    { path: pathSchema, content: Type.String({ maxLength: 512 * 1024 }) },
    { additionalProperties: false },
  ),
  replace_text: Type.Object(
    {
      path: pathSchema,
      oldText: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
      newText: Type.String({ maxLength: 512 * 1024 }),
      expectedOccurrences: Type.Integer({ minimum: 1, maximum: 10000 }),
    },
    { additionalProperties: false },
  ),
  run_formatter: commandSchema,
  run_static_analysis: commandSchema,
  run_tests: commandSchema,
  submit_result: Type.Object(
    {
      artifactSaids: Type.Array(Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }), {
        maxItems: 64,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
};

export function piToolInput(name: ToolName, parameters: unknown): ToolInput {
  if (!Value.Check(toolSchemas[name], parameters))
    throw new Error('Pi proposed invalid tool arguments.');
  const value = parameters as {
    path: string;
    query: string;
    content: string;
    oldText: string;
    newText: string;
    expectedOccurrences: number;
    commandId: string;
    artifactSaids: string[];
  };
  switch (name) {
    case 'read_file':
      return { kind: 'ReadFile', path: value.path };
    case 'list_files':
      return { kind: 'ListFiles', path: value.path };
    case 'search_repository':
      return { kind: 'SearchRepository', path: value.path, query: value.query };
    case 'write_file':
      return { kind: 'WriteFile', path: value.path, content: value.content };
    case 'replace_text':
      return {
        kind: 'ReplaceText',
        path: value.path,
        oldText: value.oldText,
        newText: value.newText,
        expectedOccurrences: value.expectedOccurrences,
      };
    case 'run_formatter':
      return { kind: 'RunFormatter', commandId: value.commandId };
    case 'run_static_analysis':
      return { kind: 'RunStaticAnalysis', commandId: value.commandId };
    case 'run_tests':
      return { kind: 'RunTests', commandId: value.commandId };
    case 'submit_result':
      return { kind: 'SubmitResult', artifactSaids: value.artifactSaids };
  }
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && Object.hasOwn(toolSchemas, value);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeStart(value: unknown): WorkerStart | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const input = value as { readonly [key: string]: unknown };
  if (
    Object.keys(input).sort().join(',') !==
      (input.requiresWorkflowContext === true
        ? 'enabledTools,maximumPrompts,model,modelProfileSaid,piSessionId,prompt,requiresWorkflowContext,systemPrompt,thinkingLevel'
        : 'enabledTools,maximumPrompts,model,modelProfileSaid,piSessionId,prompt,systemPrompt,thinkingLevel') ||
    typeof input.piSessionId !== 'string' ||
    input.piSessionId.length === 0 ||
    typeof input.modelProfileSaid !== 'string' ||
    !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(input.modelProfileSaid) ||
    typeof input.prompt !== 'string' ||
    input.prompt.length > 128 * 1024 ||
    typeof input.systemPrompt !== 'string' ||
    input.systemPrompt.length > 128 * 1024 ||
    !Number.isInteger(input.maximumPrompts) ||
    (input.maximumPrompts as number) < 1 ||
    (input.maximumPrompts as number) > 50 ||
    !Array.isArray(input.enabledTools) ||
    input.enabledTools.length === 0 ||
    input.enabledTools.length > 9 ||
    !input.enabledTools.every(isToolName) ||
    new Set(input.enabledTools).size !== input.enabledTools.length ||
    typeof input.model !== 'object' ||
    input.model === null
  )
    return undefined;
  const model = input.model as { readonly [key: string]: unknown };
  if (
    model.provider !== 'concentrate' ||
    model.api !== 'openai-responses' ||
    typeof model.id !== 'string' ||
    typeof model.contextWindow !== 'number' ||
    typeof model.maxTokens !== 'number' ||
    model.maxTokens < 1 ||
    (model.headers !== undefined && Object.keys(model.headers as object).length > 0) ||
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      String(input.thinkingLevel),
    )
  )
    return undefined;
  return input as unknown as WorkerStart;
}

function failureMessage(model: Model<Api>, reason: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: reason,
    timestamp: Date.now(),
  };
}

function completeFromParent(
  relay: FramedRelay,
  start: WorkerStart,
  context: TranscriptContext,
  requestOrdinal: number,
) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    try {
      await relay.send('ModelRequest', {
        requestOrdinal,
        modelProfileSaid: start.modelProfileSaid,
        context,
        maximumOutputTokens: start.model.maxTokens,
      });
      const response = await relay.receive();
      if (!isRecord(response.payload)) throw new Error('Parent model response invalid.');
      const body = response.payload;
      if (
        response.kind !== 'ModelResponse' ||
        body.requestOrdinal !== requestOrdinal ||
        body.kind !== 'Completed' ||
        typeof body.usageEventSaid !== 'string'
      )
        throw new Error('Parent model response was not accountable.');
      if (!isRecord(body.message) || body.message.role !== 'assistant')
        throw new Error('Parent model message invalid.');
      const message = body.message as unknown as AssistantMessage;
      if (
        message.provider !== start.model.provider ||
        message.model !== start.model.id ||
        !Array.isArray(message.content)
      )
        throw new Error('Parent model response identity mismatch.');
      stream.push({ type: 'start', partial: message });
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      else if (
        message.stopReason === 'stop' ||
        message.stopReason === 'length' ||
        message.stopReason === 'toolUse' ||
        message.stopReason === 'deferred'
      )
        stream.push({ type: 'done', reason: message.stopReason, message });
      else throw new Error('Parent model response has no terminal disposition.');
    } catch {
      stream.push({
        type: 'error',
        reason: 'error',
        error: failureMessage(start.model, 'Parent model relay unavailable.'),
      });
    }
  })();
  return stream;
}

function toolText(outcome: ToolGatewayOutcome): string {
  switch (outcome.kind) {
    case 'Completed':
    case 'Failed':
    case 'SubmissionVerified':
      return `${outcome.summary}\nOutput artifact SAIDs: ${outcome.outputArtifactSaids.join(', ') || 'none'}`;
    case 'Rejected':
      return `Tool rejected: ${outcome.reason}`;
    case 'ApprovalRequired':
    case 'OutboxBackpressure':
    case 'DependencyUnavailable':
    case 'SecretDetected':
    case 'EvidenceIntegrityFailure':
      return `Tool stopped: ${outcome.kind}`;
  }
}

export async function runContainedPiWorker(relay: FramedRelay): Promise<void> {
  const first = await relay.receive();
  const start = first.kind === 'Start' ? decodeStart(first.payload) : undefined;
  if (start === undefined) throw new Error('Evaluation worker start binding invalid.');
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let requestOrdinal = 0;
  const relayStream = (_model: Model<Api>, context: TranscriptContext) =>
    completeFromParent(relay, start, context, requestOrdinal++);
  runtime.registerNativeProvider(
    createProvider({
      id: 'concentrate',
      name: 'Contained evaluation relay',
      auth: {
        apiKey: {
          name: 'Local evaluation relay',
          resolve: () =>
            Promise.resolve({
              auth: { apiKey: 'local-relay-without-provider-authority' },
              source: 'contained stdio',
            }),
        },
      },
      models: [start.model],
      api: { stream: relayStream, streamSimple: relayStream },
    }),
  );
  const model = runtime.getModel(start.model.provider, start.model.id);
  if (model === undefined) throw new Error('Evaluation worker model unavailable.');
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    cacheWarming: 'off',
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  });
  const loader = new DefaultResourceLoader({
    cwd: '/work/source',
    agentDir: '/tmp/agent',
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: start.systemPrompt,
  });
  await loader.reload();
  let turnIndex = -1;
  let proposalIndex = 0;
  const submission = { verified: false };
  const provisional = { stopped: false };
  const customTools: ToolDefinition[] = start.enabledTools.map((name) =>
    defineTool({
      name,
      label: name,
      description: `Mediated ${name} operation`,
      parameters: toolSchemas[name],
      executionMode: 'sequential',
      execute: async (toolCallId, parameters) => {
        if (turnIndex < 0) throw new Error('Pi tool call has no provider turn.');
        const proposal: ToolGatewayProposal = {
          piSessionId: start.piSessionId,
          modelTurnId: `${start.piSessionId}:${String(turnIndex)}`,
          toolCallId,
          proposalIndex: proposalIndex++,
          input: piToolInput(name, parameters),
        };
        await relay.send('ToolProposal', proposal);
        const response = await relay.receive();
        if (name === 'submit_result' && start.requiresWorkflowContext === true) {
          if (response.kind !== 'ProvisionalStop')
            throw new Error('C2 submission must stop for parent public verification.');
          provisional.stopped = true;
          return {
            content: [
              { type: 'text', text: 'Submission proposed for parent public verification.' },
            ],
            details: undefined,
            terminate: true,
          };
        }
        if (
          response.kind !== 'ToolOutcome' ||
          typeof response.payload !== 'object' ||
          response.payload === null
        )
          throw new Error('Parent tool response invalid.');
        const outcome = response.payload as ToolGatewayOutcome;
        if (
          name === 'submit_result' &&
          outcome.kind === 'SubmissionVerified' &&
          outcome.disposition !== 'Rejected'
        )
          submission.verified = true;
        return {
          content: [{ type: 'text', text: toolText(outcome) }],
          details: undefined,
          ...(submission.verified ? { terminate: true } : {}),
        };
      },
    }),
  );
  const created = await createAgentSession({
    cwd: '/work/source',
    agentDir: '/tmp/agent',
    model,
    modelRuntime: runtime,
    thinkingLevel: start.thinkingLevel,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory('/work/source', { id: start.piSessionId }),
    resourceLoader: loader,
    noTools: 'all',
    tools: [...start.enabledTools],
    customTools,
  });
  const session = created.session;
  session.agent.toolExecution = 'sequential';
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'turn_start') {
      turnIndex += 1;
      proposalIndex = 0;
    }
  });
  await relay.send('Ready', {
    piSessionId: start.piSessionId,
    promptDigest: digestRunRuntimePrompt(start.systemPrompt, start.prompt),
  });
  try {
    let workflowContext = '';
    if (start.requiresWorkflowContext === true) {
      const frame = await relay.receive();
      if (
        frame.kind !== 'WorkflowContext' ||
        !isRecord(frame.payload) ||
        frame.payload.version !== 1 ||
        frame.payload.kind !== 'ReviewedC2WorkflowContext' ||
        typeof frame.payload.text !== 'string' ||
        frame.payload.text.trim().length === 0 ||
        Buffer.byteLength(frame.payload.text, 'utf8') > 32 * 1024
      )
        throw new Error('C2 workflow context missing before first model request.');
      workflowContext = frame.payload.text;
    }
    for (
      let promptIndex = 0;
      promptIndex < start.maximumPrompts && !submission.verified && !provisional.stopped;
      promptIndex += 1
    ) {
      await session.prompt(
        promptIndex === 0
          ? start.requiresWorkflowContext === true
            ? `${workflowContext}\n\n${start.prompt}`
            : start.prompt
          : 'Continue the same task using public feedback. Submit the current work.',
        { expandPromptTemplates: false },
      );
    }
    await relay.send('Stopped', {
      kind: provisional.stopped
        ? 'Provisional'
        : submission.verified
          ? 'Submitted'
          : 'NoSubmission',
      piSessionId: start.piSessionId,
      requestCount: requestOrdinal,
    });
  } finally {
    unsubscribe();
    session.dispose();
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && invoked === fileURLToPath(import.meta.url)) {
  const binding = process.argv[2];
  if (binding === undefined || process.argv.length !== 3) process.exit(2);
  const relay = new FramedRelay(process.stdin, process.stdout, binding, 2 * 1024 * 1024);
  try {
    await runContainedPiWorker(relay);
  } catch {
    process.exitCode = 1;
  } finally {
    process.stdin.pause();
    process.stdin.destroy();
    process.stdout.end();
  }
}
