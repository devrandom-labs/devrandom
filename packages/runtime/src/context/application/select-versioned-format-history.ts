import { decodeEvidenceArtifact, type EvidenceArtifact } from '@devrandom/protocol';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^/]+(?:\/[^/]+)*$/u;
const kinds = ['Failure', 'Contract', 'Edit'] as const;
type HistoryKind = (typeof kinds)[number];

/** One reviewed, bounded policy is the entire C3 treatment; the caller owns current authority. */
export interface VersionedFormatHistoryPolicy {
  readonly version: 1;
  readonly arm: 'C3';
  readonly formatMarker: string;
  readonly triggerPaths: readonly string[];
  readonly priority: readonly HistoryKind[];
  readonly maximumItems: number;
  readonly maximumContextBytes: number;
}

export interface PublicHistorySource {
  readonly sourceId: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
  readonly kind: HistoryKind;
  readonly version: string;
  readonly custody: 'Public' | 'Protected';
}

/** Semantic projection is a trusted parent review, never instruction text copied from raw source. */
export interface ReviewedHistoryProjection {
  project(input: {
    readonly sourceId: string;
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly sourceInventorySaid: string;
  }): Promise<
    | { readonly kind: 'Projected'; readonly sourceId: string; readonly text: string }
    | { readonly kind: 'Rejected' }
  >;
}

export type VersionedHistorySelection =
  | {
      readonly kind: 'Selected';
      readonly includedSourceIds: readonly string[];
      readonly excludedSourceIds: readonly string[];
      readonly contextText: string;
      readonly contextBytes: number;
    }
  | { readonly kind: 'Blocked' };

function reviewedText(text: string): boolean {
  if (text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > 8 * 1024) return false;
  return Array.from(text).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 32 || [9, 10, 13].includes(code)) && code !== 127;
  });
}

function safeCharacters(text: string): boolean {
  return Array.from(text).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127 && character !== '\\';
  });
}

export function validVersionedHistoryPolicy(policy: VersionedFormatHistoryPolicy): boolean {
  return (
    typeof policy.formatMarker === 'string' &&
    policy.formatMarker.length > 0 &&
    policy.formatMarker.length <= 64 &&
    safeCharacters(policy.formatMarker) &&
    policy.triggerPaths.length > 0 &&
    policy.triggerPaths.length <= 8 &&
    new Set(policy.triggerPaths).size === policy.triggerPaths.length &&
    policy.triggerPaths.every(
      (path) => path.length <= 512 && safePath.test(path) && safeCharacters(path),
    ) &&
    policy.priority.length === kinds.length &&
    new Set(policy.priority).size === kinds.length &&
    policy.priority.every((kind) => kinds.includes(kind)) &&
    Number.isSafeInteger(policy.maximumItems) &&
    policy.maximumItems >= 1 &&
    policy.maximumItems <= 8 &&
    Number.isSafeInteger(policy.maximumContextBytes) &&
    policy.maximumContextBytes >= 128 &&
    policy.maximumContextBytes <= 32 * 1024
  );
}

/** Selects and orders exact current public history for a declared versioned-format edit. */
export async function selectVersionedFormatHistory(
  input: {
    readonly policy: VersionedFormatHistoryPolicy;
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly sourceInventorySaid: string;
    readonly edit: { readonly path: string; readonly content: string };
    readonly sources: readonly PublicHistorySource[];
  },
  projection: ReviewedHistoryProjection,
): Promise<VersionedHistorySelection> {
  const { policy, sources } = input;
  if (
    !validVersionedHistoryPolicy(policy) ||
    input.taskId.length === 0 ||
    !said.test(input.taskRevisionSaid) ||
    !said.test(input.sourceInventorySaid) ||
    !policy.triggerPaths.includes(input.edit.path) ||
    !input.edit.content.includes(policy.formatMarker) ||
    sources.length === 0 ||
    sources.length > 64
  )
    return { kind: 'Blocked' };
  const ids = new Set<string>();
  for (const source of sources) {
    if (
      source.custody !== 'Public' ||
      source.sourceId !== source.artifact.d ||
      ids.has(source.sourceId) ||
      source.bytes.byteLength === 0 ||
      source.bytes.byteLength > 32 * 1024 ||
      !['text/plain; charset=utf-8', 'application/json'].includes(source.artifact.mediaType) ||
      decodeEvidenceArtifact(source.artifact, source.bytes).kind !== 'Accepted'
    )
      return { kind: 'Blocked' };
    ids.add(source.sourceId);
  }
  const ordered = [...sources].sort((left, right) => {
    const priority = policy.priority.indexOf(left.kind) - policy.priority.indexOf(right.kind);
    return priority === 0 ? left.sourceId.localeCompare(right.sourceId, 'en') : priority;
  });
  const included: string[] = [];
  const excluded: string[] = [];
  const paragraphs: string[] = [];
  for (const source of ordered) {
    if (source.version !== policy.formatMarker || included.length >= policy.maximumItems) {
      excluded.push(source.sourceId);
      continue;
    }
    let projected: Awaited<ReturnType<ReviewedHistoryProjection['project']>>;
    try {
      projected = await projection.project({
        sourceId: source.sourceId,
        artifact: source.artifact,
        bytes: Uint8Array.from(source.bytes),
        taskId: input.taskId,
        taskRevisionSaid: input.taskRevisionSaid,
        sourceInventorySaid: input.sourceInventorySaid,
      });
    } catch {
      return { kind: 'Blocked' };
    }
    if (
      projected.kind !== 'Projected' ||
      projected.sourceId !== source.sourceId ||
      !reviewedText(projected.text)
    )
      return { kind: 'Blocked' };
    const paragraph = `[${source.sourceId}] ${projected.text}`;
    const next = [...paragraphs, paragraph].join('\n');
    if (Buffer.byteLength(next, 'utf8') > policy.maximumContextBytes) {
      excluded.push(source.sourceId);
      continue;
    }
    included.push(source.sourceId);
    paragraphs.push(paragraph);
  }
  if (included.length === 0) return { kind: 'Blocked' };
  const contextText = paragraphs.join('\n');
  return {
    kind: 'Selected',
    includedSourceIds: included,
    excludedSourceIds: excluded,
    contextText,
    contextBytes: Buffer.byteLength(contextText, 'utf8'),
  };
}
