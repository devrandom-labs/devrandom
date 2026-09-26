import { describe, expect, it } from 'vitest';
import { verifyContinuationPredecessor } from '@devrandom/protocol';
import { runFixture } from '../test/run-fixture.js';
import { sealedRunPredecessorFixture } from '../test/sealed-run-predecessor-fixture.js';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
describe('sealed predecessor replay for same-Run continuation', () => {
  it('requires exact sealed checkpoint/head and rejects a pending authorized effect', () => {
    const intact = sealedRunPredecessorFixture();
    expect(verifyContinuationPredecessor(intact)).toBe('Verified');
    expect(verifyContinuationPredecessor({ ...intact, chainHeadSaid: `E${'x'.repeat(43)}` })).toBe(
      'Rejected',
    );
    expect(
      verifyContinuationPredecessor({
        ...intact,
        stream: { ...intact.stream, seal: { kind: 'Open' } },
      }),
    ).toBe('Rejected');
    const pending = sealedRunPredecessorFixture([
      {
        kind: 'ToolAuthorized',
        piSessionId: incarnationId,
        modelTurnId: 'turn-1',
        toolCallId: 'tool-1',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'cargo test',
        mandateSaid: runFixture().binding.taskMandateSaid,
      },
    ]);
    expect(verifyContinuationPredecessor(pending)).toBe('Rejected');
  });
});

it('verifies the original sealed compatibility failure as the first committed-H2 predecessor', () => {
  expect(
    verifyContinuationPredecessor(sealedRunPredecessorFixture([], 'HarnessCompatibilityFailure')),
  ).toBe('Verified');
});

it('replays sealed ContextLimitReached only for an unchanged calibration purpose', () => {
  const intact = sealedRunPredecessorFixture([], 'ContextLimitReached');
  expect(verifyContinuationPredecessor(intact)).toBe('Verified');
  expect(
    verifyContinuationPredecessor({
      ...intact,
      run: { ...intact.run, binding: { ...intact.run.binding, purpose: { kind: 'Retained' } } },
    }),
  ).toBe('Rejected');
  expect(
    verifyContinuationPredecessor({
      ...intact,
      run: {
        ...intact.run,
        binding: {
          ...intact.run.binding,
          purpose: {
            kind: 'PreparedCompatibilityCalibration',
            campaignId: '11111111-1111-4111-8111-111111111111',
            ordinal: 2,
          },
        },
      },
    }),
  ).toBe('Rejected');
});
