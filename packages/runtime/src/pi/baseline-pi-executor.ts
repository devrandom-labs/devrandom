import type { ProtectedCredentials, Run } from '@devrandom/domain';
import { identifyHarnessInstruction, type BaselineHarnessRevision } from '@devrandom/protocol';
import {
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import type {
  EvidenceArtifactRecording,
  EvidenceObservation,
  EvidenceRecorder,
  EvidenceRecording,
} from '../evidence/evidence-recorder.js';
import type {
  ContextCapacityMeasurement,
  PiExecution,
  PiExecutionDisposition,
} from '../run/run-supervisor.js';
import { runInstructionPrompt } from '../run/run-execution-profile-custody.js';
import type {
  AcceptedRunBudgetReservation,
  RunBudgetAmount,
  RunBudgetCommitment,
  RunResourceBudget,
} from '../run/run-resource-budget.js';
import type {
  ToolGatewayOutcome,
  ToolGatewayProposal,
  ToolInput,
  ToolName,
} from '../tool-gateway/tool-gateway.js';
import { concentrateProviderId, createConcentrateProvider } from './concentrate-provider.js';
import { ConcentrateUsage } from './concentrate-usage.js';

export type PiCredentialAcquisition =
  { readonly kind: 'Available'; readonly secret: string } | { readonly kind: 'Unavailable' };

export interface PiCredentialSource {
  acquire(input: {
    readonly provider: string;
    readonly credentialSource: string;
  }): Promise<PiCredentialAcquisition>;
}

export type PiModelOpening =
  | {
      readonly kind: 'Opened';
      readonly runtime: ModelRuntime;
      readonly model: Model<Api>;
      consumeUsage(
        message: AssistantMessage,
      ):
        | { readonly kind: 'Verified'; readonly spendMicroUsd: number }
        | { readonly kind: 'Unavailable' };
    }
  | { readonly kind: 'ConfigurationRequired' }
  | { readonly kind: 'CredentialUnavailable' }
  | { readonly kind: 'Unavailable' };

export interface PiModelAccess {
  open(compatibility: BaselineHarnessRevision['modelCompatibility']): Promise<PiModelOpening>;
}

export class PinnedPiModelAccess implements PiModelAccess {
  readonly #credentials: PiCredentialSource;

  constructor(credentials: PiCredentialSource) {
    this.#credentials = credentials;
  }

  async open(
    compatibility: BaselineHarnessRevision['modelCompatibility'],
  ): Promise<PiModelOpening> {
    if (compatibility.provider !== concentrateProviderId) return { kind: 'ConfigurationRequired' };
    const credential = await this.#credentials.acquire({
      provider: compatibility.provider,
      credentialSource: compatibility.credentialSource,
    });
    if (credential.kind === 'Unavailable') {
      return { kind: 'CredentialUnavailable' };
    }
    try {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const usage = new ConcentrateUsage();
      runtime.registerNativeProvider(createConcentrateProvider(usage));
      const model = runtime.getModel(compatibility.provider, compatibility.model);
      if (
        model === undefined ||
        model.contextWindow !== compatibility.contextWindowTokens ||
        compatibility.maximumOutputTokens > model.maxTokens
      ) {
        return { kind: 'ConfigurationRequired' };
      }
      await runtime.setRuntimeApiKey(compatibility.provider, credential.secret);
      return {
        kind: 'Opened',
        runtime,
        model: { ...model, maxTokens: compatibility.maximumOutputTokens },
        consumeUsage: (message) => usage.consume(message),
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}

export interface PiExecutionEvidence {
  withhold: EvidenceRecorder['withhold'];
  record(observation: EvidenceObservation): EvidenceRecording;
  storeArtifact(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: 'application/json';
  }): EvidenceArtifactRecording;
}

export interface PiExecutionGateway {
  propose(proposal: ToolGatewayProposal, signal: AbortSignal): Promise<ToolGatewayOutcome>;
}

export interface BaselinePiExecutorDependencies {
  readonly worktree: string;
  readonly agentDirectory: string;
  readonly harness: BaselineHarnessRevision;
  readonly instructions: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly prompt: string;
  readonly modelAccess: PiModelAccess;
  readonly budget: RunResourceBudget;
  readonly gateway: PiExecutionGateway;
  readonly evidence: PiExecutionEvidence;
  readonly protectedCredentials: ProtectedCredentials;
  now(): string;
  sessionId(): string;
  modelTurnId(turnIndex: number): string;
}

const relativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*[\\\\\\u0000-\\u001f\\u007f-\\u009f])[^/]+(?:/[^/]+)*$',
});
const commandIdSchema = Type.String({
  minLength: 1,
  maxLength: 120,
  pattern: '^[a-z][a-z0-9-]*$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const readFileSchema = Type.Object({ path: relativePathSchema }, { additionalProperties: false });
const listFilesSchema = Type.Object({ path: relativePathSchema }, { additionalProperties: false });
const searchRepositorySchema = Type.Object(
  {
    path: relativePathSchema,
    query: Type.String({ minLength: 1, maxLength: 1_024 }),
  },
  { additionalProperties: false },
);
const writeFileSchema = Type.Object(
  {
    path: relativePathSchema,
    content: Type.String({ maxLength: 512 * 1_024 }),
  },
  { additionalProperties: false },
);
const replaceTextSchema = Type.Object(
  {
    path: relativePathSchema,
    oldText: Type.String({ minLength: 1, maxLength: 512 * 1_024 }),
    newText: Type.String({ maxLength: 512 * 1_024 }),
    expectedOccurrences: Type.Integer({ minimum: 1, maximum: 10_000 }),
  },
  { additionalProperties: false },
);
const commandSchema = Type.Object({ commandId: commandIdSchema }, { additionalProperties: false });
const submitResultSchema = Type.Object(
  { artifactSaids: Type.Array(saidSchema, { maxItems: 64, uniqueItems: true }) },
  { additionalProperties: false },
);

interface ToolDescriptor {
  readonly name: ToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  input(parameters: unknown): ToolInput;
}

function readFileInput(input: unknown): ToolInput {
  if (!Value.Check(readFileSchema, input)) throw new Error('invalid read_file arguments');
  return { kind: 'ReadFile', path: input.path };
}

function listFilesInput(input: unknown): ToolInput {
  if (!Value.Check(listFilesSchema, input)) throw new Error('invalid list_files arguments');
  return { kind: 'ListFiles', path: input.path };
}

function searchRepositoryInput(input: unknown): ToolInput {
  if (!Value.Check(searchRepositorySchema, input)) {
    throw new Error('invalid search_repository arguments');
  }
  return { kind: 'SearchRepository', path: input.path, query: input.query };
}

function writeFileInput(input: unknown): ToolInput {
  if (!Value.Check(writeFileSchema, input)) throw new Error('invalid write_file arguments');
  return { kind: 'WriteFile', path: input.path, content: input.content };
}

function replaceTextInput(input: unknown): ToolInput {
  if (!Value.Check(replaceTextSchema, input)) throw new Error('invalid replace_text arguments');
  return {
    kind: 'ReplaceText',
    path: input.path,
    oldText: input.oldText,
    newText: input.newText,
    expectedOccurrences: input.expectedOccurrences,
  };
}

function formatterInput(input: unknown): ToolInput {
  if (!Value.Check(commandSchema, input)) throw new Error('invalid run_formatter arguments');
  return { kind: 'RunFormatter', commandId: input.commandId };
}

function staticAnalysisInput(input: unknown): ToolInput {
  if (!Value.Check(commandSchema, input)) {
    throw new Error('invalid run_static_analysis arguments');
  }
  return { kind: 'RunStaticAnalysis', commandId: input.commandId };
}

function testsInput(input: unknown): ToolInput {
  if (!Value.Check(commandSchema, input)) throw new Error('invalid run_tests arguments');
  return { kind: 'RunTests', commandId: input.commandId };
}

function submissionInput(input: unknown): ToolInput {
  if (!Value.Check(submitResultSchema, input)) throw new Error('invalid submit_result arguments');
  return { kind: 'SubmitResult', artifactSaids: input.artifactSaids };
}

const toolDescriptors: readonly ToolDescriptor[] = [
  {
    name: 'read_file',
    label: 'Read file',
    description: 'Read one bounded regular file inside the managed worktree.',
    parameters: readFileSchema,
    input: readFileInput,
  },
  {
    name: 'list_files',
    label: 'List files',
    description: 'List a bounded subtree inside the managed worktree.',
    parameters: listFilesSchema,
    input: listFilesInput,
  },
  {
    name: 'search_repository',
    label: 'Search repository',
    description: 'Search bounded text inside the managed worktree.',
    parameters: searchRepositorySchema,
    input: searchRepositoryInput,
  },
  {
    name: 'write_file',
    label: 'Write file',
    description: 'Create or replace one policy-authorized worktree file.',
    parameters: writeFileSchema,
    input: writeFileInput,
  },
  {
    name: 'replace_text',
    label: 'Replace text',
    description: 'Replace an exact occurrence set in one policy-authorized worktree file.',
    parameters: replaceTextSchema,
    input: replaceTextInput,
  },
  {
    name: 'run_formatter',
    label: 'Run formatter',
    description: 'Run one exact H1-declared formatter command without a shell.',
    parameters: commandSchema,
    input: formatterInput,
  },
  {
    name: 'run_static_analysis',
    label: 'Run static analysis',
    description: 'Run one exact H1-declared static-analysis command without a shell.',
    parameters: commandSchema,
    input: staticAnalysisInput,
  },
  {
    name: 'run_tests',
    label: 'Run tests',
    description: 'Run one exact H1-declared public test command without a shell.',
    parameters: commandSchema,
    input: testsInput,
  },
  {
    name: 'submit_result',
    label: 'Submit result',
    description:
      'Submit locally recorded output artifact SAIDs to the trusted public Task Verifier. Use artifactSaids: [] when there are no output artifacts.',
    parameters: submitResultSchema,
    input: submissionInput,
  },
];

const submissionReminder =
  'The Task has no accepted submission. Continue the same Task using the verification feedback. Do not claim completion in prose; submit the current work even if a public check still fails. Call submit_result with locally recorded output artifact SAIDs, or artifactSaids: [] when there are no output artifacts. The trusted verifier returns feedback for revision while the Run budget permits.';

type ExecutorTerminalDisposition = PiExecutionDisposition;

function rejectedToolTerminal(
  reason: Extract<ToolGatewayOutcome, { readonly kind: 'Rejected' }>['reason'],
): ExecutorTerminalDisposition | undefined {
  switch (reason) {
    case 'BudgetExhausted':
      return { kind: 'BudgetExhausted' };
    case 'MandateExpired':
      return { kind: 'TaskMandateExpired' };
    case 'MandateRevoked':
      return { kind: 'AuthorityRevoked' };
    case 'LeaseLost':
      return { kind: 'LeaseLost' };
    case 'CapabilityNotGranted':
    case 'ResourceDenied':
    case 'ArgumentsInvalid':
      return undefined;
  }
}

export function toolTerminal(outcome: ToolGatewayOutcome): ExecutorTerminalDisposition | undefined {
  switch (outcome.kind) {
    case 'SecretDetected':
      return outcome;
    case 'ApprovalRequired':
      return { kind: 'ApprovalRequired' };
    case 'OutboxBackpressure':
      return { kind: 'OutboxBackpressure' };
    case 'DependencyUnavailable':
      return { kind: 'DependencyUnavailable' };
    case 'EvidenceIntegrityFailure':
      return { kind: 'EvidenceIntegrityFailure' };
    case 'Rejected':
      return rejectedToolTerminal(outcome.reason);
    case 'Completed':
    case 'Failed':
    case 'SubmissionVerified':
      return undefined;
  }
}

function toolSummary(outcome: ToolGatewayOutcome): string {
  switch (outcome.kind) {
    case 'SecretDetected':
      return 'Evidence content was withheld because it contained protected credentials.';
    case 'Completed':
    case 'SubmissionVerified':
    case 'Failed': {
      const artifactReferences =
        outcome.outputArtifactSaids.length === 0 ? 'none' : outcome.outputArtifactSaids.join(', ');
      return `${outcome.summary}\nOutput artifact SAIDs: ${artifactReferences}`;
    }
    case 'Rejected':
      return `Tool rejected: ${outcome.reason}`;
    case 'ApprovalRequired':
      return 'Tool approval is required.';
    case 'OutboxBackpressure':
      return 'Tool evidence outbox is full.';
    case 'DependencyUnavailable':
      return 'Tool dependency is unavailable.';
    case 'EvidenceIntegrityFailure':
      return 'Tool evidence integrity failed.';
  }
}

export function recordingTerminal(
  recording: Exclude<EvidenceRecording, { readonly kind: 'Recorded' }>,
): ExecutorTerminalDisposition {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'OutboxBackpressure' };
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

export function usageIsAccountable(message: AssistantMessage, spendMicroUsd: number): boolean {
  const tokenValues = [
    message.usage.input,
    message.usage.output,
    message.usage.cacheRead,
    message.usage.cacheWrite,
  ];
  return (
    tokenValues.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    Number.isSafeInteger(
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    ) &&
    spendMicroUsd >= 0 &&
    Number.isSafeInteger(spendMicroUsd)
  );
}

function initialInputMeasurement(
  prompt: string,
  systemPrompt: string,
  tools: readonly ToolDefinition[],
  harness: BaselineHarnessRevision,
): Extract<ContextCapacityMeasurement, { readonly kind: 'InitialInput' }> {
  const toolContract = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const bytes = new TextEncoder().encode(
    `${systemPrompt}\n${prompt}\n${JSON.stringify(toolContract)}`,
  ).byteLength;
  return {
    kind: 'InitialInput',
    encodedBytes: bytes,
    allowedInputTokens:
      harness.modelCompatibility.contextWindowTokens -
      harness.modelCompatibility.maximumOutputTokens,
    providerRequestsAdmitted: 0,
  };
}

export function requestContextMeasurement(
  messages: Parameters<typeof estimateTokens>[0][],
  harness: {
    readonly modelCompatibility: Pick<
      BaselineHarnessRevision['modelCompatibility'],
      'provider' | 'model' | 'contextWindowTokens' | 'maximumOutputTokens'
    >;
  },
  providerRequestsAdmitted: number,
): Extract<ContextCapacityMeasurement, { readonly kind: 'ProviderRequest' }> | undefined {
  const piEstimate = messages.reduce((total, message) => total + estimateTokens(message), 0);
  const encoded = JSON.stringify(messages);
  const encodedBytes = new TextEncoder().encode(encoded).byteLength;
  const asciiGemmaProfile =
    harness.modelCompatibility.provider === concentrateProviderId &&
    harness.modelCompatibility.model === 'deepinfra/gemma-4-e4b' &&
    encodedBytes === encoded.length;
  // This is a model-scoped preflight estimate, not a provider token count.
  // Budget custody retains the full byte bound; provider failure cannot authorize tools.
  const estimate = asciiGemmaProfile
    ? Math.max(piEstimate * 2 + 4_096, Math.ceil(encodedBytes / 2))
    : Math.max(piEstimate, encodedBytes);
  if (!Number.isSafeInteger(estimate) || estimate < 0) return undefined;
  return {
    kind: 'ProviderRequest',
    piEstimateTokens: piEstimate,
    encodedBytes,
    profile: asciiGemmaProfile ? 'AsciiGemmaEstimate' : 'ByteFallback',
    admissionEstimateTokens: estimate,
    allowedInputTokens:
      harness.modelCompatibility.contextWindowTokens -
      harness.modelCompatibility.maximumOutputTokens,
    providerRequestsAdmitted,
  };
}

export function requestInputTokens(
  messages: Parameters<typeof estimateTokens>[0][],
): number | undefined {
  const piEstimate = messages.reduce((total, message) => total + estimateTokens(message), 0);
  // Reserve the full encoded byte allowance, not an average characters-per-token ratio.
  // The normalized transcript includes system sections and tool declarations.
  const encodedEstimate = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  const inputTokens = Math.max(piEstimate, encodedEstimate);
  return Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : undefined;
}

function maximumCostRate(model: Model<Api>, kind: 'Input' | 'Output'): number | undefined {
  const costs = [model.cost, ...(model.cost.tiers ?? [])];
  const rates =
    kind === 'Input'
      ? costs.flatMap(({ input, cacheRead, cacheWrite }) => [input, cacheRead, cacheWrite])
      : costs.map(({ output }) => output);
  return rates.every((rate) => Number.isFinite(rate) && rate >= 0) ? Math.max(...rates) : undefined;
}

export function providerReservation(
  inputTokens: number,
  maximumOutputTokens: number,
  model: Model<Api>,
): readonly RunBudgetAmount[] | undefined {
  const inputRate = maximumCostRate(model, 'Input');
  const outputRate = maximumCostRate(model, 'Output');
  if (inputRate === undefined || outputRate === undefined) {
    return undefined;
  }
  const spendMicroUsd = Math.ceil(inputTokens * inputRate + maximumOutputTokens * outputRate);
  if (!Number.isSafeInteger(spendMicroUsd)) {
    return undefined;
  }
  const reservation: RunBudgetAmount[] = [
    { budget: 'providerRequests', amount: 1 },
    { budget: 'providerInputTokens', amount: Math.max(1, inputTokens) },
    { budget: 'providerOutputTokens', amount: maximumOutputTokens },
  ];
  if (spendMicroUsd > 0) {
    reservation.push({ budget: 'providerSpendMicroUsd', amount: spendMicroUsd });
  }
  return reservation;
}

export function providerActualUsage(
  message: AssistantMessage,
  spendMicroUsd: number,
): readonly RunBudgetAmount[] {
  const amounts: RunBudgetAmount[] = [{ budget: 'providerRequests', amount: 1 }];
  const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  if (inputTokens > 0) {
    amounts.push({ budget: 'providerInputTokens', amount: inputTokens });
  }
  if (message.usage.output > 0) {
    amounts.push({ budget: 'providerOutputTokens', amount: message.usage.output });
  }
  if (spendMicroUsd > 0) {
    amounts.push({ budget: 'providerSpendMicroUsd', amount: spendMicroUsd });
  }
  return amounts;
}

export function budgetTerminal(
  commitment: RunBudgetCommitment,
): ExecutorTerminalDisposition | undefined {
  switch (commitment.kind) {
    case 'SecretDetected':
      return commitment;
    case 'Committed':
      return undefined;
    case 'Exhausted':
      return { kind: 'BudgetExhausted' };
    case 'OutboxBackpressure':
      return commitment;
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'ReservationRejected':
    case 'EvidenceIntegrityFailure':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

export class BaselinePiExecutor implements PiExecution {
  readonly #dependencies: BaselinePiExecutorDependencies;

  constructor(dependencies: BaselinePiExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async invoke(run: Run, signal: AbortSignal): Promise<PiExecutionDisposition> {
    const harness = this.#dependencies.harness;
    const disclosure = this.#dependencies.protectedCredentials.inspect(
      new TextEncoder().encode(
        JSON.stringify({
          instructions: this.#dependencies.instructions,
          prompt: this.#dependencies.prompt,
        }),
      ),
    );
    if (disclosure.kind === 'WithheldSecret') {
      return recordingTerminal(
        this.#dependencies.evidence.withhold({
          occurredAt: this.#dependencies.now(),
          producer: { kind: 'PiExecutor' },
          disclosure,
        }),
      );
    }
    if (!this.#bindingMatches(run) || !this.#instructionsMatch()) {
      return { kind: 'DependencyUnavailable' };
    }
    const opened = await this.#dependencies.modelAccess.open(harness.modelCompatibility);
    switch (opened.kind) {
      case 'ConfigurationRequired':
        return { kind: 'ModelConfigurationRequired' };
      case 'CredentialUnavailable':
        return { kind: 'ModelCredentialUnavailable' };
      case 'Unavailable':
        return { kind: 'DependencyUnavailable' };
      case 'Opened':
        break;
    }

    const sessionId = this.#dependencies.sessionId();
    let modelTurnId: string | undefined;
    let turnIndex = 0;
    let providerRequestsAdmitted = 0;
    let proposalIndex = 0;
    let completedMessageCount = 0;
    let requestReservation: AcceptedRunBudgetReservation | undefined;
    let terminal: ExecutorTerminalDisposition | undefined;
    let abortSession: (() => Promise<void>) | undefined;
    const settleTerminal = (disposition: ExecutorTerminalDisposition) => {
      terminal ??= disposition;
      if (abortSession !== undefined) {
        void abortSession().catch(() => undefined);
      }
    };
    const tools = harness.activeTools.flatMap((active) => {
      const descriptor = toolDescriptors.find(({ name }) => name === active.identity);
      return descriptor === undefined
        ? []
        : [
            this.#tool(
              descriptor,
              sessionId,
              () => {
                if (modelTurnId === undefined) {
                  return undefined;
                }
                const origin = { modelTurnId, proposalIndex };
                proposalIndex += 1;
                return origin;
              },
              settleTerminal,
              () => {
                settleTerminal({ kind: 'Completed', sessionId });
              },
              signal,
            ),
          ];
    });
    const activeNames = harness.activeTools.map(({ identity }) => identity);
    if (
      tools.length !== activeNames.length ||
      tools.some(({ name }, index) => name !== activeNames[index])
    ) {
      return { kind: 'DependencyUnavailable' };
    }
    const systemPrompt = runInstructionPrompt(this.#dependencies.instructions);
    const initialContext = initialInputMeasurement(
      this.#dependencies.prompt,
      systemPrompt,
      tools,
      harness,
    );
    if (initialContext.encodedBytes > initialContext.allowedInputTokens) {
      return { kind: 'ContextLimitReached', measurement: initialContext };
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: 'off',
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.#dependencies.worktree,
      agentDir: this.#dependencies.agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    try {
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: this.#dependencies.worktree,
        agentDir: this.#dependencies.agentDirectory,
        model: opened.model,
        modelRuntime: opened.runtime,
        thinkingLevel: harness.modelCompatibility.thinkingLevel,
        settingsManager,
        sessionManager: SessionManager.inMemory(this.#dependencies.worktree, { id: sessionId }),
        resourceLoader,
        noTools: 'all',
        tools: activeNames,
        customTools: tools,
      });
      const session = created.session;
      abortSession = () => session.abort();
      session.agent.toolExecution = 'sequential';
      const prepareRequest = session.agent.prepareRequest;
      session.agent.prepareRequest = async (request, prepareSignal) => {
        if (!continuationPending()) {
          throw new Error('The Run executor has stopped before provider request admission.');
        }
        const prepared = await prepareRequest?.(request, prepareSignal);
        if (!continuationPending()) {
          throw new Error('The Run executor stopped during provider request preparation.');
        }
        const context = prepared?.context ?? request.context;
        const requestContext = requestContextMeasurement(
          context.messages,
          harness,
          providerRequestsAdmitted,
        );
        if (requestContext === undefined) {
          settleTerminal({ kind: 'EvidenceIntegrityFailure' });
          throw new Error('The complete Pi request context estimate is invalid.');
        }
        if (requestContext.admissionEstimateTokens > requestContext.allowedInputTokens) {
          settleTerminal({ kind: 'ContextLimitReached', measurement: requestContext });
          throw new Error('The complete Pi request exceeds the H1 context window.');
        }
        const inputTokens = requestInputTokens(context.messages);
        const amounts =
          inputTokens === undefined
            ? undefined
            : providerReservation(
                inputTokens,
                harness.modelCompatibility.maximumOutputTokens,
                opened.model,
              );
        if (amounts === undefined || requestReservation !== undefined) {
          settleTerminal({ kind: 'EvidenceIntegrityFailure' });
          throw new Error('The provider request budget reservation is invalid.');
        }
        const reservation = this.#dependencies.budget.reserve(amounts);
        if (reservation.kind !== 'Reserved') {
          settleTerminal(
            reservation.kind === 'Exhausted'
              ? { kind: 'BudgetExhausted' }
              : { kind: 'EvidenceIntegrityFailure' },
          );
          throw new Error('The provider request exceeds the remaining Run budget.');
        }
        requestReservation = reservation.reservation;
        providerRequestsAdmitted += 1;
        return prepared === undefined ? undefined : prepared;
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'turn_start') {
          if (terminal !== undefined) return;
          modelTurnId = this.#dependencies.modelTurnId(turnIndex);
          turnIndex += 1;
          proposalIndex = 0;
          const recording = this.#dependencies.evidence.record({
            occurredAt: this.#dependencies.now(),
            producer: { kind: 'PiExecutor' },
            event: {
              kind: 'ModelRequest',
              piSessionId: sessionId,
              modelTurnId,
              provider: harness.modelCompatibility.provider,
              model: harness.modelCompatibility.model,
              maximumOutputTokens: harness.modelCompatibility.maximumOutputTokens,
            },
          });
          if (recording.kind !== 'Recorded') {
            settleTerminal(recordingTerminal(recording));
          }
          return;
        }
        if (event.type !== 'message_end' || event.message.role !== 'assistant') {
          return;
        }
        const exactTurnId = modelTurnId;
        const reserved = requestReservation;
        requestReservation = undefined;
        if (reserved === undefined && (terminal !== undefined || signal.aborted)) return;
        if (exactTurnId === undefined || reserved === undefined) {
          settleTerminal({ kind: 'EvidenceIntegrityFailure' });
          return;
        }
        const usageReceipt = opened.consumeUsage(event.message);
        if (
          usageReceipt.kind !== 'Verified' ||
          !usageIsAccountable(event.message, usageReceipt.spendMicroUsd)
        ) {
          const requestDebit = this.#dependencies.budget.commit(reserved, {
            producer: { kind: 'PiExecutor' },
            actual: [{ budget: 'providerRequests', amount: 1 }],
          });
          const debitFailure = budgetTerminal(requestDebit);
          if (debitFailure !== undefined) {
            settleTerminal(debitFailure);
            return;
          }
          settleTerminal({ kind: 'ModelUsageUnavailable' });
          return;
        }
        const commitment = this.#dependencies.budget.commit(reserved, {
          producer: { kind: 'PiExecutor' },
          actual: providerActualUsage(event.message, usageReceipt.spendMicroUsd),
        });
        const budgetFailure = budgetTerminal(commitment);
        if (budgetFailure !== undefined && budgetFailure.kind !== 'BudgetExhausted') {
          settleTerminal(budgetFailure);
          return;
        }
        const artifact = this.#dependencies.evidence.storeArtifact({
          bytes: new TextEncoder().encode(JSON.stringify({ message: event.message, usageReceipt })),
          mediaType: 'application/json',
        });
        if (artifact.kind !== 'Stored' && artifact.kind !== 'AlreadyStored') {
          settleTerminal(
            artifact.kind === 'SecretDetected' ? artifact : { kind: 'EvidenceIntegrityFailure' },
          );
          return;
        }
        const disposition =
          event.message.stopReason === 'aborted'
            ? 'Aborted'
            : event.message.stopReason === 'error'
              ? 'ProviderFailure'
              : 'Completed';
        const recording = this.#dependencies.evidence.record({
          occurredAt: this.#dependencies.now(),
          producer: { kind: 'PiExecutor' },
          event: {
            kind: 'ModelMessageCompleted',
            piSessionId: sessionId,
            modelTurnId: exactTurnId,
            messageArtifactSaid: artifact.artifact.d,
            disposition,
            usage: {
              inputTokens: event.message.usage.input,
              outputTokens: event.message.usage.output,
              cacheReadTokens: event.message.usage.cacheRead,
              cacheWriteTokens: event.message.usage.cacheWrite,
              spendMicroUsd: usageReceipt.spendMicroUsd,
            },
          },
        });
        if (recording.kind !== 'Recorded') {
          settleTerminal(recordingTerminal(recording));
          return;
        }
        completedMessageCount += 1;
        if (budgetFailure !== undefined) {
          settleTerminal(budgetFailure);
          return;
        }
        if (event.message.stopReason === 'error') {
          settleTerminal({ kind: 'ProviderUnavailable' });
        }
      });
      const abort = () => {
        void session.abort();
      };
      const continuationPending = () => terminal === undefined && !signal.aborted;
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) {
          return { kind: 'Aborted' };
        }
        await session.prompt(this.#dependencies.prompt, {
          expandPromptTemplates: false,
        });
        while (continuationPending() && activeNames.includes('submit_result')) {
          const priorCompletedMessageCount = completedMessageCount;
          await session.prompt(submissionReminder, { expandPromptTemplates: false });
          if (continuationPending() && completedMessageCount === priorCompletedMessageCount) {
            settleTerminal({ kind: 'ProviderUnavailable' });
          }
        }
      } catch {
        if (requestReservation !== undefined) {
          const requestDebit = this.#dependencies.budget.commit(requestReservation, {
            producer: { kind: 'PiExecutor' },
            actual: [{ budget: 'providerRequests', amount: 1 }],
          });
          requestReservation = undefined;
          const debitFailure = budgetTerminal(requestDebit);
          if (debitFailure !== undefined) {
            return debitFailure;
          }
        }
        if (signal.aborted) {
          return { kind: 'Aborted' };
        }
        return terminal ?? { kind: 'ProviderUnavailable' };
      } finally {
        signal.removeEventListener('abort', abort);
        unsubscribe();
        session.dispose();
      }
      if (terminal !== undefined) {
        return terminal;
      }
      if (!continuationPending()) {
        return { kind: 'Aborted' };
      }
      return completedMessageCount > 0
        ? { kind: 'Completed', sessionId }
        : { kind: 'ProviderUnavailable' };
    } catch {
      return terminal ?? { kind: 'DependencyUnavailable' };
    }
  }

  #tool(
    descriptor: ToolDescriptor,
    sessionId: string,
    origin: () => { readonly modelTurnId: string; readonly proposalIndex: number } | undefined,
    settleTerminal: (disposition: ExecutorTerminalDisposition) => void,
    settleSubmission: () => void,
    runSignal: AbortSignal,
  ): ToolDefinition {
    return defineTool({
      name: descriptor.name,
      label: descriptor.label,
      description: descriptor.description,
      parameters: descriptor.parameters,
      executionMode: 'sequential',
      execute: async (toolCallId, parameters, toolSignal) => {
        const exactOrigin = origin();
        if (exactOrigin === undefined) {
          settleTerminal({ kind: 'DependencyUnavailable' });
          return {
            content: [{ type: 'text', text: 'Tool call has no active model turn.' }],
            details: undefined,
            terminate: true,
          };
        }
        let outcome: ToolGatewayOutcome;
        try {
          outcome = await this.#dependencies.gateway.propose(
            {
              piSessionId: sessionId,
              modelTurnId: exactOrigin.modelTurnId,
              toolCallId,
              proposalIndex: exactOrigin.proposalIndex,
              input: descriptor.input(parameters),
            },
            toolSignal === undefined ? runSignal : AbortSignal.any([runSignal, toolSignal]),
          );
        } catch {
          outcome = { kind: 'DependencyUnavailable' };
        }
        const terminalDisposition = toolTerminal(outcome);
        if (terminalDisposition !== undefined) {
          settleTerminal(terminalDisposition);
        }
        const retainedSubmission =
          descriptor.name === 'submit_result' &&
          outcome.kind === 'SubmissionVerified' &&
          outcome.disposition !== 'Rejected';
        if (retainedSubmission) {
          settleSubmission();
        }
        return {
          content: [{ type: 'text', text: toolSummary(outcome) }],
          details: undefined,
          ...(terminalDisposition === undefined && !retainedSubmission ? {} : { terminate: true }),
        };
      },
    });
  }

  #bindingMatches(run: Run): boolean {
    const harness = this.#dependencies.harness;
    return (
      run.lifecycle.kind === 'Active' &&
      run.lifecycle.phase.kind === 'Running' &&
      run.lease.kind === 'Held' &&
      run.binding.taskId === harness.task.taskId &&
      run.binding.taskRevisionSaid === harness.task.revisionSaid &&
      run.binding.harnessLineageId === harness.task.harnessLineageId &&
      run.binding.personalAgentAid === harness.authority.personalAgentAid &&
      run.binding.taskMandateSaid === harness.authority.taskMandateSaid &&
      run.binding.initialHarnessRevisionSaid === harness.d &&
      run.binding.repository.objectFormat === harness.repository.objectFormat &&
      run.binding.repository.commit === harness.repository.commit &&
      run.binding.repository.tree === harness.repository.tree
    );
  }

  #instructionsMatch(): boolean {
    const expected = this.#dependencies.harness.repository.instructionResources;
    const actual = this.#dependencies.instructions;
    if (expected.length !== actual.length) {
      return false;
    }
    return actual.every((instruction, index) => {
      const identified = identifyHarnessInstruction(instruction);
      const resource = expected[index];
      return (
        identified.kind === 'Identified' &&
        resource !== undefined &&
        identified.resource.path === resource.path &&
        identified.resource.contentSaid === resource.contentSaid
      );
    });
  }
}
