import { expect, it } from 'vitest';
import {
  evaluateLocalHarness,
  type LocalHarnessEvaluationInput,
} from './local-harness-evaluation.js';
it('rejects unavailable policy before touching hosted authority, model, lease, or worker', async () => {
  const input = {
    policyPath: '/missing/devrandom-evaluation-policy.json',
    signal: new AbortController().signal,
  } as LocalHarnessEvaluationInput;
  expect(await evaluateLocalHarness(input)).toEqual({ kind: 'Blocked', gate: 'Policy' });
  const controller = new AbortController();
  controller.abort();
  expect(await evaluateLocalHarness({ ...input, signal: controller.signal })).toEqual({
    kind: 'Interrupted',
  });
});
