import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
  decodeEvidenceEvent,
  evidenceArtifactReferences,
  prepareEvidenceEvent,
  type EvidenceEventDraft,
} from './evidence-event.js';

const binding = {
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: 'E'.concat('a'.repeat(43)),
  runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
  incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
  harnessRevisionSaid: 'E'.concat('b'.repeat(43)),
  personalAgentAid: 'E'.concat('c'.repeat(43)),
  taskMandateSaid: 'E'.concat('d'.repeat(43)),
};

function draft(): EvidenceEventDraft {
  return {
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    ...binding,
    occurredAt: '2026-09-24T20:00:02.000Z',
    recordedAt: '2026-09-24T20:00:02.001Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: 1 },
  };
}

describe('evidence event protocol', () => {
  it('rejects impossible event times before they can authorize a historical effect', () => {
    expect(
      prepareEvidenceEvent({
        ...draft(),
        occurredAt: '2026-02-30T20:00:02.000Z',
        recordedAt: '2026-02-30T20:00:02.001Z',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });

    const valid = prepareEvidenceEvent(draft());
    if (valid.kind !== 'Prepared') throw new Error('fixture event must prepare');
    const impossible: unknown = Saider.saidify({
      ...valid.event,
      d: '',
      recordedAt: '2026-02-30T20:00:02.001Z',
    })[1];
    expect(decodeEvidenceEvent(impossible)).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('prepares and verifies one exact self-addressed genesis event', () => {
    const prepared = prepareEvidenceEvent(draft());

    expect(prepared).toMatchObject({
      kind: 'Prepared',
      event: {
        version: 1,
        sequence: 0,
        predecessor: { kind: 'Genesis' },
        event: { kind: 'RunStarted', fromRunVersion: 1 },
      },
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture event must prepare');
    }
    expect(prepared.event.d).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(decodeEvidenceEvent(prepared.event)).toEqual({
      kind: 'Accepted',
      event: prepared.event,
    });
  });

  it('rejects a changed event under a retained SAID and an open payload alternative', () => {
    const prepared = prepareEvidenceEvent(draft());
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture event must prepare');
    }

    expect(
      decodeEvidenceEvent({
        ...prepared.event,
        event: { kind: 'RunStarted', fromRunVersion: 2 },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
    expect(
      decodeEvidenceEvent({
        ...prepared.event,
        event: { kind: 'SomethingElse', payload: { arbitrary: true } },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('requires Pi and tool attribution on the exact alternatives that own it', () => {
    const proposed = prepareEvidenceEvent({
      ...draft(),
      producer: { kind: 'ToolGateway' },
      event: {
        kind: 'ToolProposed',
        piSessionId: '9d28f884-ec25-4f1d-86fe-3a673e74ec38',
        modelTurnId: 'turn-1',
        toolCallId: 'call-1',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'command:public-test',
      },
    });

    expect(proposed).toMatchObject({ kind: 'Prepared' });
    expect(
      prepareEvidenceEvent({
        ...draft(),
        producer: { kind: 'ToolGateway' },
        event: {
          kind: 'ToolProposed',
          piSessionId: '',
          modelTurnId: 'turn-1',
          toolCallId: 'call-1',
          proposalIndex: 0,
          tool: 'run_tests',
          requiredCapability: 'RunTests',
          resource: 'command:public-test',
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('preserves an OpenAI Responses tool-call identifier as opaque attribution', () => {
    expect(
      prepareEvidenceEvent({
        ...draft(),
        producer: { kind: 'ToolGateway' },
        event: {
          kind: 'ToolProposed',
          piSessionId: '9d28f884-ec25-4f1d-86fe-3a673e74ec38',
          modelTurnId: 'turn-1',
          toolCallId: `call_${'a'.repeat(28)}|fc_${'b'.repeat(30)}`,
          proposalIndex: 0,
          tool: 'read_file',
          requiredCapability: 'ReadRepository',
          resource: 'repository://src/index.ts',
        },
      }),
    ).toMatchObject({ kind: 'Prepared' });
  });

  it('records an unavailable submitted artifact as an ordinary attributed effect failure', () => {
    expect(
      prepareEvidenceEvent({
        ...draft(),
        producer: { kind: 'ToolGateway' },
        event: {
          kind: 'EffectFailed',
          piSessionId: '9d28f884-ec25-4f1d-86fe-3a673e74ec38',
          modelTurnId: 'turn-1',
          toolCallId: 'submit-call',
          proposalIndex: 0,
          tool: 'submit_result',
          requiredCapability: 'SubmitResult',
          resource: 'submission:unavailable-artifact',
          failure: 'ArtifactUnavailable',
          outputArtifactSaids: [],
        },
      }),
    ).toMatchObject({ kind: 'Prepared' });
  });

  it('owns the exhaustive artifact references for each closed event alternative', () => {
    const messageArtifactSaid = 'E'.concat('e'.repeat(43));
    const outputArtifactSaid = 'E'.concat('f'.repeat(43));
    const summaryArtifactSaid = 'E'.concat('g'.repeat(43));

    expect(
      evidenceArtifactReferences({
        kind: 'ModelMessageCompleted',
        piSessionId: '9d28f884-ec25-4f1d-86fe-3a673e74ec38',
        modelTurnId: 'turn-1',
        messageArtifactSaid,
        disposition: 'Completed',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          spendMicroUsd: 1,
        },
      }),
    ).toEqual([messageArtifactSaid]);
    expect(
      evidenceArtifactReferences({
        kind: 'EffectCompleted',
        piSessionId: '9d28f884-ec25-4f1d-86fe-3a673e74ec38',
        modelTurnId: 'turn-1',
        toolCallId: 'call-1',
        proposalIndex: 0,
        tool: 'run_tests',
        requiredCapability: 'RunTests',
        resource: 'command:public-test',
        outputArtifactSaids: [outputArtifactSaid],
      }),
    ).toEqual([outputArtifactSaid]);
    expect(
      evidenceArtifactReferences({
        kind: 'ContextSummary',
        sourceEventSaids: ['E'.concat('h'.repeat(43))],
        summaryArtifactSaid,
      }),
    ).toEqual([summaryArtifactSaid]);
    expect(evidenceArtifactReferences({ kind: 'IncarnationStarted' })).toEqual([]);
  });

  it('records an exact checkpointed calibration disposition without an open payload', () => {
    const checkpointSaid = 'E'.concat('i'.repeat(43));
    const prepared = prepareEvidenceEvent({
      ...draft(),
      event: {
        kind: 'RunCalibrationRecorded',
        checkpointSaid,
        disposition: { kind: 'Excluded', reason: 'ProviderUnavailable' },
      },
    });

    expect(prepared).toMatchObject({
      kind: 'Prepared',
      event: {
        event: {
          kind: 'RunCalibrationRecorded',
          checkpointSaid,
          disposition: { kind: 'Excluded', reason: 'ProviderUnavailable' },
        },
      },
    });
  });
});
