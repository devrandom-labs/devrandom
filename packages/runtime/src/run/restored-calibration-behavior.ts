import type { Message, TranscriptContext } from '@earendil-works/pi-ai';
import type { SuccessorRunBehavior } from './successor-run-behavior.js';
import { digestRunRuntimePrompt } from './runtime-prompt-digest.js';

/** Restores full prior provider context while the unchanged worker executes only new messages. */
export class RestoredCalibrationBehavior implements SuccessorRunBehavior {
  readonly #input: {
    readonly runId: string;
    readonly harnessRevisionSaid: string;
    readonly executionProfileSaid: string;
    readonly messages: readonly Message[];
  };
  #prompt: string | undefined;
  constructor(input: {
    readonly runId: string;
    readonly harnessRevisionSaid: string;
    readonly executionProfileSaid: string;
    readonly messages: readonly Message[];
  }) {
    this.#input = structuredClone(input);
  }
  prepare(
    input: Parameters<SuccessorRunBehavior['prepare']>[0],
  ): ReturnType<SuccessorRunBehavior['prepare']> {
    if (
      this.#prompt !== undefined ||
      input.signal.aborted ||
      input.run.binding.runId !== this.#input.runId ||
      input.run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      input.run.binding.initialHarnessRevisionSaid !== this.#input.harnessRevisionSaid ||
      input.run.currentExecution?.harnessRevisionSaid !== this.#input.harnessRevisionSaid ||
      input.executionProfileSaid !== this.#input.executionProfileSaid ||
      this.#input.messages.length === 0
    )
      return Promise.resolve({ kind: 'Rejected' });
    this.#prompt = input.taskPrompt;
    return Promise.resolve({
      kind: 'Prepared',
      systemPrompt: input.baseSystemPrompt,
      prompt: input.taskPrompt,
      promptDigest: digestRunRuntimePrompt(input.baseSystemPrompt, input.taskPrompt),
    });
  }
  observeProposal(): void {
    /* New proposals retain ordinary Tool Gateway authorization. */
  }
  beforeModel(
    context: TranscriptContext,
    signal: AbortSignal,
  ): Promise<TranscriptContext | undefined> {
    if (signal.aborted || this.#prompt === undefined) return Promise.resolve(undefined);
    const firstUser = context.messages.findIndex((message) => message.role !== 'system');
    const original = context.messages[firstUser];
    if (
      original?.role !== 'user' ||
      (typeof original.content === 'string'
        ? original.content
        : original.content.length === 1 && original.content[0]?.type === 'text'
          ? original.content[0].text
          : undefined) !== this.#prompt
    )
      return Promise.resolve(undefined);
    return Promise.resolve({
      ...context,
      messages: [
        ...context.messages.slice(0, firstUser + 1),
        ...structuredClone(this.#input.messages),
        ...context.messages.slice(firstUser + 1),
      ],
    });
  }
}
