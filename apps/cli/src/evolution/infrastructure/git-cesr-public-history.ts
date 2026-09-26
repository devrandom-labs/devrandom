import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import {
  decodeEvidenceArtifact,
  decodeQualifiedFailureWindow,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
  type EvolutionHypothesis,
  type QualifiedFailureWindowPreparation,
} from '@devrandom/protocol';
import type { PublicHistorySource, ReviewedHistoryProjection } from '@devrandom/runtime';

import type { CurrentPublicHistory } from './parent-successor-behavior-replay.js';

const run = promisify(execFile);
const sha1 = /^[a-f0-9]{40}$/u;

interface ReviewedSource {
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** Exact clean CESR Git source and qualified public failure, projected as bounded facts. */
export class GitCesrPublicHistory implements CurrentPublicHistory, ReviewedHistoryProjection {
  readonly #hypothesis: EvolutionHypothesis;
  readonly #window: Extract<QualifiedFailureWindowPreparation, { kind: 'Prepared' }>;
  #reviewed = new Map<string, ReviewedSource>();

  constructor(input: {
    readonly hypothesis: EvolutionHypothesis;
    readonly window: Extract<QualifiedFailureWindowPreparation, { kind: 'Prepared' }>;
  }) {
    this.#hypothesis = input.hypothesis;
    this.#window = input.window;
  }

  async read(
    input: Parameters<CurrentPublicHistory['read']>[0],
  ): ReturnType<CurrentPublicHistory['read']> {
    this.#reviewed = new Map();
    const h0 = this.#hypothesis;
    const window = decodeQualifiedFailureWindow(this.#window.artifact, this.#window.bytes);
    if (
      !isAbsolute(input.sourceDirectory) ||
      !sha1.test(input.h1Commit) ||
      !sha1.test(input.h1Tree) ||
      input.formatMarker !== 'Current' ||
      window.kind !== 'Accepted' ||
      window.artifact.d !== h0.publicReplay.failureWindowSaid ||
      window.window.taskId !== h0.taskId ||
      window.window.taskRevisionSaid !== h0.taskRevisionSaid ||
      window.window.originRunId !== h0.originRunId ||
      window.window.retainedCheckpointSaid !== h0.retainedCheckpointSaid ||
      window.window.retainedSealSaid !== h0.retainedSealSaid ||
      window.window.failureEventSaid !== h0.failure.eventSaid ||
      window.window.verifierReceiptSaid !== h0.failure.rawEvidenceSaid ||
      input.taskId !== h0.taskId ||
      input.taskRevisionSaid !== h0.taskRevisionSaid ||
      input.sourceInventorySaid !== h0.sourceInventorySaid
    )
      return { kind: 'Unavailable' };
    try {
      const options = { cwd: input.sourceDirectory, maxBuffer: 128 * 1024 };
      const [identity, status, agents, source] = await Promise.all([
        run('git', ['rev-parse', 'HEAD', 'HEAD^{tree}', '--show-toplevel'], options),
        run('git', ['status', '--porcelain=v1', '--untracked-files=all'], options),
        run('git', ['show', `${input.h1Commit}:AGENTS.md`], options),
        run('git', ['show', `${input.h1Commit}:src/lib.rs`], options),
      ]);
      const [commit, tree, top] = identity.stdout.trimEnd().split('\n');
      if (
        commit !== input.h1Commit ||
        tree !== input.h1Tree ||
        top !== input.sourceDirectory ||
        status.stdout !== '' ||
        !agents.stdout.includes('-_AAABAA') ||
        !agents.stdout.includes('-_AAACAA') ||
        !source.stdout.includes('ReceiptVersion::Current') ||
        !source.stdout.includes('strip_prefix("-_AAACAA")') ||
        !source.stdout.includes(input.formatMarker)
      )
        return { kind: 'Unavailable' };
      const contractBytes = Buffer.from(agents.stdout, 'utf8');
      const editBytes = Buffer.from(source.stdout, 'utf8');
      const contract = prepareEvidenceArtifact(contractBytes, 'text/plain; charset=utf-8');
      const edit = prepareEvidenceArtifact(editBytes, 'text/plain; charset=utf-8');
      if (
        contract.kind !== 'Prepared' ||
        edit.kind !== 'Prepared' ||
        contractBytes.byteLength > 32 * 1024 ||
        editBytes.byteLength > 32 * 1024
      )
        return { kind: 'Unavailable' };
      const sources: readonly PublicHistorySource[] = [
        {
          sourceId: window.artifact.d,
          artifact: window.artifact,
          bytes: window.bytes,
          kind: 'Failure',
          version: input.formatMarker,
          custody: 'Public',
        },
        {
          sourceId: contract.artifact.d,
          artifact: contract.artifact,
          bytes: contractBytes,
          kind: 'Contract',
          version: input.formatMarker,
          custody: 'Public',
        },
        {
          sourceId: edit.artifact.d,
          artifact: edit.artifact,
          bytes: editBytes,
          kind: 'Edit',
          version: input.formatMarker,
          custody: 'Public',
        },
      ];
      this.#reviewed = new Map([
        [
          window.artifact.d,
          {
            artifact: window.artifact,
            bytes: window.bytes,
            text: `Qualified public compatibility failure ${window.window.failureEventSaid}; verifier receipt ${window.window.verifierReceiptSaid}.`,
          },
        ],
        [
          contract.artifact.d,
          {
            artifact: contract.artifact,
            bytes: contractBytes,
            text: 'Task public contract defines current and legacy CESR markers and per-group version handling.',
          },
        ],
        [
          edit.artifact.d,
          {
            artifact: edit.artifact,
            bytes: editBytes,
            text: `Selected exact source lines from src/lib.rs:\n${source.stdout
              .split('\n')
              .flatMap((line, index) =>
                /short_frame|split_group|strip_prefix|decode_count/u.test(line)
                  ? [`${String(index + 1)}: ${line}`]
                  : [],
              )
              .join('\n')}`,
          },
        ],
      ]);
      return { kind: 'Read', edit: { path: 'src/lib.rs', content: source.stdout }, sources };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  project(
    input: Parameters<ReviewedHistoryProjection['project']>[0],
  ): ReturnType<ReviewedHistoryProjection['project']> {
    const h0 = this.#hypothesis;
    const source = this.#reviewed.get(input.sourceId);
    return Promise.resolve(
      source !== undefined &&
        input.taskId === h0.taskId &&
        input.taskRevisionSaid === h0.taskRevisionSaid &&
        input.sourceInventorySaid === h0.sourceInventorySaid &&
        input.artifact.d === source.artifact.d &&
        decodeEvidenceArtifact(input.artifact, input.bytes).kind === 'Accepted' &&
        Buffer.from(input.bytes).equals(Buffer.from(source.bytes))
        ? { kind: 'Projected', sourceId: input.sourceId, text: source.text }
        : { kind: 'Rejected' },
    );
  }
}
