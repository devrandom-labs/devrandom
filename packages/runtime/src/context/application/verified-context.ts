import {
  decodeEvaluationSourceInventory,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';

import type { EvidenceReading, ExperienceRetrieval } from './experience-conversations.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const maximumProjectionBytes = 32_768;

/** A trusted parent reviews exact raw bytes before any text enters an agent context. */
export interface ReviewedAnalogyProjection {
  project(input: {
    readonly episodeSaid: string;
    readonly rawEvidenceSaid: string;
    readonly readReceiptSaid: string;
    readonly bytes: Uint8Array;
  }): Promise<
    | {
        readonly kind: 'Projected';
        readonly episodeSaid: string;
        readonly rawEvidenceSaid: string;
        readonly readReceiptSaid: string;
        readonly observation: string;
        readonly recoveryHint: string;
      }
    | { readonly kind: 'Rejected' }
  >;
}

export interface AuthorizedAnalogy {
  readonly episodeSaid: string;
  readonly rawEvidenceSaid: string;
  readonly readReceiptSaid: string;
  readonly observation: string;
  readonly recoveryHint: string;
}

export interface FixedPublicChoiceInput {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly sourceInventorySaid: string;
  readonly corpusSaid: string;
  readonly publicFailureWindowSaid: string;
  readonly configurationSaid: string;
  readonly nonTreatmentInputsSaid: string;
  /** Pre-treatment query from the public failure window; never a source-derived excerpt. */
  readonly failureQuery: string;
}

export type RecalculatedChoice =
  | {
      readonly kind: 'Chosen';
      readonly action: string;
      readonly sourceChoiceSaid: string;
      readonly citationSaids: readonly string[];
    }
  | {
      readonly kind: 'Unsupported';
      readonly sourceSpecificTo: string;
    };

/** The same parent-owned choice procedure must actually run for each independently built view. */
export interface ReviewedChoiceRecalculation {
  recalculate(input: {
    readonly fixed: FixedPublicChoiceInput;
    readonly view: { readonly sources: readonly AuthorizedAnalogy[] };
  }): Promise<RecalculatedChoice>;
}

export interface AnalogyInfluenceInput extends Omit<
  FixedPublicChoiceInput,
  'taskId' | 'taskRevisionSaid' | 'sourceInventorySaid' | 'corpusSaid'
> {
  readonly inventory: EvaluationSourceInventory;
  readonly targetEpisodeSaid: string;
  readonly reviewedAction: string;
  readonly reviewedSourceChoiceSaid: string;
}

export type AnalogyInfluenceReview =
  | {
      readonly kind: 'Influenced';
      readonly queryReceiptSaid: string;
      readonly source: AuthorizedAnalogy;
      readonly fixed: FixedPublicChoiceInput;
      readonly withSourceView: readonly AuthorizedAnalogy[];
      readonly withoutSourceView: readonly AuthorizedAnalogy[];
      readonly chargedMicroUsd: number;
      readonly withSource: RecalculatedChoice;
      readonly withoutSource: RecalculatedChoice;
    }
  | {
      readonly kind: 'NotInfluenced';
      readonly reason: 'ChoiceUnchanged' | 'NoSourceSpecificDependence';
      readonly queryReceiptSaid: string;
      readonly source: AuthorizedAnalogy;
      readonly fixed: FixedPublicChoiceInput;
      readonly withSourceView: readonly AuthorizedAnalogy[];
      readonly withoutSourceView: readonly AuthorizedAnalogy[];
      readonly chargedMicroUsd: number;
      readonly withSource: RecalculatedChoice;
      readonly withoutSource: RecalculatedChoice;
    }
  | {
      readonly kind: 'Blocked';
      readonly reason: 'Authority' | 'Retrieval' | 'Source' | 'Raw' | 'Projection' | 'Choice';
    };

function validText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validChoice(choice: RecalculatedChoice): boolean {
  if (choice.kind === 'Unsupported') return said.test(choice.sourceSpecificTo);
  return (
    validText(choice.action) &&
    said.test(choice.sourceChoiceSaid) &&
    choice.citationSaids.every((citation) => said.test(citation))
  );
}

/** E3 A2: scoped retrieval is only a lead; exact complete reads precede reviewed projection. */
export async function reviewAnalogyInfluence(
  input: AnalogyInfluenceInput,
  ports: {
    readonly retrieval: ExperienceRetrieval;
    readonly reading: EvidenceReading;
    readonly projection: ReviewedAnalogyProjection;
    readonly choice: ReviewedChoiceRecalculation;
  },
): Promise<AnalogyInfluenceReview> {
  const decoded = decodeEvaluationSourceInventory(input.inventory);
  if (
    decoded.kind !== 'Accepted' ||
    !said.test(input.publicFailureWindowSaid) ||
    !said.test(input.configurationSaid) ||
    !said.test(input.nonTreatmentInputsSaid) ||
    !said.test(input.reviewedSourceChoiceSaid) ||
    !validText(input.reviewedAction) ||
    !validText(input.failureQuery) ||
    input.failureQuery.length > 1_024 ||
    !decoded.inventory.sources.some((source) => source.episodeSaid === input.targetEpisodeSaid)
  )
    return { kind: 'Blocked', reason: 'Authority' };

  const inventory = decoded.inventory;
  let retrieved: Awaited<ReturnType<ExperienceRetrieval['retrieve']>>;
  try {
    retrieved = await ports.retrieval.retrieve({
      taskId: inventory.taskId,
      taskRevisionSaid: inventory.taskRevisionSaid,
      sourceInventorySaid: inventory.d,
      corpusSaid: inventory.corpusSaid,
      failureQuery: input.failureQuery,
      maximumResults: 3,
    });
  } catch {
    return { kind: 'Blocked', reason: 'Retrieval' };
  }
  if (
    retrieved.kind !== 'Retrieved' ||
    !said.test(retrieved.queryReceiptSaid) ||
    !Number.isSafeInteger(retrieved.chargedMicroUsd) ||
    retrieved.chargedMicroUsd < 0 ||
    retrieved.sources.length === 0 ||
    retrieved.sources.length > 3
  )
    return { kind: 'Blocked', reason: 'Retrieval' };

  const seen = new Set<string>();
  for (const hit of retrieved.sources) {
    if (
      seen.has(hit.episodeSaid) ||
      !Number.isFinite(hit.score) ||
      hit.score < 0 ||
      !inventory.sources.some(
        (source) =>
          source.episodeSaid === hit.episodeSaid && source.rawEvidenceSaid === hit.rawEvidenceSaid,
      )
    )
      return { kind: 'Blocked', reason: 'Source' };
    seen.add(hit.episodeSaid);
  }
  if (!seen.has(input.targetEpisodeSaid)) return { kind: 'Blocked', reason: 'Source' };

  const sources: AuthorizedAnalogy[] = [];
  let projectionBytes = 0;
  for (const hit of retrieved.sources) {
    let read: Awaited<ReturnType<EvidenceReading['read']>>;
    try {
      read = await ports.reading.read({
        taskId: inventory.taskId,
        sourceInventorySaid: inventory.d,
        evidenceSaid: hit.rawEvidenceSaid,
        offset: 0,
        maximumBytes: maximumProjectionBytes,
      });
    } catch {
      return { kind: 'Blocked', reason: 'Raw' };
    }
    if (
      read.kind !== 'Read' ||
      !(read.bytes instanceof Uint8Array) ||
      read.bytes.byteLength === 0 ||
      read.bytes.byteLength > maximumProjectionBytes ||
      read.totalBytes !== read.bytes.byteLength ||
      read.sourceSaid !== hit.episodeSaid ||
      !said.test(read.readReceiptSaid)
    )
      return { kind: 'Blocked', reason: 'Raw' };

    let projected: Awaited<ReturnType<ReviewedAnalogyProjection['project']>>;
    try {
      projected = await ports.projection.project({
        episodeSaid: hit.episodeSaid,
        rawEvidenceSaid: hit.rawEvidenceSaid,
        readReceiptSaid: read.readReceiptSaid,
        bytes: read.bytes,
      });
    } catch {
      return { kind: 'Blocked', reason: 'Projection' };
    }
    if (
      projected.kind !== 'Projected' ||
      projected.episodeSaid !== hit.episodeSaid ||
      projected.rawEvidenceSaid !== hit.rawEvidenceSaid ||
      projected.readReceiptSaid !== read.readReceiptSaid ||
      !validText(projected.observation) ||
      !validText(projected.recoveryHint)
    )
      return { kind: 'Blocked', reason: 'Projection' };
    projectionBytes += new TextEncoder().encode(
      projected.observation + projected.recoveryHint,
    ).length;
    if (projectionBytes > maximumProjectionBytes) return { kind: 'Blocked', reason: 'Projection' };
    sources.push(
      Object.freeze({
        episodeSaid: hit.episodeSaid,
        rawEvidenceSaid: hit.rawEvidenceSaid,
        readReceiptSaid: read.readReceiptSaid,
        observation: projected.observation,
        recoveryHint: projected.recoveryHint,
      }),
    );
  }

  const target = sources.find((source) => source.episodeSaid === input.targetEpisodeSaid);
  if (target === undefined) return { kind: 'Blocked', reason: 'Source' };
  const fixed = Object.freeze({
    taskId: inventory.taskId,
    taskRevisionSaid: inventory.taskRevisionSaid,
    sourceInventorySaid: inventory.d,
    corpusSaid: inventory.corpusSaid,
    publicFailureWindowSaid: input.publicFailureWindowSaid,
    configurationSaid: input.configurationSaid,
    nonTreatmentInputsSaid: input.nonTreatmentInputsSaid,
    failureQuery: input.failureQuery,
  });
  let withSource: RecalculatedChoice;
  let withoutSource: RecalculatedChoice;
  const withSourceView = Object.freeze([...sources]);
  const withoutSourceView = Object.freeze(
    sources.filter((source) => source.episodeSaid !== input.targetEpisodeSaid),
  );
  try {
    withSource = await ports.choice.recalculate({
      fixed,
      view: Object.freeze({ sources: withSourceView }),
    });
    withoutSource = await ports.choice.recalculate({
      fixed,
      view: Object.freeze({ sources: withoutSourceView }),
    });
  } catch {
    return { kind: 'Blocked', reason: 'Choice' };
  }
  if (
    !validChoice(withSource) ||
    !validChoice(withoutSource) ||
    withSource.kind !== 'Chosen' ||
    withSource.action !== input.reviewedAction ||
    withSource.sourceChoiceSaid !== input.reviewedSourceChoiceSaid
  )
    return { kind: 'Blocked', reason: 'Choice' };
  if (
    withoutSource.kind === 'Chosen' &&
    (withoutSource.sourceChoiceSaid === input.targetEpisodeSaid ||
      withoutSource.citationSaids.includes(input.targetEpisodeSaid))
  )
    return { kind: 'Blocked', reason: 'Choice' };
  const evidence = {
    queryReceiptSaid: retrieved.queryReceiptSaid,
    chargedMicroUsd: retrieved.chargedMicroUsd,
    source: target,
    fixed,
    withSourceView,
    withoutSourceView,
    withSource,
    withoutSource,
  };
  if (withoutSource.kind === 'Unsupported')
    return withoutSource.sourceSpecificTo === input.targetEpisodeSaid
      ? { kind: 'Influenced', ...evidence }
      : { kind: 'NotInfluenced', reason: 'NoSourceSpecificDependence', ...evidence };
  return withoutSource.action !== withSource.action ||
    withoutSource.sourceChoiceSaid !== withSource.sourceChoiceSaid
    ? { kind: 'Influenced', ...evidence }
    : { kind: 'NotInfluenced', reason: 'ChoiceUnchanged', ...evidence };
}
