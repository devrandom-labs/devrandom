import { createActor, fromCallback, setup } from 'xstate';

import { describe, expect, it } from 'vitest';

interface AuthoritativeRunFacts {
  readonly taskRevisionId: string;
  readonly mandateRevisionId: string;
  readonly harnessRevisionId: string;
  readonly checkpointId: string;
}

const acceptedFacts: AuthoritativeRunFacts = {
  taskRevisionId: 'task-revision-1',
  mandateRevisionId: 'mandate-revision-1',
  harnessRevisionId: 'harness-revision-1',
  checkpointId: 'checkpoint-1',
};

function runMachine(timeline: string[]) {
  return setup({
    types: {
      events: {} as
        | { readonly type: 'run.completed' }
        | { readonly type: 'run.failed' }
        | { readonly type: 'run.cancelled' },
    },
    actors: {
      executor: fromCallback(() => {
        timeline.push('invocation_started');
      }),
    },
  }).createMachine({
    id: 'e0-run',
    initial: 'running',
    states: {
      running: {
        invoke: { id: 'executor', src: 'executor' },
        on: {
          'run.completed': 'completed',
          'run.failed': 'failed',
          'run.cancelled': 'cancelled',
        },
      },
      completed: { type: 'final' },
      failed: { type: 'final' },
      cancelled: { type: 'final' },
    },
  });
}

function sameFacts(left: AuthoritativeRunFacts, right: AuthoritativeRunFacts): boolean {
  return (
    left.taskRevisionId === right.taskRevisionId &&
    left.mandateRevisionId === right.mandateRevisionId &&
    left.harnessRevisionId === right.harnessRevisionId &&
    left.checkpointId === right.checkpointId
  );
}

describe('E0 XState persistence contract', () => {
  it.each([
    ['run.completed', 'completed'],
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
  ] as const)('represents %s as the named %s outcome', (eventType, outcome) => {
    const actor = createActor(runMachine([])).start();

    actor.send({ type: eventType });

    expect(actor.getSnapshot().value).toBe(outcome);
  });

  it('reconciles authoritative facts before a persisted invocation restarts', async () => {
    const original = createActor(runMachine([])).start();
    const serialized = JSON.stringify({
      schemaVersion: 1,
      facts: acceptedFacts,
      snapshot: original.getPersistedSnapshot(),
    });
    original.stop();

    const timeline: string[] = [];
    const stored = JSON.parse(serialized) as {
      readonly schemaVersion: number;
      readonly facts: AuthoritativeRunFacts;
      readonly snapshot: ReturnType<typeof original.getPersistedSnapshot>;
    };
    const currentFacts = await Promise.resolve().then(() => {
      timeline.push('facts_reconciled');
      return acceptedFacts;
    });
    if (stored.schemaVersion !== 1 || !sameFacts(stored.facts, currentFacts)) {
      throw new Error('persisted run requires reconciliation');
    }

    const restored = createActor(runMachine(timeline), { snapshot: stored.snapshot }).start();

    expect(timeline).toEqual(['facts_reconciled', 'invocation_started']);
    expect(restored.getSnapshot().value).toBe('running');
    restored.stop();
  });

  it('does not restore an invocation when authoritative facts changed', async () => {
    const original = createActor(runMachine([])).start();
    const serialized = JSON.stringify({
      schemaVersion: 1,
      facts: acceptedFacts,
      snapshot: original.getPersistedSnapshot(),
    });
    original.stop();

    const timeline: string[] = [];
    const stored = JSON.parse(serialized) as {
      readonly schemaVersion: number;
      readonly facts: AuthoritativeRunFacts;
      readonly snapshot: ReturnType<typeof original.getPersistedSnapshot>;
    };
    const currentFacts = await Promise.resolve().then(() => {
      timeline.push('facts_reconciled');
      return { ...acceptedFacts, mandateRevisionId: 'mandate-revoked' };
    });

    const mayRestore = stored.schemaVersion === 1 && sameFacts(stored.facts, currentFacts);

    expect(mayRestore).toBe(false);
    expect(timeline).toEqual(['facts_reconciled']);
  });
});
