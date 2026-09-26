import { expect, it } from 'vitest';
import type { Run } from '@devrandom/domain';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { RestoredCalibrationBehavior } from './restored-calibration-behavior.js';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
it('keeps original prompts and prepends all history only to provider context on every new request', async () => {
  const history = [fauxAssistantMessage('all original content')];
  const behavior = new RestoredCalibrationBehavior({
    runId: 'run',
    harnessRevisionSaid: 'h1',
    executionProfileSaid: 'profile',
    messages: history,
  });
  const signal = new AbortController().signal;
  const context = normalizeContext({
    systemPrompt: 'original system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'original task' }], timestamp: 0 }],
  });
  expect(await behavior.beforeModel(context, signal)).toBeUndefined();
  const prepared = await behavior.prepare({
    run: {
      binding: {
        runId: 'run',
        purpose: { kind: 'PreparedCompatibilityCalibration' },
        initialHarnessRevisionSaid: 'h1',
      },
      currentExecution: { harnessRevisionSaid: 'h1' },
    } as Run,
    executionProfileSaid: 'profile',
    baseSystemPrompt: 'original system',
    taskPrompt: 'original task',
    evidence: {} as EvidenceRecorder,
    signal,
  });
  expect(prepared).toMatchObject({
    kind: 'Prepared',
    systemPrompt: 'original system',
    prompt: 'original task',
  });
  expect((await behavior.beforeModel(context, signal))?.messages).toEqual([
    ...context.messages,
    ...history,
  ]);
  const next = {
    ...context,
    messages: [...context.messages, fauxAssistantMessage('new response')],
  };
  expect((await behavior.beforeModel(next, signal))?.messages).toEqual([
    ...context.messages,
    ...history,
    next.messages.at(-1),
  ]);
  expect(context.messages).toHaveLength(2);
  expect(
    await behavior.beforeModel(
      normalizeContext({ messages: [{ role: 'user', content: 'changed task', timestamp: 0 }] }),
      signal,
    ),
  ).toBeUndefined();
});
