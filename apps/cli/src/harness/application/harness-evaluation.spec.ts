import { expect, it } from 'vitest';

import { HarnessEvaluation, type HarnessEvaluationDependencies } from './harness-evaluation.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const commandId = 'da189a7b-a853-4d02-bfd8-e91b595ed359';
const fingerprint = `sha256:${'f'.repeat(64)}`;

function fixture(onAdmit?: () => void): {
  dependencies: HarnessEvaluationDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const policy = {
    d: said('p'),
    taskId,
    taskRevisionSaid: said('t'),
    originRunId,
    expectedActiveRevisionSaid: said('h'),
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    allocation: { diagnosis: {}, perEntry: {}, finalization: {} },
  };
  const task = {
    taskId,
    ownerAid: said('o'),
    revisionSaid: said('t'),
    revision: { repository: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) } },
  };
  const dependencies = {
    policy: {
      read: () => {
        calls.push('policy');
        return Promise.resolve({
          kind: 'Read' as const,
          policy,
          profile: {
            d: said('e'),
            sourceGitCommit: 'a'.repeat(40),
            sourceGitTree: 'b'.repeat(40),
          },
          inventory: { d: said('i'), taskId, taskRevisionSaid: said('t'), ownerAid: said('o') },
        });
      },
    },
    authority: {
      acquire: () => {
        calls.push('authority');
        return Promise.resolve({
          kind: 'Authorized' as const,
          ownerAid: said('o'),
          tasks: {
            inspect: () => {
              calls.push('task');
              return Promise.resolve({ kind: 'Inspected' as const, task });
            },
          },
          evaluations: {
            prepare: (command: { readonly commandId: string }) => {
              calls.push(`prepare:${command.commandId}`);
              return Promise.resolve({ kind: 'Prepared' as const });
            },
            admit: (command: { readonly commandId: string }) => {
              calls.push(`admit:${command.commandId}`);
              onAdmit?.();
              return Promise.resolve({
                kind: 'Admitted' as const,
                evaluationId,
                version: 1,
                lease: {
                  evaluationId,
                  leaseId: '71d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
                  version: 1,
                  serverTime: '2026-09-26T05:00:00.000Z',
                  expiresAt: '2026-09-26T05:00:45.000Z',
                },
                evidenceStreamId: '61d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
                reservationSaid: said('r'),
              });
            },
          },
        });
      },
    },
    qualification: {
      inspect: () => {
        calls.push('qualification');
        return Promise.resolve({
          kind: 'Qualified' as const,
          taskId,
          taskRevisionSaid: said('t'),
          originRunId,
          retainedCheckpointSaid: said('c'),
          retainedSealSaid: said('s'),
          expectedActiveRevisionSaid: said('h'),
          personalAgentAid: said('a'),
          taskMandateSaid: said('m'),
          executionProfileSaid: said('e'),
        });
      },
    },
    commands: {
      acquire: () => {
        calls.push('command');
        return Promise.resolve({ kind: 'Recorded' as const, commandId, fingerprint });
      },
      recordAdmission: () => {
        calls.push('record-admission');
        return Promise.resolve({ kind: 'Recorded' as const });
      },
    },
  };
  return { dependencies: dependencies as unknown as HarnessEvaluationDependencies, calls };
}

it('persists command before hosted prepare/admit and blocks worker until protected cases and M exist', async () => {
  const { dependencies, calls } = fixture();
  expect(
    await new HarnessEvaluation(dependencies).evaluate(
      'cesr-compat',
      originRunId,
      'policy.json',
      new AbortController().signal,
    ),
  ).toEqual({ kind: 'Blocked', gate: 'ProtectedCases' });
  expect(calls).toEqual([
    'policy',
    'authority',
    'task',
    'qualification',
    'command',
    `prepare:${commandId}`,
    `admit:${commandId}`,
    'record-admission',
  ]);
});

it('persists an accepted remote reservation before reporting interruption', async () => {
  const controller = new AbortController();
  const { dependencies, calls } = fixture(() => {
    controller.abort();
  });
  expect(
    await new HarnessEvaluation(dependencies).evaluate(
      'cesr-compat',
      originRunId,
      'policy.json',
      controller.signal,
    ),
  ).toEqual({ kind: 'Interrupted' });
  expect(calls.at(-1)).toBe('record-admission');
});

it('reports an interrupted hosted preparation as interruption before admission', async () => {
  const controller = new AbortController();
  const { dependencies: baseDependencies, calls } = fixture();
  const dependencies: HarnessEvaluationDependencies = {
    ...baseDependencies,
    authority: {
      acquire: async () => {
        const acquired = await baseDependencies.authority.acquire();
        if (acquired.kind !== 'Authorized') return acquired;
        return {
          ...acquired,
          evaluations: {
            ...acquired.evaluations,
            prepare: () => {
              controller.abort();
              return Promise.resolve({ kind: 'Unavailable' });
            },
          },
        };
      },
    },
  };
  expect(
    await new HarnessEvaluation(dependencies).evaluate(
      'cesr-compat',
      originRunId,
      'policy.json',
      controller.signal,
    ),
  ).toEqual({ kind: 'Interrupted' });
  expect(calls).not.toContain(`admit:${commandId}`);
});

it('reconciles an admitted command against the hosted receipt without preparing or starting a trial', async () => {
  const { dependencies: baseDependencies, calls } = fixture();
  const dependencies: HarnessEvaluationDependencies = {
    ...baseDependencies,
    commands: {
      ...baseDependencies.commands,
      acquire: () =>
        Promise.resolve({
          kind: 'Recorded',
          commandId,
          fingerprint,
          admittedEvaluationId: evaluationId,
        }),
    },
  };
  expect(
    await new HarnessEvaluation(dependencies).evaluate(
      'cesr-compat',
      originRunId,
      'policy.json',
      new AbortController().signal,
    ),
  ).toEqual({ kind: 'Reconciled', evaluationId });
  expect(calls).toEqual(['policy', 'authority', 'task', 'qualification', `admit:${commandId}`]);
});

it('stops before a command or hosted mutation when the six-Run qualification is absent', async () => {
  const { dependencies: baseDependencies, calls } = fixture();
  const dependencies: HarnessEvaluationDependencies = {
    ...baseDependencies,
    qualification: { inspect: () => Promise.resolve({ kind: 'Blocked' }) },
  };
  expect(
    await new HarnessEvaluation(dependencies).evaluate(
      'cesr-compat',
      originRunId,
      'policy.json',
      new AbortController().signal,
    ),
  ).toEqual({ kind: 'Blocked', gate: 'Qualification' });
  expect(calls).toEqual(['policy', 'authority', 'task']);
});
