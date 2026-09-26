import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationSourceInventory } from '@devrandom/protocol';

import type { EvidenceReading, ExperienceRetrieval } from './experience-conversations.js';
import { reviewAnalogyInfluence, type ReviewedChoiceRecalculation } from './verified-context.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const taskId = '123e4567-e89b-42d3-a456-426614174000';
const ownerAid = said('o');
const episodeSaid = said('e');
const rawEvidenceSaid = said('r');
const inventoryPreparation = prepareEvaluationSourceInventory({
  taskId,
  taskRevisionSaid: said('t'),
  ownerAid,
  repositoryResourceSaid: said('g'),
  corpusSaid: said('c'),
  experienceMandateSaid: said('m'),
  sources: [
    {
      episodeSaid,
      rawEvidenceSaid,
      ownerAid,
      repositoryResourceSaid: said('g'),
      corpusSaid: said('c'),
      disclosure: 'AuthorizedAnalogy',
    },
  ],
});
if (inventoryPreparation.kind !== 'Prepared') throw new Error('fixture inventory');
const inventory = inventoryPreparation.inventory;
const bytes = new TextEncoder().encode(
  '{"observation":"version mismatch","recovery":"verify legacy format"}',
);
const fixedInput = {
  publicFailureWindowSaid: said('f'),
  configurationSaid: said('a'),
  nonTreatmentInputsSaid: said('n'),
  reviewedAction: 'compatibility-recovery',
  reviewedSourceChoiceSaid: episodeSaid,
  failureQuery: 'legacy format mismatch',
  targetEpisodeSaid: episodeSaid,
};

function dependencies() {
  const retrieveSpy = vi.fn<ExperienceRetrieval['retrieve']>().mockResolvedValue({
    kind: 'Retrieved',
    sources: [{ episodeSaid, rawEvidenceSaid, score: 0.9 }],
    queryReceiptSaid: said('q'),
    chargedMicroUsd: 1,
  });
  const retrieval: ExperienceRetrieval = {
    retrieve: retrieveSpy,
  };
  const readSpy = vi.fn<EvidenceReading['read']>().mockResolvedValue({
    kind: 'Read',
    bytes,
    totalBytes: bytes.length,
    sourceSaid: episodeSaid,
    readReceiptSaid: said('b'),
  });
  const reading: EvidenceReading = {
    read: readSpy,
  };
  const projection = {
    project: vi.fn().mockResolvedValue({
      kind: 'Projected',
      episodeSaid,
      rawEvidenceSaid,
      readReceiptSaid: said('b'),
      observation: 'version mismatch',
      recoveryHint: 'verify legacy format',
    }),
  };
  const choiceSpy = vi
    .fn<ReviewedChoiceRecalculation['recalculate']>()
    .mockImplementation(({ view }) =>
      Promise.resolve(
        view.sources.length > 0
          ? {
              kind: 'Chosen' as const,
              action: 'compatibility-recovery',
              sourceChoiceSaid: episodeSaid,
              citationSaids: [episodeSaid],
            }
          : {
              kind: 'Chosen' as const,
              action: 'submit-now',
              sourceChoiceSaid: said('x'),
              citationSaids: [],
            },
      ),
    );
  const choice: ReviewedChoiceRecalculation = { recalculate: choiceSpy };
  return { retrieval, reading, projection, choice, retrieveSpy, readSpy, choiceSpy };
}

describe('verified Context application', () => {
  it('recomputes the same fixed public choice with and without an exact authorized raw source', async () => {
    const ports = dependencies();
    const outcome = await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports);
    expect(outcome.kind).toBe('Influenced');
    if (outcome.kind !== 'Influenced') return;
    expect(outcome.source.episodeSaid).toBe(episodeSaid);
    expect(outcome.source.readReceiptSaid).toBe(said('b'));
    expect(outcome.queryReceiptSaid).toBe(said('q'));
    expect(outcome.fixed).toEqual({
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: inventory.d,
      corpusSaid: said('c'),
      publicFailureWindowSaid: said('f'),
      configurationSaid: said('a'),
      nonTreatmentInputsSaid: said('n'),
      failureQuery: 'legacy format mismatch',
    });
    expect(outcome.withSourceView).toHaveLength(1);
    expect(outcome.withoutSourceView).toHaveLength(0);
    expect(ports.readSpy).toHaveBeenCalledWith({
      taskId,
      sourceInventorySaid: inventory.d,
      evidenceSaid: rawEvidenceSaid,
      offset: 0,
      maximumBytes: 32_768,
    });
    expect(ports.choiceSpy).toHaveBeenCalledTimes(2);
    const withSource = ports.choiceSpy.mock.calls[0]?.[0];
    const withoutSource = ports.choiceSpy.mock.calls[1]?.[0];
    expect(withSource?.fixed).toEqual(withoutSource?.fixed);
    expect(withSource?.view.sources).toHaveLength(1);
    expect(withoutSource?.view.sources).toHaveLength(0);
  });

  it('rejects a citation-only change as no influence', async () => {
    const ports = dependencies();
    ports.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: readonly unknown[] } }) =>
        Promise.resolve({
          kind: 'Chosen',
          action: 'compatibility-recovery',
          sourceChoiceSaid: said('s'),
          citationSaids: view.sources.length ? [episodeSaid] : [],
        }),
      );
    expect(
      await reviewAnalogyInfluence(
        { inventory, ...fixedInput, reviewedSourceChoiceSaid: said('s') },
        ports,
      ),
    ).toMatchObject({
      kind: 'NotInfluenced',
      reason: 'ChoiceUnchanged',
    });
  });

  it.each(['Denied', 'Unavailable', 'IndexNotReady', 'Irrelevant'] as const)(
    'blocks %s retrieval before any choice',
    async (kind) => {
      const ports = dependencies();
      ports.retrieval.retrieve = vi.fn().mockResolvedValue({ kind });
      expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
        'Blocked',
      );
      expect(ports.choiceSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects a retrieved source outside the signed inventory', async () => {
    const ports = dependencies();
    ports.retrieval.retrieve = vi.fn().mockResolvedValue({
      kind: 'Retrieved',
      sources: [{ episodeSaid: said('z'), rawEvidenceSaid, score: 0.9 }],
      queryReceiptSaid: said('q'),
      chargedMicroUsd: 1,
    });
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
    expect(ports.readSpy).not.toHaveBeenCalled();
  });

  it('rejects altered signed inventory before retrieval', async () => {
    const ports = dependencies();
    const altered = { ...inventory, corpusSaid: said('z') };
    expect((await reviewAnalogyInfluence({ inventory: altered, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
    expect(ports.retrieveSpy).not.toHaveBeenCalled();
  });

  it('requires a source-specific unsupported result without the source', async () => {
    const ports = dependencies();
    ports.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: readonly unknown[] } }) =>
        Promise.resolve(
          view.sources.length
            ? {
                kind: 'Chosen',
                action: 'compatibility-recovery',
                sourceChoiceSaid: episodeSaid,
                citationSaids: [],
              }
            : { kind: 'Unsupported', sourceSpecificTo: episodeSaid },
        ),
      );
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Influenced',
    );
    ports.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: readonly unknown[] } }) =>
        Promise.resolve(
          view.sources.length
            ? {
                kind: 'Chosen',
                action: 'compatibility-recovery',
                sourceChoiceSaid: episodeSaid,
                citationSaids: [],
              }
            : { kind: 'Unsupported', sourceSpecificTo: said('z') },
        ),
      );
    expect(await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).toMatchObject({
      kind: 'NotInfluenced',
      reason: 'NoSourceSpecificDependence',
    });
  });

  it('rejects a no-source choice that still cites or selects the removed source', async () => {
    const ports = dependencies();
    ports.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: readonly unknown[] } }) =>
        Promise.resolve(
          view.sources.length
            ? {
                kind: 'Chosen',
                action: 'compatibility-recovery',
                sourceChoiceSaid: episodeSaid,
                citationSaids: [episodeSaid],
              }
            : {
                kind: 'Chosen',
                action: 'submit-now',
                sourceChoiceSaid: episodeSaid,
                citationSaids: [episodeSaid],
              },
        ),
      );
    expect(await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).toEqual({
      kind: 'Blocked',
      reason: 'Choice',
    });
  });

  it('retains other authorized sources in the no-target view', async () => {
    const otherEpisodeSaid = said('u');
    const otherRawSaid = said('v');
    const prepared = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid: said('t'),
      ownerAid,
      repositoryResourceSaid: said('g'),
      corpusSaid: said('c'),
      experienceMandateSaid: said('m'),
      sources: inventory.sources.concat([
        {
          episodeSaid: otherEpisodeSaid,
          rawEvidenceSaid: otherRawSaid,
          ownerAid,
          repositoryResourceSaid: said('g'),
          corpusSaid: said('c'),
          disclosure: 'AuthorizedAnalogy',
        },
      ]),
    });
    if (prepared.kind !== 'Prepared') throw new Error('two-source fixture');
    const ports = dependencies();
    ports.retrieval.retrieve = vi.fn().mockResolvedValue({
      kind: 'Retrieved',
      sources: [
        { episodeSaid, rawEvidenceSaid, score: 0.9 },
        { episodeSaid: otherEpisodeSaid, rawEvidenceSaid: otherRawSaid, score: 0.8 },
      ],
      queryReceiptSaid: said('q'),
      chargedMicroUsd: 1,
    });
    ports.reading.read = vi.fn().mockImplementation(({ evidenceSaid }: { evidenceSaid: string }) =>
      Promise.resolve({
        kind: 'Read',
        bytes,
        totalBytes: bytes.length,
        sourceSaid: evidenceSaid === rawEvidenceSaid ? episodeSaid : otherEpisodeSaid,
        readReceiptSaid: said('b'),
      }),
    );
    ports.projection.project = vi
      .fn()
      .mockImplementation(
        ({
          episodeSaid: episode,
          rawEvidenceSaid: raw,
        }: {
          episodeSaid: string;
          rawEvidenceSaid: string;
        }) =>
          Promise.resolve({
            kind: 'Projected',
            episodeSaid: episode,
            rawEvidenceSaid: raw,
            readReceiptSaid: said('b'),
            observation: 'public observation',
            recoveryHint: 'reviewed hint',
          }),
      );
    ports.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: readonly { episodeSaid: string }[] } }) =>
        Promise.resolve(
          view.sources.some((source) => source.episodeSaid === episodeSaid)
            ? {
                kind: 'Chosen',
                action: 'compatibility-recovery',
                sourceChoiceSaid: episodeSaid,
                citationSaids: [],
              }
            : {
                kind: 'Chosen',
                action: 'submit-now',
                sourceChoiceSaid: otherEpisodeSaid,
                citationSaids: [],
              },
        ),
      );
    const outcome = await reviewAnalogyInfluence(
      { inventory: prepared.inventory, ...fixedInput },
      ports,
    );
    expect(outcome.kind).toBe('Influenced');
    if (outcome.kind === 'Influenced')
      expect(outcome.withoutSourceView.map((source) => source.episodeSaid)).toEqual([
        otherEpisodeSaid,
      ]);
  });

  it.each([
    { bytes: new Uint8Array(), totalBytes: 0, sourceSaid: episodeSaid, readReceiptSaid: said('b') },
    { bytes, totalBytes: bytes.length + 1, sourceSaid: episodeSaid, readReceiptSaid: said('b') },
    { bytes, totalBytes: bytes.length, sourceSaid: said('z'), readReceiptSaid: said('b') },
    { bytes, totalBytes: bytes.length, sourceSaid: episodeSaid, readReceiptSaid: 'bad' },
  ])('rejects missing, partial or mismatched exact raw custody', async (raw) => {
    const ports = dependencies();
    ports.reading.read = vi.fn().mockResolvedValue({ kind: 'Read', ...raw });
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
    expect(ports.choiceSpy).not.toHaveBeenCalled();
  });

  it('rejects projection with a forged read receipt', async () => {
    const ports = dependencies();
    ports.projection.project = vi.fn().mockResolvedValue({
      kind: 'Projected',
      episodeSaid,
      rawEvidenceSaid,
      readReceiptSaid: said('z'),
      observation: 'x',
      recoveryHint: 'y',
    });
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
    expect(ports.choiceSpy).not.toHaveBeenCalled();
  });

  it('blocks when the parent rejects raw projection instead of exposing it as context', async () => {
    const ports = dependencies();
    ports.projection.project = vi.fn().mockResolvedValue({ kind: 'Rejected' });
    expect(await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).toEqual({
      kind: 'Blocked',
      reason: 'Projection',
    });
    expect(ports.choiceSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing raw source without asking the parent to replay', async () => {
    const ports = dependencies();
    ports.reading.read = vi.fn().mockResolvedValue({ kind: 'NotFound' });
    expect(await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).toEqual({
      kind: 'Blocked',
      reason: 'Raw',
    });
    expect(ports.choiceSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized projection and a stale reviewed choice', async () => {
    const ports = dependencies();
    ports.projection.project = vi.fn().mockResolvedValue({
      kind: 'Projected',
      episodeSaid,
      rawEvidenceSaid,
      readReceiptSaid: said('b'),
      observation: 'x'.repeat(32_769),
      recoveryHint: 'y',
    });
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
    ports.projection = dependencies().projection;
    ports.choice.recalculate = vi.fn().mockResolvedValue({
      kind: 'Chosen',
      action: 'different',
      sourceChoiceSaid: episodeSaid,
      citationSaids: [],
    });
    expect((await reviewAnalogyInfluence({ inventory, ...fixedInput }, ports)).kind).toBe(
      'Blocked',
    );
  });
});
