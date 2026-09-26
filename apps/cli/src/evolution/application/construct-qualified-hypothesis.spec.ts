import {
  prepareEvaluationSourceInventory,
  prepareEvidenceEvent,
  prepareEvolutionHypothesis,
  preparePublicVerifierReceipt,
  prepareQualifiedFailureWindow,
  type EvidenceEvent,
  type EvidenceTimelinePage,
  type EvolutionHypothesis,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';

import type { QualifiedHypothesisConversations } from './construct-qualified-hypothesis.js';

import { constructQualifiedEvolutionHypothesis } from './construct-qualified-hypothesis.js';

describe('qualified H0 construction', () => {
  it('does not read or return a proposed H0 when six-Run qualification blocks', async () => {
    const inspect = vi.fn().mockResolvedValue({ kind: 'Blocked' });
    const retrieve = vi.fn();
    const outcome = await constructQualifiedEvolutionHypothesis(
      {
        qualification: { signal: new AbortController().signal } as never,
        hypothesis: {} as never,
        inventory: {} as never,
      },
      {
        qualification: { inspect },
        retrieval: { retrieve },
        reading: { read: vi.fn() },
        projection: { project: vi.fn() },
        choice: { recalculate: vi.fn() },
      },
    );
    expect(outcome).toEqual({ kind: 'Blocked', gate: 'Qualification' });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
  });

  function signedFixture() {
    const task = taskProjectionFixture();
    const run = runProjectionFixture();
    const said = (character: string): string => `E${character.repeat(43)}`;
    const receiptPreparation = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: 'public-test',
      commandSaid: said('m'),
      recordedAt: '2026-09-26T05:00:00.000Z',
      outcome: {
        kind: 'Rejected',
        reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
        elapsedMilliseconds: 10,
        outputArtifactSaids: [],
      },
    });
    if (receiptPreparation.kind !== 'Prepared') throw new Error('receipt fixture rejected');
    const receipt = receiptPreparation.receipt;
    function event(sequence: number, previous: string | undefined, detail: EvidenceEvent['event']) {
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous },
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        runId: run.runId,
        incarnationId: '33333333-3333-4333-8333-333333333333',
        harnessRevisionSaid: run.harnessRevisionSaid,
        personalAgentAid: run.personalAgentAid,
        taskMandateSaid: run.taskMandateSaid,
        occurredAt: '2026-09-26T05:00:00.000Z',
        recordedAt: '2026-09-26T05:00:00.000Z',
        producer: { kind: 'RunSupervisor' },
        event: detail,
      });
      if (prepared.kind !== 'Prepared') throw new Error('event fixture rejected');
      return prepared.event;
    }
    const first = event(0, undefined, { kind: 'RunStarted', fromRunVersion: 0 });
    const failure = event(1, first.d, {
      kind: 'FailureObserved',
      failure: 'HarnessCompatibilityFailure',
      receiptSaid: receipt.d,
    });
    const events = [first, failure];
    const page: EvidenceTimelinePage = {
      version: 1,
      stream: {
        version: 1,
        runId: run.runId,
        evidenceStreamId: run.evidenceStreamId,
        cursor: {
          kind: 'Accepted',
          eventCount: 2,
          acceptedThroughSequence: 1,
          chainHeadSaid: failure.d,
        },
        checkpoint: { kind: 'Accepted', checkpointSaid: said('c') },
        seal: {
          kind: 'Sealed',
          sealExchangeSaid: said('s'),
          eventCount: 2,
          finalSequence: 1,
          chainHeadSaid: failure.d,
          sealedAt: '2026-09-26T05:00:00.000Z',
        },
      },
      events: events.map((item) => ({
        version: 1,
        event: item,
        receivedAt: '2026-09-26T05:00:00.000Z',
      })),
      nextCursor: null,
    };
    const window = prepareQualifiedFailureWindow({
      version: 1,
      kind: 'QualifiedFailureWindow',
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      originRunId: run.runId,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      failureEventSaid: failure.d,
      verifierReceiptSaid: receipt.d,
      precedingEventSaids: [first.d],
    });
    if (window.kind !== 'Prepared') throw new Error('window fixture rejected');
    const inventory = prepareEvaluationSourceInventory({
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      ownerAid: task.ownerAid,
      repositoryResourceSaid: said('g'),
      corpusSaid: said('o'),
      experienceMandateSaid: said('e'),
      sources: [
        {
          episodeSaid: said('a'),
          rawEvidenceSaid: said('b'),
          ownerAid: task.ownerAid,
          repositoryResourceSaid: said('g'),
          corpusSaid: said('o'),
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error('inventory fixture rejected');
    const hypothesis = prepareEvolutionHypothesis({
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      originRunId: run.runId,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      parentRevisionSaid: run.harnessRevisionSaid,
      personalAgentAid: run.personalAgentAid,
      sourceInventorySaid: inventory.inventory.d,
      retrievalReceiptSaid: said('q'),
      failure: { eventSaid: failure.d, rawEvidenceSaid: receipt.d },
      source: { episodeSaid: said('a'), rawEvidenceSaid: said('b') },
      implicatedComponent: 'ContextSelection',
      predictedCorrection: 'Choose verified recovery.',
      publicReplay: {
        failureWindowSaid: window.artifact.d,
        configurationSaid: said('x'),
        nonTreatmentInputsSaid: said('n'),
        failureQuery: 'legacy parser mismatch',
        predictedAction: 'verify-and-repair',
        predictedSourceChoiceSaid: said('h'),
        assertion: 'Source changes the public recovery choice.',
      },
      falsifier: 'Choice unchanged without source.',
      regressionRisks: ['Extra cost.'],
      rejectedExplanations: ['Transient failure.'],
    });
    if (hypothesis.kind !== 'Prepared') throw new Error('hypothesis fixture rejected');
    const qualification = {
      task,
      originRunId: run.runId,
      executionProfileSaid: said('p'),
      expectedActiveRevisionSaid: run.harnessRevisionSaid,
      runs: { inspect: () => Promise.resolve({ kind: 'Found' as const, run }) },
      evidence: {
        inspect: () => Promise.resolve({ kind: 'Found' as const, page }),
        readVerifierReceipt: () =>
          Promise.resolve({ kind: 'Read' as const, checkpointSaid: said('c'), receipt }),
      },
      signal: new AbortController().signal,
    };
    const qualified = {
      kind: 'Qualified' as const,
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      originRunId: run.runId,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      expectedActiveRevisionSaid: run.harnessRevisionSaid,
      personalAgentAid: run.personalAgentAid,
      taskMandateSaid: run.taskMandateSaid,
      executionProfileSaid: said('p'),
    };
    const ports: QualifiedHypothesisConversations = {
      qualification: { inspect: () => Promise.resolve(qualified) },
      retrieval: {
        retrieve: () =>
          Promise.resolve({
            kind: 'Retrieved',
            sources: [{ episodeSaid: said('a'), rawEvidenceSaid: said('b'), score: 0.8 }],
            queryReceiptSaid: said('q'),
            chargedMicroUsd: 1,
          }),
      },
      reading: {
        read: () =>
          Promise.resolve({
            kind: 'Read',
            bytes: new TextEncoder().encode('raw'),
            totalBytes: 3,
            sourceSaid: said('a'),
            readReceiptSaid: said('d'),
          }),
      },
      projection: {
        project: () =>
          Promise.resolve({
            kind: 'Projected',
            episodeSaid: said('a'),
            rawEvidenceSaid: said('b'),
            readReceiptSaid: said('d'),
            observation: 'Legacy mismatch',
            recoveryHint: 'Verify current parser',
          }),
      },
      choice: {
        recalculate: ({ view }) =>
          Promise.resolve(
            view.sources.length > 0
              ? {
                  kind: 'Chosen',
                  action: 'verify-and-repair',
                  sourceChoiceSaid: said('h'),
                  citationSaids: [said('a')],
                }
              : {
                  kind: 'Chosen',
                  action: 'submit-now',
                  sourceChoiceSaid: said('u'),
                  citationSaids: [],
                },
          ),
      },
    };
    return {
      task,
      run,
      receipt,
      page,
      window,
      inventory: inventory.inventory,
      hypothesis: hypothesis.hypothesis,
      qualification,
      ports,
      said,
    };
  }

  function amendHypothesis(
    hypothesis: EvolutionHypothesis,
    changes: Partial<Omit<EvolutionHypothesis, 'version' | 'kind' | 'd'>>,
  ): EvolutionHypothesis {
    const claim = {
      taskId: hypothesis.taskId,
      taskRevisionSaid: hypothesis.taskRevisionSaid,
      originRunId: hypothesis.originRunId,
      retainedCheckpointSaid: hypothesis.retainedCheckpointSaid,
      retainedSealSaid: hypothesis.retainedSealSaid,
      parentRevisionSaid: hypothesis.parentRevisionSaid,
      personalAgentAid: hypothesis.personalAgentAid,
      sourceInventorySaid: hypothesis.sourceInventorySaid,
      retrievalReceiptSaid: hypothesis.retrievalReceiptSaid,
      failure: hypothesis.failure,
      source: hypothesis.source,
      implicatedComponent: hypothesis.implicatedComponent,
      predictedCorrection: hypothesis.predictedCorrection,
      publicReplay: hypothesis.publicReplay,
      falsifier: hypothesis.falsifier,
      regressionRisks: hypothesis.regressionRisks,
      rejectedExplanations: hypothesis.rejectedExplanations,
    };
    const prepared = prepareEvolutionHypothesis({ ...claim, ...changes });
    if (prepared.kind !== 'Prepared') throw new Error('amended hypothesis invalid');
    return prepared.hypothesis;
  }

  it('returns H0 only after Q, sealed prefix, receipt and changed public choice agree', async () => {
    const fixture = signedFixture();
    const outcome = await constructQualifiedEvolutionHypothesis(
      {
        qualification: fixture.qualification,
        hypothesis: fixture.hypothesis,
        inventory: fixture.inventory,
      },
      fixture.ports,
    );
    expect(outcome.kind).toBe('Constructed');
    if (outcome.kind !== 'Constructed') return;
    expect(outcome.window.artifact.d).toBe(fixture.window.artifact.d);
    expect(outcome.influence.review.withoutSource).toMatchObject({ action: 'submit-now' });
  });

  it('blocks a swapped window, receipt, source or query receipt before returning H0', async () => {
    const fixture = signedFixture();
    const wrongWindow = amendHypothesis(fixture.hypothesis, {
      publicReplay: { ...fixture.hypothesis.publicReplay, failureWindowSaid: fixture.said('z') },
    });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: wrongWindow,
          inventory: fixture.inventory,
        },
        fixture.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Window' });
    const wrongReceipt = amendHypothesis(fixture.hypothesis, {
      failure: { ...fixture.hypothesis.failure, rawEvidenceSaid: fixture.said('z') },
    });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: wrongReceipt,
          inventory: fixture.inventory,
        },
        fixture.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Influence' });
    const wrongSource = amendHypothesis(fixture.hypothesis, {
      source: { ...fixture.hypothesis.source, rawEvidenceSaid: fixture.said('z') },
    });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: wrongSource,
          inventory: fixture.inventory,
        },
        fixture.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Influence' });
    const wrongQueryReceipt = amendHypothesis(fixture.hypothesis, {
      retrievalReceiptSaid: fixture.said('z'),
    });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: wrongQueryReceipt,
          inventory: fixture.inventory,
        },
        fixture.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Influence' });
    const wrongHostedReceipt = signedFixture();
    wrongHostedReceipt.qualification.evidence.readVerifierReceipt = () =>
      Promise.resolve({
        kind: 'Read',
        checkpointSaid: wrongHostedReceipt.said('z'),
        receipt: wrongHostedReceipt.receipt,
      });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: wrongHostedReceipt.qualification,
          hypothesis: wrongHostedReceipt.hypothesis,
          inventory: wrongHostedReceipt.inventory,
        },
        wrongHostedReceipt.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Receipt' });
    const wrongPrefix = signedFixture();
    wrongPrefix.qualification.evidence.inspect = () =>
      Promise.resolve({
        kind: 'Found',
        page: { ...wrongPrefix.page, events: wrongPrefix.page.events.slice(1) },
      });
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: wrongPrefix.qualification,
          hypothesis: wrongPrefix.hypothesis,
          inventory: wrongPrefix.inventory,
        },
        wrongPrefix.ports,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Timeline' });
  });

  it('blocks an irrelevant source or citation-only replay', async () => {
    const fixture = signedFixture();
    const irrelevant: QualifiedHypothesisConversations = {
      ...fixture.ports,
      retrieval: { retrieve: () => Promise.resolve({ kind: 'Irrelevant' }) },
    };
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: fixture.hypothesis,
          inventory: fixture.inventory,
        },
        irrelevant,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Influence' });
    const citationOnly: QualifiedHypothesisConversations = {
      ...fixture.ports,
      choice: {
        recalculate: ({ view }) =>
          Promise.resolve({
            kind: 'Chosen',
            action: 'verify-and-repair',
            sourceChoiceSaid: fixture.said('h'),
            citationSaids: view.sources.length > 0 ? [fixture.said('a')] : [],
          }),
      },
    };
    expect(
      await constructQualifiedEvolutionHypothesis(
        {
          qualification: fixture.qualification,
          hypothesis: fixture.hypothesis,
          inventory: fixture.inventory,
        },
        citationOnly,
      ),
    ).toEqual({ kind: 'Blocked', gate: 'Influence' });
  });
});
