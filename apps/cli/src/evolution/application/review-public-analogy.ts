import { prepareEvidenceArtifact } from '@devrandom/protocol';
import type {
  AuthorizedAnalogy,
  FixedPublicChoiceInput,
  RecalculatedChoice,
  ReviewedAnalogyProjection,
  ReviewedChoiceRecalculation,
} from '@devrandom/runtime';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const action = /^[a-z][a-z0-9-]{1,79}$/u;
const ignored = new Set([
  'cesr',
  'receipt',
  'parser',
  'rejected',
  'expected',
  'observed',
  'exit',
  'code',
]);

/** A trusted parent's bounded review of an existing Run Verifier Observation. */
export interface ReviewedPublicAnalogy {
  readonly version: 1;
  readonly kind: 'ReviewedPublicAnalogy';
  readonly episodeSaid: string;
  readonly runId: string;
  readonly rawEvidenceSaid: string;
  readonly observation: string;
  readonly recoveryAction: string;
  readonly predictedCorrection: string;
  readonly implicatedComponent: 'Instruction' | 'Workflow' | 'ContextSelection';
  readonly regressionRisks: readonly string[];
}

function publicText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximum &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code >= 32 || code === 10) && code !== 127;
    })
  );
}

/** Review bytes are canonical, bounded, and bind the exact existing Run event/raw artifact. */
export function decodeReviewedPublicAnalogy(
  bytes: Uint8Array,
):
  | { readonly kind: 'Accepted'; readonly analogy: ReviewedPublicAnalogy }
  | { readonly kind: 'Rejected' } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024)
    return { kind: 'Rejected' };
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (JSON.stringify(value) !== text) return { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { kind: 'Rejected' };
  const record = value as Partial<ReviewedPublicAnalogy>;
  if (
    Object.keys(record).sort().join(',') !==
      'episodeSaid,implicatedComponent,kind,observation,predictedCorrection,rawEvidenceSaid,recoveryAction,regressionRisks,runId,version' ||
    record.version !== 1 ||
    record.kind !== 'ReviewedPublicAnalogy' ||
    typeof record.episodeSaid !== 'string' ||
    !said.test(record.episodeSaid) ||
    typeof record.runId !== 'string' ||
    !runId.test(record.runId) ||
    typeof record.rawEvidenceSaid !== 'string' ||
    !said.test(record.rawEvidenceSaid) ||
    !publicText(record.observation, 2048) ||
    typeof record.recoveryAction !== 'string' ||
    !action.test(record.recoveryAction) ||
    !publicText(record.predictedCorrection, 2048) ||
    !['Instruction', 'Workflow', 'ContextSelection'].includes(record.implicatedComponent ?? '') ||
    !Array.isArray(record.regressionRisks) ||
    record.regressionRisks.length < 1 ||
    record.regressionRisks.length > 8 ||
    !record.regressionRisks.every((risk) => publicText(risk, 512))
  )
    return { kind: 'Rejected' };
  return { kind: 'Accepted', analogy: record as ReviewedPublicAnalogy };
}

/** Server scope and custody are repeated locally against exact raw bytes and review excerpt. */
export class ReviewedPublicAnalogyProjection implements ReviewedAnalogyProjection {
  readonly #reviews: ReadonlyMap<string, ReviewedPublicAnalogy>;
  constructor(reviews: readonly ReviewedPublicAnalogy[]) {
    const entries = new Map<string, ReviewedPublicAnalogy>();
    for (const review of reviews) {
      const decoded = decodeReviewedPublicAnalogy(new TextEncoder().encode(JSON.stringify(review)));
      if (decoded.kind !== 'Accepted' || entries.has(review.episodeSaid))
        throw new Error('Public analogy review invalid or repeated');
      entries.set(review.episodeSaid, decoded.analogy);
    }
    this.#reviews = entries;
  }

  project(
    input: Parameters<ReviewedAnalogyProjection['project']>[0],
  ): ReturnType<ReviewedAnalogyProjection['project']> {
    const reviewed = this.#reviews.get(input.episodeSaid);
    const textArtifact = prepareEvidenceArtifact(input.bytes, 'text/plain; charset=utf-8');
    const jsonArtifact = prepareEvidenceArtifact(input.bytes, 'application/json');
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    } catch {
      return Promise.resolve({ kind: 'Rejected' });
    }
    const exact =
      (textArtifact.kind === 'Prepared' && textArtifact.artifact.d === input.rawEvidenceSaid) ||
      (jsonArtifact.kind === 'Prepared' && jsonArtifact.artifact.d === input.rawEvidenceSaid);
    if (
      reviewed === undefined ||
      reviewed.rawEvidenceSaid !== input.rawEvidenceSaid ||
      !said.test(input.readReceiptSaid) ||
      !exact ||
      !raw.includes(reviewed.observation)
    )
      return Promise.resolve({ kind: 'Rejected' });
    return Promise.resolve({
      kind: 'Projected',
      episodeSaid: input.episodeSaid,
      rawEvidenceSaid: input.rawEvidenceSaid,
      readReceiptSaid: input.readReceiptSaid,
      observation: reviewed.observation,
      recoveryHint: reviewed.recoveryAction,
    });
  }
}

function tokens(value: string): Set<string> {
  return new Set(
    (
      value
        .normalize('NFKC')
        .toLowerCase()
        .match(/[a-z0-9]{2,}/gu) ?? []
    ).filter((word) => !ignored.has(word)),
  );
}
function relevant(query: Set<string>, source: AuthorizedAnalogy): number {
  const observation = tokens(source.observation);
  return [...query].filter((word) => observation.has(word)).length;
}

/** A single fixed public choice law runs on source-with and source-without views. */
export class PublicAnalogyChoiceReplay implements ReviewedChoiceRecalculation {
  readonly #targetEpisodeSaid: string;
  constructor(targetEpisodeSaid: string) {
    if (!said.test(targetEpisodeSaid)) throw new Error('Target source identity invalid');
    this.#targetEpisodeSaid = targetEpisodeSaid;
  }
  recalculate(
    input: Parameters<ReviewedChoiceRecalculation['recalculate']>[0],
  ): Promise<RecalculatedChoice> {
    const { fixed, view } = input;
    if (!this.#validFixed(fixed) || view.sources.length > 3)
      throw new Error('Choice inputs invalid');
    const query = tokens(fixed.failureQuery);
    const candidates = view.sources.map((source) => {
      if (
        !said.test(source.episodeSaid) ||
        !said.test(source.rawEvidenceSaid) ||
        !said.test(source.readReceiptSaid) ||
        !publicText(source.observation, 2048) ||
        !action.test(source.recoveryHint)
      )
        throw new Error('Choice source invalid');
      return { source, overlap: relevant(query, source) };
    });
    if (new Set(candidates.map(({ source }) => source.episodeSaid)).size !== candidates.length)
      throw new Error('Choice source repeated');
    candidates.sort(
      (left, right) =>
        right.overlap - left.overlap ||
        left.source.episodeSaid.localeCompare(right.source.episodeSaid, 'en'),
    );
    const selected = candidates[0];
    if (selected === undefined || selected.overlap < 2)
      return Promise.resolve({ kind: 'Unsupported', sourceSpecificTo: this.#targetEpisodeSaid });
    return Promise.resolve({
      kind: 'Chosen',
      action: selected.source.recoveryHint,
      sourceChoiceSaid: selected.source.episodeSaid,
      citationSaids: [selected.source.episodeSaid],
    });
  }
  #validFixed(fixed: FixedPublicChoiceInput): boolean {
    return (
      fixed.taskId.length > 0 &&
      said.test(fixed.taskRevisionSaid) &&
      said.test(fixed.sourceInventorySaid) &&
      said.test(fixed.corpusSaid) &&
      said.test(fixed.publicFailureWindowSaid) &&
      said.test(fixed.configurationSaid) &&
      said.test(fixed.nonTreatmentInputsSaid) &&
      publicText(fixed.failureQuery, 1024)
    );
  }
}
