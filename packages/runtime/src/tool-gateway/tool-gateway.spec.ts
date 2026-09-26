import { describe, expect, it, vi } from 'vitest';

import { prepareEvidenceEvent } from '@devrandom/protocol';

import type { EvidenceObservation, EvidenceRecording } from '../evidence/evidence-recorder.js';
import {
  ToolGateway,
  type CurrentToolMandate,
  type CurrentToolMandateInspection,
  type HeldToolLease,
  type ToolEffects,
  type ToolGatewayProposal,
  type ToolProposalBudget,
  type ToolResourceScope,
} from './tool-gateway.js';

const binding = {
  taskRevisionSaid: `E${'t'.repeat(43)}`,
  runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
  incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
  harnessRevisionSaid: `E${'h'.repeat(43)}`,
  taskMandateSaid: `E${'m'.repeat(43)}`,
};

function proposal(
  proposalIndex: number,
  toolCallId: string,
  input: ToolGatewayProposal['input'] = { kind: 'ReadFile', path: 'src/index.ts' },
): ToolGatewayProposal {
  return {
    piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    modelTurnId: 'turn-1',
    toolCallId,
    proposalIndex,
    input,
  };
}

function acceptingEvidence(events: EvidenceObservation[]) {
  let sequence = 0;
  let previousEventSaid: string | undefined;
  return {
    record(observation: EvidenceObservation): EvidenceRecording {
      events.push(observation);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          previousEventSaid === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previousEventSaid },
        taskId: '0d6971c5-2a18-4983-8973-f6fe818479dd',
        taskRevisionSaid: binding.taskRevisionSaid,
        runId: binding.runId,
        incarnationId: binding.incarnationId,
        harnessRevisionSaid: binding.harnessRevisionSaid,
        personalAgentAid: `E${'a'.repeat(43)}`,
        taskMandateSaid: binding.taskMandateSaid,
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      if (prepared.kind !== 'Prepared') {
        return { kind: 'ObservationRejected' };
      }
      sequence += 1;
      previousEventSaid = prepared.event.d;
      return { kind: 'Recorded', event: prepared.event };
    },
  };
}

function resources(): ToolResourceScope {
  return {
    resolve: (candidate) => ({
      kind: 'Resolved',
      resource:
        candidate.input.kind === 'ReadFile'
          ? `repository://${candidate.input.path}`
          : `tool://${candidate.input.kind}`,
    }),
  };
}

function currentMandate(): CurrentToolMandate {
  return {
    inspect: () =>
      Promise.resolve({
        kind: 'Current',
        mandateSaid: binding.taskMandateSaid,
        allowedCapabilities: [
          'ReadRepository',
          'EditRepository',
          'RunFormatter',
          'RunStaticAnalysis',
          'RunTests',
          'SubmitResult',
        ],
      }),
  };
}

function heldLease(): HeldToolLease {
  return { inspect: () => Promise.resolve({ kind: 'Held' }) };
}

function availableBudget(): ToolProposalBudget {
  return { reserve: () => Promise.resolve({ kind: 'Reserved' }) };
}

describe('sequential Tool Gateway', () => {
  it('records a missing submitted artifact as ordinary feedback without completing the effect', async () => {
    const events: EvidenceObservation[] = [];
    const failed = {
      kind: 'Failed' as const,
      failure: 'ArtifactUnavailable' as const,
      summary: 'The submitted artifact is unavailable; use an output artifact SAID.',
      outputArtifactSaids: [],
    };
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'submit_result', requiredCapability: 'SubmitResult' }],
      resources: resources(),
      mandate: currentMandate(),
      lease: heldLease(),
      budget: availableBudget(),
      evidence: acceptingEvidence(events),
      effects: { enact: () => Promise.resolve(failed) },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(
        proposal(0, 'submit-call', { kind: 'SubmitResult', artifactSaids: [`E${'x'.repeat(43)}`] }),
        new AbortController().signal,
      ),
    ).resolves.toEqual(failed);
    expect(events.map(({ event }) => event.kind)).toEqual([
      'ToolProposed',
      'ToolAuthorized',
      'EffectFailed',
    ]);
    expect(events.at(-1)?.event).toMatchObject({ failure: 'ArtifactUnavailable' });
  });

  it.each([
    'ToolProposed',
    'ToolAuthorized',
    'ToolRejected',
    'ApprovalRequired',
    'EffectCompleted',
  ] as const)(
    'preserves the effect boundary when recording %s reaches the outbox limit',
    async (eventKind) => {
      const events: EvidenceObservation[] = [];
      const accepted = acceptingEvidence(events);
      const enact = vi.fn<ToolEffects['enact']>(() =>
        Promise.resolve({ kind: 'Completed', summary: 'effect', outputArtifactSaids: [] }),
      );
      const gateway = new ToolGateway({
        binding,
        activeTools:
          eventKind === 'ToolRejected'
            ? []
            : [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
        resources: resources(),
        mandate:
          eventKind === 'ApprovalRequired'
            ? { inspect: () => Promise.resolve({ kind: 'ApprovalRequired' }) }
            : currentMandate(),
        lease: heldLease(),
        budget: availableBudget(),
        evidence: {
          record: (observation) =>
            observation.event.kind === eventKind
              ? { kind: 'OutboxBackpressure' }
              : accepted.record(observation),
        },
        effects: { enact },
        now: () => '2026-09-24T20:00:02.000Z',
      });

      await expect(
        gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
      ).resolves.toEqual({
        kind: eventKind === 'EffectCompleted' ? 'EvidenceIntegrityFailure' : 'OutboxBackpressure',
      });
      expect(enact).toHaveBeenCalledTimes(eventKind === 'EffectCompleted' ? 1 : 0);
      expect(events.some(({ event }) => event.kind === 'EffectCompleted')).toBe(false);
    },
  );

  it('counts a denied proposal against the Run ceiling before admitting another tool', async () => {
    const events: EvidenceObservation[] = [];
    let remaining = 1;
    const enact = vi.fn<ToolEffects['enact']>(() =>
      Promise.resolve({ kind: 'Completed', summary: 'effect', outputArtifactSaids: [] }),
    );
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: resources(),
      mandate: currentMandate(),
      lease: heldLease(),
      budget: {
        reserve: () => {
          if (remaining === 0) return Promise.resolve({ kind: 'Exhausted' });
          remaining -= 1;
          return Promise.resolve({ kind: 'Reserved' });
        },
      },
      evidence: acceptingEvidence(events),
      effects: { enact },
      now: () => '2026-09-24T20:00:02.000Z',
    });
    await expect(
      gateway.propose(
        proposal(0, 'denied', { kind: 'WriteFile', path: 'src/index.ts', content: 'x' }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'CapabilityNotGranted' });
    await expect(
      gateway.propose(proposal(1, 'after-denial'), new AbortController().signal),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'BudgetExhausted' });
    expect(enact).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event.kind)).toEqual([
      'ToolProposed',
      'ToolRejected',
      'ToolProposed',
      'ToolRejected',
    ]);
  });

  it('records an exact rejection without allowing it to authorize the next proposal', async () => {
    const events: EvidenceObservation[] = [];
    const effects: string[] = [];
    let inspection = 0;
    const mandate: CurrentToolMandate = {
      inspect: () => {
        inspection += 1;
        const outcome: CurrentToolMandateInspection =
          inspection === 1
            ? { kind: 'Expired' }
            : {
                kind: 'Current',
                mandateSaid: binding.taskMandateSaid,
                allowedCapabilities: ['ReadRepository'],
              };
        return Promise.resolve(outcome);
      },
    };
    const enact = vi.fn<ToolEffects['enact']>((authorized) => {
      effects.push(authorized.proposal.toolCallId);
      return Promise.resolve({
        kind: 'Completed',
        summary: `read ${authorized.resource}`,
        outputArtifactSaids: [],
      });
    });
    const toolEffects: ToolEffects = { enact };
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: resources(),
      mandate,
      lease: heldLease(),
      budget: availableBudget(),
      evidence: acceptingEvidence(events),
      effects: toolEffects,
      now: () => '2026-09-24T20:00:02.000Z',
    });

    const [first, second] = await Promise.all([
      gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
      gateway.propose(proposal(1, 'call-1'), new AbortController().signal),
    ]);

    expect(first).toEqual({ kind: 'Rejected', reason: 'MandateExpired' });
    expect(second).toEqual({
      kind: 'Completed',
      summary: 'read repository://src/index.ts',
      outputArtifactSaids: [],
    });
    expect(effects).toEqual(['call-1']);
    expect(events.map(({ event }) => event.kind)).toEqual([
      'ToolProposed',
      'ToolRejected',
      'ToolProposed',
      'ToolAuthorized',
      'EffectCompleted',
    ]);
    expect(
      events.flatMap(({ event }) => (event.kind === 'ToolAuthorized' ? [event.toolCallId] : [])),
    ).toEqual(['call-1']);
  });

  it('performs zero effect when the authorization receipt cannot enter evidence', async () => {
    const events: EvidenceObservation[] = [];
    const enact = vi.fn<ToolEffects['enact']>(() =>
      Promise.resolve({ kind: 'Completed', summary: 'impossible', outputArtifactSaids: [] }),
    );
    const effects: ToolEffects = { enact };
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: resources(),
      mandate: currentMandate(),
      lease: heldLease(),
      budget: availableBudget(),
      evidence: {
        record(observation) {
          events.push(observation);
          return observation.event.kind === 'ToolAuthorized'
            ? { kind: 'Unavailable' }
            : acceptingEvidence([]).record(observation);
        },
      },
      effects,
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
    ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
    expect(enact).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event.kind)).toEqual(['ToolProposed', 'ToolAuthorized']);
  });

  it('denies an unclassified target before current authority or effects are consulted', async () => {
    const events: EvidenceObservation[] = [];
    const mandate = currentMandate();
    const inspect = vi.spyOn(mandate, 'inspect');
    const enact = vi.fn<ToolEffects['enact']>(() =>
      Promise.resolve({ kind: 'Completed', summary: 'impossible', outputArtifactSaids: [] }),
    );
    const effects: ToolEffects = { enact };
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: { resolve: () => ({ kind: 'Denied', reason: 'PathEscape' }) },
      mandate,
      lease: heldLease(),
      budget: availableBudget(),
      evidence: acceptingEvidence(events),
      effects,
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'ResourceDenied' });
    expect(inspect).not.toHaveBeenCalled();
    expect(enact).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event.kind)).toEqual([
      'ToolProposed',
      'ToolRejected',
      'SecurityViolation',
    ]);
  });

  it('counts an approval-required proposal without consulting the lease or performing effects', async () => {
    const events: EvidenceObservation[] = [];
    const inspectLease = vi.fn<HeldToolLease['inspect']>(() => Promise.resolve({ kind: 'Held' }));
    const reserve = vi.fn<ToolProposalBudget['reserve']>(() =>
      Promise.resolve({ kind: 'Reserved' }),
    );
    const enact = vi.fn<ToolEffects['enact']>(() =>
      Promise.resolve({ kind: 'Completed', summary: 'impossible', outputArtifactSaids: [] }),
    );
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: resources(),
      mandate: { inspect: () => Promise.resolve({ kind: 'ApprovalRequired' }) },
      lease: { inspect: inspectLease },
      budget: { reserve },
      evidence: acceptingEvidence(events),
      effects: { enact },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
    ).resolves.toEqual({ kind: 'ApprovalRequired' });
    expect(inspectLease).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledExactlyOnceWith({
      runId: binding.runId,
      tool: 'read_file',
      requiredCapability: 'ReadRepository',
    });
    expect(enact).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event.kind)).toEqual(['ToolProposed', 'ApprovalRequired']);
  });

  it.each([
    'BudgetExhausted',
    'SecretDetected',
    'OutboxBackpressure',
    'DependencyUnavailable',
    'EvidenceIntegrityFailure',
  ] as const)(
    'retains output references and stops after a consequential %s failure',
    async (failure) => {
      const events: EvidenceObservation[] = [];
      const evidence = acceptingEvidence(events);
      const record = vi.spyOn(evidence, 'record');
      const outputArtifactSaids = [`E${'x'.repeat(43)}`, `E${'y'.repeat(43)}`];
      const gateway = new ToolGateway({
        binding,
        activeTools: [{ name: 'run_tests', requiredCapability: 'RunTests' }],
        resources: { resolve: () => ({ kind: 'Resolved', resource: 'command://public-test' }) },
        mandate: currentMandate(),
        lease: heldLease(),
        budget: availableBudget(),
        evidence,
        effects: {
          enact: () =>
            Promise.resolve({
              kind: 'Failed',
              failure,
              summary: 'Command stopped',
              outputArtifactSaids,
            }),
        },
        now: () => '2026-09-24T20:00:02.000Z',
      });
      await expect(
        gateway.propose(
          proposal(0, 'call-0', { kind: 'RunTests', commandId: 'public-test' }),
          new AbortController().signal,
        ),
      ).resolves.toEqual(
        failure === 'BudgetExhausted'
          ? { kind: 'Rejected', reason: 'BudgetExhausted' }
          : { kind: failure },
      );
      expect(events.map(({ event }) => event.kind)).toEqual([
        'ToolProposed',
        'ToolAuthorized',
        'EffectFailed',
      ]);
      expect(events.at(-1)?.event).toMatchObject({
        kind: 'EffectFailed',
        failure,
        outputArtifactSaids,
      });
      expect(record.mock.results.at(-1)?.value).toMatchObject({ kind: 'Recorded' });
    },
  );

  it.each(['Active', 'AbortedDuringEffect'] as const)(
    'stops on an unobserved consequential effect while supervision is %s',
    async (supervision) => {
      const events: EvidenceObservation[] = [];
      const cancellation = new AbortController();
      const effects: string[] = [];
      const enact = vi.fn<ToolEffects['enact']>(() => {
        effects.push('mutation already occurred');
        if (supervision === 'AbortedDuringEffect') cancellation.abort();
        return Promise.reject(new Error('untrusted error text must not enter evidence'));
      });
      const gateway = new ToolGateway({
        binding,
        activeTools: [{ name: 'run_tests', requiredCapability: 'RunTests' }],
        resources: { resolve: () => ({ kind: 'Resolved', resource: 'command://public-test' }) },
        mandate: currentMandate(),
        lease: heldLease(),
        budget: availableBudget(),
        evidence: acceptingEvidence(events),
        effects: { enact },
        now: () => '2026-09-24T20:00:02.000Z',
      });
      await expect(
        gateway.propose(
          proposal(0, 'call-0', { kind: 'RunTests', commandId: 'public-test' }),
          cancellation.signal,
        ),
      ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
      expect(effects).toEqual(['mutation already occurred']);
      expect(enact).toHaveBeenCalledOnce();
      expect(events.map(({ event }) => event.kind)).toEqual([
        'ToolProposed',
        'ToolAuthorized',
        'EffectFailed',
      ]);
      expect(events.at(-1)?.event).toEqual({
        kind: 'EffectFailed',
        failure: 'EvidenceIntegrityFailure',
        outputArtifactSaids: [],
        piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
        modelTurnId: 'turn-1',
        toolCallId: 'call-0',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'command://public-test',
      });
    },
  );

  it.each(['ProcessSurvivedTermination', 'ProcessCleanupUnconfirmed'] as const)(
    'records %s and stops execution after the failed effect',
    async (failure) => {
      const events: EvidenceObservation[] = [];
      const gateway = new ToolGateway({
        binding,
        activeTools: [{ name: 'run_tests', requiredCapability: 'RunTests' }],
        resources: { resolve: () => ({ kind: 'Resolved', resource: 'command://public-test' }) },
        mandate: currentMandate(),
        lease: heldLease(),
        budget: availableBudget(),
        evidence: acceptingEvidence(events),
        effects: {
          enact: () =>
            Promise.resolve({
              kind: 'Failed',
              failure,
              summary: 'child survived',
              outputArtifactSaids: [],
            }),
        },
        now: () => '2026-09-24T20:00:02.000Z',
      });

      await expect(
        gateway.propose(
          proposal(0, 'call-0', { kind: 'RunTests', commandId: 'public-test' }),
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
      expect(events.map(({ event }) => event.kind)).toEqual([
        'ToolProposed',
        'ToolAuthorized',
        'EffectFailed',
        'SecurityViolation',
      ]);
      expect(events.at(-1)?.event).toEqual({ kind: 'SecurityViolation', violation: failure });
    },
  );

  it('propagates evidence outbox backpressure without claiming the effect completed', async () => {
    const events: EvidenceObservation[] = [];
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'submit_result', requiredCapability: 'SubmitResult' }],
      resources: { resolve: () => ({ kind: 'Resolved', resource: 'submission://result' }) },
      mandate: currentMandate(),
      lease: heldLease(),
      budget: availableBudget(),
      evidence: acceptingEvidence(events),
      effects: { enact: () => Promise.resolve({ kind: 'OutboxBackpressure' }) },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(
        proposal(0, 'call-0', { kind: 'SubmitResult', artifactSaids: [] }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'OutboxBackpressure' });
    expect(events.map(({ event }) => event.kind)).toEqual(['ToolProposed', 'ToolAuthorized']);
  });

  it('records an exact rejection when a child command exhausts budget after authorization', async () => {
    const events: EvidenceObservation[] = [];
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'run_tests', requiredCapability: 'RunTests' }],
      resources: { resolve: () => ({ kind: 'Resolved', resource: 'command://public-test' }) },
      mandate: currentMandate(),
      lease: heldLease(),
      budget: availableBudget(),
      evidence: acceptingEvidence(events),
      effects: { enact: () => Promise.resolve({ kind: 'BudgetExhausted' }) },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(
        proposal(0, 'call-0', { kind: 'RunTests', commandId: 'public-test' }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'Rejected', reason: 'BudgetExhausted' });
    expect(events.map(({ event }) => event.kind)).toEqual([
      'ToolProposed',
      'ToolAuthorized',
      'ToolRejected',
    ]);
  });

  it('stops before authorization when the budget debit hits outbox backpressure', async () => {
    const events: EvidenceObservation[] = [];
    const enact = vi.fn<ToolEffects['enact']>(() =>
      Promise.resolve({ kind: 'Completed', summary: 'impossible', outputArtifactSaids: [] }),
    );
    const gateway = new ToolGateway({
      binding,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: resources(),
      mandate: currentMandate(),
      lease: heldLease(),
      budget: { reserve: () => Promise.resolve({ kind: 'OutboxBackpressure' }) },
      evidence: acceptingEvidence(events),
      effects: { enact },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(
      gateway.propose(proposal(0, 'call-0'), new AbortController().signal),
    ).resolves.toEqual({ kind: 'OutboxBackpressure' });
    expect(enact).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event.kind)).toEqual(['ToolProposed']);
  });
});
