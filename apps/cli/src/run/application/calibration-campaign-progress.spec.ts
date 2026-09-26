import { governorAid, personalAgentAid } from '@devrandom/identity';
import {
  prepareEvidenceEvent,
  prepareRunSuccessorSegment,
  type RunSuccessorSegment,
  type EvidenceEvent,
  type EvidenceTimelinePage,
  type RunProjection,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { StableBaselineRunAdmission } from './baseline-run-admission.js';
import type { PreparedCompatibilityCalibrationEntry } from './prepared-compatibility-calibration.js';
import { VerifiedCalibrationCampaignProgress } from './calibration-campaign-progress.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const task = taskProjectionFixture();
const campaignId = id('9');
const base = {
  ...runProjectionFixture(),
  personalAgentAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
};
const category = {
  version: 1 as const,
  taskId: task.taskId,
  taskRevisionSaid: task.revisionSaid,
  harnessRevisionSaid: base.harnessRevisionSaid,
  currentCommandSaid: said('d'),
  tamperCommandSaid: said('e'),
  legacyCommandSaid: said('f'),
  legacyObservedExitCode: 101 as const,
};

function fixture(count = 1, classification: 'Confirmed' | 'Excluded' | 'Rejected' = 'Confirmed') {
  const runs: RunProjection[] = [];
  const admissions: StableBaselineRunAdmission[] = [];
  const entries: PreparedCompatibilityCalibrationEntry[] = [];
  const pages: EvidenceTimelinePage[] = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = (index + 1) as 1 | 2 | 3 | 4 | 5;
    const purpose = { kind: 'PreparedCompatibilityCalibration' as const, campaignId, ordinal };
    const incarnationId = id(String(index + 1));
    const run: RunProjection = {
      ...base,
      runId: id(String(index + 1)),
      evidenceStreamId: id(String(index + 1)),
      purpose,
      activation: { ...base.activation, runId: id('1') },
      lease: {
        kind: 'Held',
        incarnationId,
        acquiredAt: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:01:00.000Z',
        lastChange: { kind: 'Acquired', fromRunVersion: 0 },
      },
      lifecycle: {
        kind: 'Ended',
        outcome:
          classification === 'Confirmed'
            ? { kind: 'CalibrationConfirmed', category, checkpointSaid: said('c') }
            : classification === 'Excluded'
              ? {
                  kind: 'CalibrationExcluded',
                  reason: 'BudgetExhausted',
                  checkpointSaid: said('c'),
                }
              : { kind: 'CalibrationRejected', reason: 'H1Passed', checkpointSaid: said('c') },
      },
      submissionVerification: {
        kind:
          classification === 'Confirmed'
            ? 'Rejected'
            : classification === 'Rejected'
              ? 'Accepted'
              : 'NotSubmitted',
      },
      runVersion: 2,
    };
    runs.push(run);
    admissions.push({
      version: 1,
      kind: 'LeaseAccepted',
      commandId: run.commandId,
      incarnationId,
      preparedAt: 1,
      exchangeSaid: run.admissionExchangeSaid,
      runAdmission: 'Created',
      run: {
        ...run,
        lease: { kind: 'Unassigned' },
        lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
        submissionVerification: { kind: 'NotSubmitted' },
        runVersion: 0,
      },
      lease: {
        version: 1,
        disposition: 'Acquired',
        runId: run.runId,
        incarnationId,
        runVersion: 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:01:00.000Z',
      },
      binding: {
        ownerAid: task.ownerAid,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        harnessLineageId: task.harnessLineageId,
        harnessRevisionSaid: base.harnessRevisionSaid,
        personalAgentAid: personalAgentAid(base.personalAgentAid),
        taskMandateSaid: base.taskMandateSaid,
        governorAid: governorAid(base.governorAid),
        promotionMandateSaid: base.promotionMandateSaid,
        purpose,
        repository: task.revision.repository,
      },
    });
    const events: EvidenceEvent[] = [];
    for (const detail of [
      { kind: 'RunStarted' as const, fromRunVersion: 1 },
      {
        kind: 'RunCalibrationRecorded' as const,
        checkpointSaid: said('c'),
        disposition:
          classification === 'Confirmed'
            ? { kind: 'Confirmed' as const, category }
            : classification === 'Excluded'
              ? { kind: 'Excluded' as const, reason: 'BudgetExhausted' as const }
              : { kind: 'Rejected' as const, reason: 'H1Passed' as const },
      },
      { kind: 'CheckpointAccepted' as const, checkpointSaid: said('c') },
    ]) {
      const previous = events.at(-1);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence: events.length,
        predecessor:
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
        taskId: run.taskId,
        taskRevisionSaid: run.taskRevisionSaid,
        runId: run.runId,
        incarnationId,
        harnessRevisionSaid: run.harnessRevisionSaid,
        personalAgentAid: run.personalAgentAid,
        taskMandateSaid: run.taskMandateSaid,
        occurredAt: '2026-09-24T20:00:20.000Z',
        recordedAt: '2026-09-24T20:00:20.000Z',
        producer:
          detail.kind === 'CheckpointAccepted'
            ? { kind: 'EvidenceRecorder' }
            : { kind: 'RunSupervisor' },
        event: detail,
      });
      if (prepared.kind !== 'Prepared') throw new Error('invalid event fixture');
      events.push(prepared.event);
    }
    const head = events.at(-1)?.d ?? '';
    pages.push({
      version: 1,
      stream: {
        version: 1,
        runId: run.runId,
        evidenceStreamId: run.evidenceStreamId,
        cursor: {
          kind: 'Accepted',
          acceptedThroughSequence: 2,
          chainHeadSaid: head,
          eventCount: 3,
        },
        checkpoint: { kind: 'Accepted', checkpointSaid: said('c') },
        seal: {
          kind: 'Sealed',
          sealExchangeSaid: said('s'),
          finalSequence: 2,
          sealedAt: '2026-09-24T20:01:00.000Z',
          chainHeadSaid: head,
          eventCount: 3,
        },
      },
      events: events.map((event) => ({ version: 1, event, receivedAt: event.recordedAt })),
      nextCursor: null,
    });
    entries.push(
      classification === 'Confirmed'
        ? {
            kind: 'Counted',
            runId: run.runId,
            category,
            modelMessageEventSaid: said('m'),
            toolProposalEventSaid: said('p'),
            toolEffectEventSaid: said('t'),
            verifierReceiptSaids: [said('v')],
          }
        : classification === 'Excluded'
          ? { kind: 'Excluded', runId: run.runId, reason: 'BudgetExhausted' }
          : { kind: 'Rejected', runId: run.runId, reason: 'H1Passed' },
    );
  }
  const inspectRuns = vi.fn((runId: string) => {
    const run = runs.find((run) => run.runId === runId);
    return Promise.resolve(
      run === undefined ? { kind: 'ServerUnavailable' as const } : { kind: 'Found' as const, run },
    );
  });
  const segments = new Map<string, RunSuccessorSegment>();
  const historical = new Map<string, EvidenceTimelinePage>();
  const progress = new VerifiedCalibrationCampaignProgress({
    authority: {
      acquireHostedWork: () =>
        Promise.resolve({
          kind: 'Authorized',
          tasks: { inspect: () => Promise.resolve({ kind: 'Inspected', task }) },
          runs: {
            inspect: inspectRuns,
            readSuccessorSegment: (_runId, segmentSaid) => {
              const segment = segments.get(segmentSaid);
              return Promise.resolve(
                segment === undefined ? { kind: 'ResponseInvalid' } : { kind: 'Found', segment },
              );
            },
          },
          evidence: {
            inspect: (runId, query) =>
              Promise.resolve({
                kind: 'Found',
                page:
                  historical.get(query.evidenceStreamId ?? '') ??
                  required(pages[runs.findIndex((run) => run.runId === runId)]),
              }),
          },
          grantExpiresAt: '2026-09-24T22:00:00.000Z',
        }),
    },
    admissions: { inspectTaskAdmissions: () => Promise.resolve({ kind: 'Found', admissions }) },
    records: {
      read: () =>
        Promise.resolve(
          count === 0
            ? { kind: 'NotFound' }
            : {
                kind: 'Loaded',
                record: {
                  version: 1,
                  binding:
                    classification === 'Confirmed'
                      ? { kind: 'Bound', category }
                      : { kind: 'AwaitingConfirmedCategory' },
                  attempts: entries,
                },
              },
        ),
    },
    now: () => Date.parse('2026-09-24T21:00:00.000Z'),
  });
  return { runs, admissions, entries, pages, progress, inspectRuns, segments, historical };
}

describe('verified partial calibration campaign', () => {
  it('preserves an honestly excluded first calibration without counting it as a failure', async () => {
    const f = fixture(1, 'Excluded');
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toMatchObject({
      kind: 'Ready',
      nextOrdinal: 2,
      confirmed: 0,
      excluded: 1,
    });
  });
  it('keeps a rejected sealed campaign closed across repeated fresh inspections', async () => {
    const f = fixture(1, 'Rejected');
    for (let retry = 0; retry < 2; retry += 1) {
      await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
        kind: 'Rejected',
        runId: id('1'),
        ordinal: 1,
        reason: 'H1Passed',
      });
    }
  });
  it('does not admit another retained Run when its stable admission already exists', async () => {
    const f = fixture(5);
    const previous = required(f.admissions[4]);
    if (previous.kind !== 'LeaseAccepted') throw new Error('expected leased fixture');
    const retained: RunProjection = {
      ...required(f.runs[4]),
      runId: id('6'),
      purpose: { kind: 'Retained' },
      lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
      submissionVerification: { kind: 'NotSubmitted' },
    };
    f.runs.push(retained);
    f.admissions.push({
      ...previous,
      run: retained,
      binding: { ...previous.binding, purpose: { kind: 'Retained' } },
    });
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
      kind: 'RetainedRunExists',
      runId: id('6'),
    });
  });
  it('continues stable unfinished admission preparation only for the next ordinal', async () => {
    const f = fixture();
    const previous = required(f.admissions[0]);
    f.admissions.push({
      version: 1,
      kind: 'PreparingExchange',
      commandId: id('8'),
      incarnationId: id('8'),
      preparedAt: 1,
      binding: {
        ...previous.binding,
        purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal: 2 },
      },
    });
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toMatchObject({
      kind: 'Ready',
      nextOrdinal: 2,
      confirmed: 1,
      excluded: 0,
    });
  });

  it('starts a campaign only when no prior admission or local completion exists', async () => {
    const f = fixture(0);
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
      kind: 'Ready',
      nextOrdinal: 1,
      confirmed: 0,
      excluded: 0,
    });
  });
  it('counts a completed ordinal from its exact sealed hosted chain', async () => {
    const f = fixture();
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toMatchObject({
      kind: 'Ready',
      nextOrdinal: 2,
      confirmed: 1,
      excluded: 0,
    });
  });
  it('returns the original unresolved Run before admitting another ordinal', async () => {
    const f = fixture();
    f.runs[0] = {
      ...required(f.runs[0]),
      lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
      submissionVerification: { kind: 'NotSubmitted' },
    };
    f.entries.splice(0);
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
      kind: 'RecoveryRequired',
      runId: id('1'),
      ordinal: 1,
    });
  });
  it('does not trust a local completed entry when the hosted seal is absent', async () => {
    const f = fixture();
    f.pages[0] = {
      ...required(f.pages[0]),
      stream: { ...required(f.pages[0]).stream, seal: { kind: 'Unsealed' } },
    };
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
      kind: 'RecoveryRequired',
      runId: id('1'),
      ordinal: 1,
    });
  });
  it.each(['campaign', 'task', 'mandate', 'harness', 'chain', 'category', 'ordinal'] as const)(
    'rejects mismatched %s facts without advancing',
    async (mismatch) => {
      const f = fixture(2);
      const run = required(f.runs[1]);
      if (mismatch === 'campaign')
        f.runs[1] = {
          ...run,
          purpose: { kind: 'PreparedCompatibilityCalibration', campaignId: id('8'), ordinal: 2 },
        };
      if (mismatch === 'task') f.runs[1] = { ...run, taskRevisionSaid: said('z') };
      if (mismatch === 'mandate') f.runs[1] = { ...run, taskMandateSaid: said('z') };
      if (mismatch === 'harness') f.runs[1] = { ...run, harnessRevisionSaid: said('z') };
      if (mismatch === 'chain')
        f.pages[1] = { ...required(f.pages[1]), events: required(f.pages[1]).events.slice(1) };
      if (mismatch === 'category')
        f.entries[1] = {
          ...(f.entries[1] as Extract<PreparedCompatibilityCalibrationEntry, { kind: 'Counted' }>),
          category: { ...category, legacyCommandSaid: said('z') },
        };
      if (mismatch === 'ordinal') f.admissions.splice(0, 1);
      await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
        kind: 'Unavailable',
      });
    },
  );
  it('requires local settlement recovery when hosted seal committed before local index', async () => {
    const f = fixture();
    f.entries.splice(0);
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({
      kind: 'RecoveryRequired',
      runId: id('1'),
      ordinal: 1,
    });
  });
  it('permits the retained slot only after all five verified attempts', async () => {
    const f = fixture(5);
    await expect(f.progress.inspect('receipt', campaignId)).resolves.toMatchObject({
      kind: 'Ready',
      nextOrdinal: 6,
      confirmed: 5,
      excluded: 0,
    });
  });
});

it('counts one sealed same-H1 continuation only after verifying its original accepted chain', async () => {
  const f = fixture();
  const original = required(f.runs[0]);
  const finalPage = required(f.pages[0]);
  if (original.lease.kind !== 'Held') throw new Error('lease');
  const predecessorEvents: EvidenceEvent[] = [];
  for (const detail of [
    { kind: 'RunStarted', fromRunVersion: 0 },
    { kind: 'RunBlocked', reason: 'ContextLimitReached', checkpointSaid: said('q') },
    { kind: 'CheckpointAccepted', checkpointSaid: said('q') },
  ] as const) {
    const seed = required(finalPage.events[0]).event;
    const { d: oldSaid, ...body } = seed;
    expect(oldSaid).toBeTruthy();
    const event = prepareEvidenceEvent({
      ...body,
      sequence: predecessorEvents.length,
      predecessor:
        predecessorEvents.length === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: required(predecessorEvents.at(-1)).d },
      producer:
        detail.kind === 'CheckpointAccepted'
          ? { kind: 'EvidenceRecorder' }
          : { kind: 'RunSupervisor' },
      event: detail,
    });
    if (event.kind !== 'Prepared') throw new Error('event');
    predecessorEvents.push(event.event);
  }
  const head = required(predecessorEvents.at(-1)).d;
  const predecessorPage: EvidenceTimelinePage = {
    ...finalPage,
    stream: {
      ...finalPage.stream,
      cursor: { kind: 'Accepted', acceptedThroughSequence: 2, eventCount: 3, chainHeadSaid: head },
      checkpoint: { kind: 'Accepted', checkpointSaid: said('q') },
      seal: {
        kind: 'Sealed',
        sealExchangeSaid: said('s'),
        finalSequence: 2,
        eventCount: 3,
        chainHeadSaid: head,
        sealedAt: '2026-09-24T20:01:00.000Z',
      },
    },
    events: predecessorEvents.map((event) => ({ version: 1, event, receivedAt: event.recordedAt })),
  };
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    runId: original.runId,
    taskId: original.taskId,
    taskRevisionSaid: original.taskRevisionSaid,
    ownerAid: original.ownerAid,
    personalAgentAid: original.personalAgentAid,
    taskMandateSaid: original.taskMandateSaid,
    fromRunVersion: 2,
    predecessor: {
      incarnationId: original.lease.incarnationId,
      evidenceStreamId: original.evidenceStreamId,
      checkpointSaid: said('q'),
      sealExchangeSaid: said('s'),
      finalSequence: 2,
      chainHeadSaid: head,
    },
    successor: {
      incarnationId: id('8'),
      evidenceStreamId: id('7'),
      harnessRevisionSaid: original.harnessRevisionSaid,
    },
    baseline: { pointerVersion: 1, harnessRevisionSaid: original.harnessRevisionSaid },
    consumedBudget: original.budget.consumed,
    admittedAt: '2026-09-24T20:02:00.000Z',
  });
  if (prepared.kind !== 'Prepared') throw new Error('segment');
  const events: EvidenceEvent[] = [];
  for (const { event } of finalPage.events) {
    const { d: oldSaid, ...body } = event;
    expect(oldSaid).toBeTruthy();
    const next = prepareEvidenceEvent({
      ...body,
      incarnationId: id('8'),
      predecessor:
        events.length === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: required(events.at(-1)).d },
    });
    if (next.kind !== 'Prepared') throw new Error('event');
    events.push(next.event);
  }
  const finalHead = required(events.at(-1)).d;
  if (finalPage.stream.cursor.kind !== 'Accepted' || finalPage.stream.seal.kind !== 'Sealed')
    throw new Error('stream');
  f.pages[0] = {
    ...finalPage,
    stream: {
      ...finalPage.stream,
      evidenceStreamId: id('7'),
      cursor: { ...finalPage.stream.cursor, chainHeadSaid: finalHead },
      seal: { ...finalPage.stream.seal, chainHeadSaid: finalHead },
    },
    events: events.map((event) => ({ version: 1, event, receivedAt: event.recordedAt })),
  };
  f.runs[0] = {
    ...original,
    runVersion: 4,
    currentExecution: {
      segmentSaid: prepared.segment.d,
      evidenceStreamId: id('7'),
      harnessRevisionSaid: original.harnessRevisionSaid,
    },
    lease: { ...original.lease, incarnationId: id('8'), segmentSaid: prepared.segment.d },
  };
  f.segments.set(prepared.segment.d, prepared.segment);
  f.historical.set(original.evidenceStreamId, predecessorPage);
  await expect(f.progress.inspect('receipt', campaignId)).resolves.toMatchObject({
    kind: 'Ready',
    nextOrdinal: 2,
    confirmed: 1,
  });
  const { d: segmentSaid, ...segmentBody } = prepared.segment;
  const second = prepareRunSuccessorSegment({
    ...segmentBody,
    predecessor: { ...segmentBody.predecessor, evidenceStreamId: id('6') },
  });
  if (second.kind !== 'Prepared') throw new Error('second segment');
  const continued = required(f.runs[0]);
  if (continued.lease.kind !== 'Held' || continued.currentExecution === undefined)
    throw new Error('continued');
  f.segments.set(second.segment.d, second.segment);
  f.runs[0] = {
    ...continued,
    currentExecution: { ...continued.currentExecution, segmentSaid: second.segment.d },
    lease: { ...continued.lease, segmentSaid: second.segment.d },
  };
  await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({ kind: 'Unavailable' });
  expect(segmentSaid).toBe(prepared.segment.d);
  f.runs[0] = continued;
  f.historical.set(original.evidenceStreamId, {
    ...predecessorPage,
    events: predecessorPage.events.slice(1),
  });
  await expect(f.progress.inspect('receipt', campaignId)).resolves.toEqual({ kind: 'Unavailable' });
});
