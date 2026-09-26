import {
  prepareEvaluationSourceInventory,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  prepareQualifiedFailureWindow,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

const inspected = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted(() => vi.fn());
vi.mock('./construct-qualified-hypothesis.js', () => ({
  inspectQualifiedFailure: inspected,
  constructQualifiedEvolutionHypothesis: constructed,
}));

import { proposeQualifiedDiagnosis } from './propose-qualified-diagnosis.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const taskId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const bytes = new TextEncoder().encode(
    'public verifier: CESR legacy receipt parser rejected exit 101',
  );
  const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  const receipt = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'cesr-legacy',
    commandSaid: said('m'),
    recordedAt: '2026-09-26T05:00:00.000Z',
    outcome: {
      kind: 'Rejected',
      reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
      elapsedMilliseconds: 4,
      outputArtifactSaids: [],
    },
  });
  if (artifact.kind !== 'Prepared' || receipt.kind !== 'Prepared')
    throw new Error('Fixture invalid');
  const sourceRunId = '33333333-3333-4333-8333-333333333333';
  const sourceEvent = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId,
    taskRevisionSaid: said('t'),
    runId: sourceRunId,
    incarnationId: '44444444-4444-4444-8444-444444444444',
    harnessRevisionSaid: said('h'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    occurredAt: '2026-09-26T05:00:00.000Z',
    recordedAt: '2026-09-26T05:00:00.000Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'Observation', source: 'Verifier', artifactSaid: artifact.artifact.d },
  });
  if (sourceEvent.kind !== 'Prepared') throw new Error('Source event fixture invalid');
  const failureEvent = prepareEvidenceEvent({
    version: 1,
    sequence: 1,
    predecessor: { kind: 'Previous', eventSaid: sourceEvent.event.d },
    taskId,
    taskRevisionSaid: said('t'),
    runId: sourceRunId,
    incarnationId: '44444444-4444-4444-8444-444444444444',
    harnessRevisionSaid: said('h'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    occurredAt: '2026-09-26T05:00:00.000Z',
    recordedAt: '2026-09-26T05:00:00.000Z',
    producer: { kind: 'RunSupervisor' },
    event: {
      kind: 'FailureObserved',
      failure: 'HarnessCompatibilityFailure',
      receiptSaid: receipt.receipt.d,
    },
  });
  if (failureEvent.kind !== 'Prepared') throw new Error('Failure event fixture invalid');
  const inventory = prepareEvaluationSourceInventory({
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    repositoryResourceSaid: said('r'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('e'),
    sources: [
      {
        episodeSaid: sourceEvent.event.d,
        rawEvidenceSaid: artifact.artifact.d,
        ownerAid: said('o'),
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  if (inventory.kind !== 'Prepared') throw new Error('Inventory fixture invalid');
  const window = prepareQualifiedFailureWindow({
    version: 1,
    kind: 'QualifiedFailureWindow',
    taskId,
    taskRevisionSaid: said('t'),
    originRunId: runId,
    retainedCheckpointSaid: said('k'),
    retainedSealSaid: said('z'),
    failureEventSaid: said('f'),
    verifierReceiptSaid: receipt.receipt.d,
    precedingEventSaids: [said('p')],
  });
  if (window.kind !== 'Prepared') throw new Error('Window fixture invalid');
  const qualification = {
    task: {
      taskId,
      ownerAid: said('o'),
      revisionSaid: said('t'),
      revision: {
        version: 2,
        constraints: {
          experience: { repositoryResourceSaid: said('r'), corpusSaid: said('c') },
        },
      },
    },
    signal: new AbortController().signal,
    evidence: {
      inspect: vi.fn().mockResolvedValue({
        kind: 'Found',
        page: {
          stream: { runId: sourceRunId, seal: { kind: 'Sealed' } },
          events: [{ event: sourceEvent.event }, { event: failureEvent.event }],
          nextCursor: null,
        },
      }),
    },
  };
  const snapshot = {
    kind: 'Inspected',
    qualified: {
      taskId,
      taskRevisionSaid: said('t'),
      originRunId: runId,
      retainedCheckpointSaid: said('k'),
      retainedSealSaid: said('z'),
      expectedActiveRevisionSaid: said('h'),
      personalAgentAid: said('a'),
    },
    failureEventSaid: said('f'),
    receipt: receipt.receipt,
    window,
  };
  const ports = {
    qualification: { inspect: vi.fn() },
    reviews: { read: vi.fn() },
    history: {
      read: vi.fn().mockResolvedValue({
        kind: 'Found',
        runIds: [
          sourceRunId,
          '55555555-5555-4555-8555-555555555555',
          '66666666-6666-4666-8666-666666666666',
          '77777777-7777-4777-8777-777777777777',
          '88888888-8888-4888-8888-888888888888',
        ],
      }),
    },
    retrieval: {
      retrieve: vi.fn().mockResolvedValue({
        kind: 'Retrieved',
        sources: [
          { episodeSaid: sourceEvent.event.d, rawEvidenceSaid: artifact.artifact.d, score: 0.9 },
        ],
        queryReceiptSaid: said('q'),
        chargedMicroUsd: 0,
      }),
    },
    reading: {
      read: vi.fn().mockResolvedValue({
        kind: 'Read',
        bytes,
        totalBytes: bytes.byteLength,
        sourceSaid: sourceEvent.event.d,
        readReceiptSaid: said('d'),
      }),
    },
  };
  const reviews = [
    {
      version: 1 as const,
      kind: 'ReviewedPublicAnalogy' as const,
      episodeSaid: sourceEvent.event.d,
      runId: sourceRunId,
      rawEvidenceSaid: artifact.artifact.d,
      observation: 'CESR legacy receipt parser rejected exit 101',
      recoveryAction: 'verify-current-framing',
      predictedCorrection: 'Check current receipt framing under the original public verifier.',
      implicatedComponent: 'Workflow' as const,
      regressionRisks: ['An unrelated receipt format may still fail.'],
    },
  ];
  const reviewArtifact = prepareEvidenceArtifact(
    new TextEncoder().encode(JSON.stringify(reviews[0])),
    'application/json',
  );
  if (reviewArtifact.kind !== 'Prepared') throw new Error('Review artifact fixture invalid');
  ports.reviews.read.mockResolvedValue({
    kind: 'Read',
    artifact: reviewArtifact.artifact,
    review: reviews[0],
  });
  return {
    qualification,
    inventory: inventory.inventory,
    reviews,
    reviewArtifactSaid: reviewArtifact.artifact.d,
    snapshot,
    ports,
  };
}

describe('qualified H0 diagnostic proposal', () => {
  it('never queries experience when Q is blocked', async () => {
    const test = fixture();
    inspected.mockResolvedValueOnce({ kind: 'Blocked', gate: 'Qualification' });
    expect(
      await proposeQualifiedDiagnosis(
        {
          qualification: test.qualification as never,
          inventory: test.inventory,
          reviewArtifactSaids: [test.reviewArtifactSaid],
          configurationSaid: said('g'),
          nonTreatmentInputsSaid: said('n'),
        },
        test.ports as never,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Qualification' });
    expect(test.ports.retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('derives the falsifiable H0 claim from current exact raw source and one Atlas receipt', async () => {
    const test = fixture();
    inspected.mockResolvedValueOnce(test.snapshot);
    constructed.mockImplementationOnce((input: { hypothesis: unknown }) =>
      Promise.resolve({
        kind: 'Constructed',
        hypothesis: input.hypothesis,
        window: test.snapshot.window,
        influence: { kind: 'Influenced' },
      }),
    );
    const result = await proposeQualifiedDiagnosis(
      {
        qualification: test.qualification as never,
        inventory: test.inventory,
        reviewArtifactSaids: [test.reviewArtifactSaid],
        configurationSaid: said('g'),
        nonTreatmentInputsSaid: said('n'),
      },
      test.ports,
    );
    expect(result).toMatchObject({
      kind: 'Proposed',
      selectedReviewArtifactSaid: test.reviewArtifactSaid,
      construction: {
        hypothesis: {
          retrievalReceiptSaid: said('q'),
          source: { episodeSaid: test.reviews[0]?.episodeSaid },
          implicatedComponent: 'Workflow',
          predictedCorrection: 'Check current receipt framing under the original public verifier.',
          publicReplay: { predictedAction: 'verify-current-framing' },
        },
      },
    });
    expect(test.ports.retrieval.retrieve).toHaveBeenCalledTimes(1);
    expect(test.ports.reading.read).toHaveBeenCalledTimes(1);
  });

  it('blocks missing raw custody before forming H0', async () => {
    const test = fixture();
    inspected.mockResolvedValueOnce(test.snapshot);
    test.ports.reading.read.mockResolvedValueOnce({ kind: 'NotFound' });
    expect(
      await proposeQualifiedDiagnosis(
        {
          qualification: test.qualification as never,
          inventory: test.inventory,
          reviewArtifactSaids: [test.reviewArtifactSaid],
          configurationSaid: said('g'),
          nonTreatmentInputsSaid: said('n'),
        },
        test.ports as never,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'RawSource' });
    expect(constructed).not.toHaveBeenCalled();
  });

  it('blocks a substituted source event even when Atlas and raw bytes otherwise agree', async () => {
    const test = fixture();
    inspected.mockResolvedValueOnce(test.snapshot);
    test.qualification.evidence.inspect.mockResolvedValueOnce({
      kind: 'Found',
      page: {
        stream: { runId: test.reviews[0]?.runId, seal: { kind: 'Sealed' } },
        events: [],
        nextCursor: null,
      },
    });
    expect(
      await proposeQualifiedDiagnosis(
        {
          qualification: test.qualification as never,
          inventory: test.inventory,
          reviewArtifactSaids: [test.reviewArtifactSaid],
          configurationSaid: said('g'),
          nonTreatmentInputsSaid: said('n'),
        },
        test.ports as never,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'SourceProvenance' });
  });

  it('blocks missing review custody and post-review source drift', async () => {
    const missing = fixture();
    inspected.mockResolvedValueOnce(missing.snapshot);
    missing.ports.reviews.read.mockResolvedValueOnce({ kind: 'NotFound' });
    expect(
      await proposeQualifiedDiagnosis(
        {
          qualification: missing.qualification as never,
          inventory: missing.inventory,
          reviewArtifactSaids: [missing.reviewArtifactSaid],
          configurationSaid: said('g'),
          nonTreatmentInputsSaid: said('n'),
        },
        missing.ports as never,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'ReviewCustody' });
    const drifted = fixture();
    inspected.mockResolvedValueOnce(drifted.snapshot);
    drifted.ports.reading.read.mockResolvedValueOnce({
      kind: 'Read',
      bytes: new TextEncoder().encode('substituted verifier output'),
      totalBytes: 27,
      sourceSaid: drifted.reviews[0]?.episodeSaid,
      readReceiptSaid: said('d'),
    });
    expect(
      await proposeQualifiedDiagnosis(
        {
          qualification: drifted.qualification as never,
          inventory: drifted.inventory,
          reviewArtifactSaids: [drifted.reviewArtifactSaid],
          configurationSaid: said('g'),
          nonTreatmentInputsSaid: said('n'),
        },
        drifted.ports as never,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Projection' });
  });
});
