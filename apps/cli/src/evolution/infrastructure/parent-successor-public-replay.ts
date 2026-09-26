import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvaluationVerifierBundleInput,
} from '@devrandom/protocol';
import { observedPublicCase, type SuccessorPublicReplay } from '@devrandom/runtime';

import type {
  SuccessorBehaviorProof,
  SuccessorReplayReceiptCustody,
} from '../application/observe-successor-public-replay.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const sha1 = /^[a-f0-9]{40}$/u;

interface ReplayObservation {
  readonly id: string;
  readonly stimulusSaid: string;
  readonly observation: unknown;
  readonly rawObservationSaid: string;
  readonly cleanupReceiptSaid: string;
  readonly verdict: 'Pass';
}

interface ReplayDocument {
  readonly version: 1;
  readonly kind: 'SuccessorPublicReplay';
  readonly h0Said: string;
  readonly sourceInventorySaid: string;
  readonly arm: 'C1' | 'C2' | 'C3';
  readonly h1Commit: string;
  readonly h1Tree: string;
  readonly configurationArtifactSaid: string;
  readonly behavior: SuccessorBehaviorProof;
  readonly reviewedImplementationSaid?: string;
  readonly capturedSourceSaid: string;
  readonly reviewedRecipeSaid: string;
  readonly toolchainSaid: string;
  readonly containerProfileSaid: string;
  readonly publicCatalogueSaid: string;
  readonly executableSaid: string;
  readonly buildReceiptSaid: string;
  readonly buildCleanupReceiptSaid: string;
  readonly observations: readonly ReplayObservation[];
}

function canonicalJson(bytes: Uint8Array, maximum: number): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > maximum) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

function document(value: unknown): value is ReplayDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ReplayDocument>;
  return (
    candidate.version === 1 &&
    candidate.kind === 'SuccessorPublicReplay' &&
    (candidate.arm === 'C1' || candidate.arm === 'C2' || candidate.arm === 'C3') &&
    typeof candidate.h0Said === 'string' &&
    typeof candidate.sourceInventorySaid === 'string' &&
    typeof candidate.h1Commit === 'string' &&
    typeof candidate.h1Tree === 'string' &&
    typeof candidate.configurationArtifactSaid === 'string' &&
    typeof candidate.behavior === 'object' &&
    typeof candidate.capturedSourceSaid === 'string' &&
    typeof candidate.reviewedRecipeSaid === 'string' &&
    typeof candidate.toolchainSaid === 'string' &&
    typeof candidate.containerProfileSaid === 'string' &&
    typeof candidate.publicCatalogueSaid === 'string' &&
    typeof candidate.executableSaid === 'string' &&
    typeof candidate.buildReceiptSaid === 'string' &&
    typeof candidate.buildCleanupReceiptSaid === 'string' &&
    Array.isArray(candidate.observations) &&
    Object.keys(value).sort().join(',') ===
      (candidate.arm === 'C1'
        ? 'arm,behavior,buildCleanupReceiptSaid,buildReceiptSaid,capturedSourceSaid,configurationArtifactSaid,containerProfileSaid,executableSaid,h0Said,h1Commit,h1Tree,kind,observations,publicCatalogueSaid,reviewedRecipeSaid,sourceInventorySaid,toolchainSaid,version'
        : 'arm,behavior,buildCleanupReceiptSaid,buildReceiptSaid,capturedSourceSaid,configurationArtifactSaid,containerProfileSaid,executableSaid,h0Said,h1Commit,h1Tree,kind,observations,publicCatalogueSaid,reviewedImplementationSaid,reviewedRecipeSaid,sourceInventorySaid,toolchainSaid,version')
  );
}

function exactBehavior(
  arm: ReplayDocument['arm'],
  h0Said: string,
  proof: SuccessorBehaviorProof,
): boolean {
  if (proof.hypothesisSaid !== h0Said) return false;
  if (arm === 'C1')
    return (
      proof.kind === 'C1Instruction' &&
      /^sha256:[a-f0-9]{64}$/u.test(proof.augmentedPromptDigest) &&
      Object.keys(proof).sort().join(',') === 'augmentedPromptDigest,hypothesisSaid,kind'
    );
  if (arm === 'C2')
    return (
      proof.kind === 'C2Workflow' &&
      said.test(proof.sourceEpisodeSaid) &&
      said.test(proof.readReceiptSaid) &&
      proof.action.trim().length > 0 &&
      proof.action.length <= 4096 &&
      Object.keys(proof).sort().join(',') ===
        'action,hypothesisSaid,kind,readReceiptSaid,sourceEpisodeSaid'
    );
  return (
    proof.kind === 'C3ContextSelection' &&
    proof.includedSourceIds.length > 0 &&
    proof.includedSourceIds.length <= 8 &&
    proof.includedSourceIds.every((id) => said.test(id)) &&
    /^sha256:[a-f0-9]{64}$/u.test(proof.contextDigest) &&
    Object.keys(proof).sort().join(',') === 'contextDigest,hypothesisSaid,includedSourceIds,kind'
  );
}

export interface ParentSuccessorPublicReplayInput {
  readonly custody: Pick<SuccessorReplayReceiptCustody, 'read'>;
  /** ExecutableCustody.open verifies the frozen bytes and source/recipe/toolchain metadata. */
  readonly executables: { open(executableSaid: string): Promise<string | undefined> };
  readonly conditions: EvaluationVerifierBundleInput['publicConditions'];
  readonly h1Commit: string;
  readonly h1Tree: string;
  readonly capturedSourceSaid: string;
  readonly reviewedRecipeSaid: string;
  readonly toolchainSaid: string;
  readonly containerProfileSaid: string;
}

/** Exact private receipt/raw custody plus public oracle, never a raw self-assertion. */
export class ParentSuccessorPublicReplay implements SuccessorPublicReplay {
  readonly #input: ParentSuccessorPublicReplayInput;

  constructor(input: ParentSuccessorPublicReplayInput) {
    this.#input = input;
  }

  async verify(
    request: Parameters<SuccessorPublicReplay['verify']>[0],
  ): ReturnType<SuccessorPublicReplay['verify']> {
    const context = this.#input;
    const catalogue = prepareEvidenceArtifact(
      Buffer.from(JSON.stringify(context.conditions)),
      'application/json',
    );
    if (
      catalogue.kind !== 'Prepared' ||
      ![
        request.h0Said,
        request.sourceInventorySaid,
        request.successorRevisionSaid,
        request.configurationArtifactSaid,
        request.receiptArtifactSaid,
        context.capturedSourceSaid,
        context.reviewedRecipeSaid,
        context.toolchainSaid,
        context.containerProfileSaid,
      ].every((value) => said.test(value)) ||
      (request.reviewedImplementationSaid !== undefined &&
        !said.test(request.reviewedImplementationSaid)) ||
      !sha1.test(context.h1Commit) ||
      !sha1.test(context.h1Tree)
    )
      return { kind: 'Rejected' };
    try {
      const held = await context.custody.read(request.receiptArtifactSaid);
      if (
        held.kind !== 'Read' ||
        held.artifact.d !== request.receiptArtifactSaid ||
        held.artifact.mediaType !== 'application/json' ||
        decodeEvidenceArtifact(held.artifact, held.bytes).kind !== 'Accepted' ||
        !Buffer.from(held.bytes).equals(Buffer.from(request.receiptBytes))
      )
        return { kind: 'Rejected' };
      const parsed = canonicalJson(held.bytes, 32 * 1024);
      if (
        !document(parsed) ||
        parsed.h0Said !== request.h0Said ||
        parsed.sourceInventorySaid !== request.sourceInventorySaid ||
        parsed.arm !== request.arm ||
        parsed.h1Commit !== context.h1Commit ||
        parsed.h1Tree !== context.h1Tree ||
        parsed.configurationArtifactSaid !== request.configurationArtifactSaid ||
        !exactBehavior(parsed.arm, parsed.h0Said, parsed.behavior) ||
        parsed.reviewedImplementationSaid !== request.reviewedImplementationSaid ||
        parsed.capturedSourceSaid !== context.capturedSourceSaid ||
        parsed.reviewedRecipeSaid !== context.reviewedRecipeSaid ||
        parsed.toolchainSaid !== context.toolchainSaid ||
        parsed.containerProfileSaid !== context.containerProfileSaid ||
        parsed.publicCatalogueSaid !== catalogue.artifact.d ||
        ![parsed.executableSaid, parsed.buildReceiptSaid, parsed.buildCleanupReceiptSaid].every(
          (value) => said.test(value),
        ) ||
        parsed.observations.length !== context.conditions.length
      )
        return { kind: 'Rejected' };
      if ((await context.executables.open(parsed.executableSaid)) === undefined)
        return { kind: 'Rejected' };
      const build = await context.custody.read(parsed.buildReceiptSaid);
      const buildCleanup = await context.custody.read(parsed.buildCleanupReceiptSaid);
      if (
        build.kind !== 'Read' ||
        buildCleanup.kind !== 'Read' ||
        build.artifact.d !== parsed.buildReceiptSaid ||
        buildCleanup.artifact.d !== parsed.buildCleanupReceiptSaid ||
        decodeEvidenceArtifact(build.artifact, build.bytes).kind !== 'Accepted' ||
        decodeEvidenceArtifact(buildCleanup.artifact, buildCleanup.bytes).kind !== 'Accepted'
      )
        return { kind: 'Rejected' };
      const buildRecord = canonicalJson(build.bytes, 64 * 1024);
      const buildClosed = canonicalJson(buildCleanup.bytes, 8 * 1024);
      if (
        typeof buildRecord !== 'object' ||
        buildRecord === null ||
        !('sourceSaid' in buildRecord) ||
        buildRecord.sourceSaid !== parsed.capturedSourceSaid ||
        !('recipeSaid' in buildRecord) ||
        buildRecord.recipeSaid !== parsed.reviewedRecipeSaid ||
        !('toolchainSaid' in buildRecord) ||
        buildRecord.toolchainSaid !== parsed.toolchainSaid ||
        !('exitCode' in buildRecord) ||
        buildRecord.exitCode !== 0 ||
        typeof buildClosed !== 'object' ||
        buildClosed === null ||
        !('buildReceiptSaid' in buildClosed) ||
        buildClosed.buildReceiptSaid !== parsed.buildReceiptSaid ||
        !('stopped' in buildClosed) ||
        buildClosed.stopped !== true
      )
        return { kind: 'Rejected' };
      for (const [index, acceptedEntry] of parsed.observations.entries()) {
        const entry: unknown = acceptedEntry;
        const condition = context.conditions[index];
        if (
          condition === undefined ||
          typeof entry !== 'object' ||
          entry === null ||
          !('id' in entry) ||
          !('verdict' in entry) ||
          !('stimulusSaid' in entry) ||
          !('rawObservationSaid' in entry) ||
          !('cleanupReceiptSaid' in entry) ||
          !('observation' in entry) ||
          typeof entry.stimulusSaid !== 'string' ||
          typeof entry.rawObservationSaid !== 'string' ||
          typeof entry.cleanupReceiptSaid !== 'string' ||
          entry.id !== condition.id ||
          entry.verdict !== 'Pass' ||
          Object.keys(entry).sort().join(',') !==
            'cleanupReceiptSaid,id,observation,rawObservationSaid,stimulusSaid,verdict' ||
          ![entry.stimulusSaid, entry.rawObservationSaid, entry.cleanupReceiptSaid].every((value) =>
            said.test(value),
          ) ||
          observedPublicCase(condition.expected, entry.observation) !== true
        )
          return { kind: 'Rejected' };
        const stimulus = prepareEvidenceArtifact(
          Buffer.from(condition.stimulusBase64Url, 'base64url'),
          'text/plain; charset=utf-8',
        );
        if (stimulus.kind !== 'Prepared' || stimulus.artifact.d !== entry.stimulusSaid)
          return { kind: 'Rejected' };
        const raw = await context.custody.read(entry.rawObservationSaid);
        const cleanup = await context.custody.read(entry.cleanupReceiptSaid);
        if (
          raw.kind !== 'Read' ||
          cleanup.kind !== 'Read' ||
          decodeEvidenceArtifact(raw.artifact, raw.bytes).kind !== 'Accepted' ||
          decodeEvidenceArtifact(cleanup.artifact, cleanup.bytes).kind !== 'Accepted' ||
          raw.artifact.d !== entry.rawObservationSaid ||
          cleanup.artifact.d !== entry.cleanupReceiptSaid
        )
          return { kind: 'Rejected' };
        const rawRecord = canonicalJson(raw.bytes, 64 * 1024);
        const closedRecord = canonicalJson(cleanup.bytes, 8 * 1024);
        if (
          typeof rawRecord !== 'object' ||
          rawRecord === null ||
          !('caseScope' in rawRecord) ||
          rawRecord.caseScope !== 'Public' ||
          !('executableSaid' in rawRecord) ||
          rawRecord.executableSaid !== parsed.executableSaid ||
          !('stimulusSaid' in rawRecord) ||
          rawRecord.stimulusSaid !== entry.stimulusSaid ||
          !('observation' in rawRecord) ||
          !isDeepStrictEqual(rawRecord.observation, entry.observation) ||
          typeof closedRecord !== 'object' ||
          closedRecord === null ||
          !('rawObservationSaid' in closedRecord) ||
          closedRecord.rawObservationSaid !== entry.rawObservationSaid ||
          !('stopped' in closedRecord) ||
          closedRecord.stopped !== true
        )
          return { kind: 'Rejected' };
      }
      return {
        kind: 'Confirmed',
        h0Said: request.h0Said,
        sourceInventorySaid: request.sourceInventorySaid,
        arm: request.arm,
        successorRevisionSaid: request.successorRevisionSaid,
        configurationArtifactSaid: request.configurationArtifactSaid,
        reviewedImplementationSaid: request.reviewedImplementationSaid,
        receiptArtifactSaid: request.receiptArtifactSaid,
      };
    } catch {
      return { kind: 'Rejected' };
    }
  }
}
