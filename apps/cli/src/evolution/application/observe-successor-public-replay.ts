import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationVerifierBundleInput,
} from '@devrandom/protocol';
import {
  observedPublicCase,
  type ExactTreatmentArtifact,
  type ReceiptObservation,
  type TaskArtifactConstruction,
} from '@devrandom/runtime';
import { isDeepStrictEqual } from 'node:util';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const sha1 = /^[a-f0-9]{40}$/u;

export interface SuccessorPublicReplayInput {
  readonly h0Said: string;
  readonly sourceInventorySaid: string;
  readonly arm: 'C1' | 'C2' | 'C3';
  readonly h1Commit: string;
  readonly h1Tree: string;
  readonly sourceDirectory: string;
  readonly configurationArtifactSaid: string;
  readonly reviewedImplementationSaid?: string;
  readonly configuration: ExactTreatmentArtifact;
  readonly implementation?: ExactTreatmentArtifact;
  readonly capturedSourceSaid: string;
  readonly reviewedRecipeSaid: string;
  readonly toolchainSaid: string;
  readonly containerProfileSaid: string;
  readonly publicConditions: EvaluationVerifierBundleInput['publicConditions'];
  readonly signal: AbortSignal;
}

export type SuccessorBehaviorProof =
  | {
      readonly kind: 'C1Instruction';
      readonly hypothesisSaid: string;
      readonly augmentedPromptDigest: string;
    }
  | {
      readonly kind: 'C2Workflow';
      readonly hypothesisSaid: string;
      readonly sourceEpisodeSaid: string;
      readonly readReceiptSaid: string;
      readonly action: string;
    }
  | {
      readonly kind: 'C3ContextSelection';
      readonly hypothesisSaid: string;
      readonly includedSourceIds: readonly string[];
      readonly contextDigest: string;
    };

/** Candidate-specific trusted-parent public behavior invocation, not a worker claim. */
export interface SuccessorBehaviorReplay {
  replay(
    input: SuccessorPublicReplayInput,
  ): Promise<
    | { readonly kind: 'Replayed'; readonly proof: SuccessorBehaviorProof }
    | { readonly kind: 'Blocked' }
  >;
}

/** Private parent custody. Stored bytes are exact-read again before successor admission. */
export interface SuccessorReplayReceiptCustody {
  retain(input: {
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }): Promise<
    { readonly kind: 'Retained'; readonly artifactSaid: string } | { readonly kind: 'Unavailable' }
  >;
  read(
    artifactSaid: string,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

export type SuccessorPublicReplayObservation =
  | { readonly kind: 'Observed'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
  | {
      readonly kind: 'Blocked';
      readonly gate:
        'Binding' | 'Catalogue' | 'TreatmentReplay' | 'Build' | 'PublicObservation' | 'Custody';
    };

function validInput(input: SuccessorPublicReplayInput): boolean {
  if (
    ![
      input.h0Said,
      input.sourceInventorySaid,
      input.configurationArtifactSaid,
      input.capturedSourceSaid,
      input.reviewedRecipeSaid,
      input.toolchainSaid,
      input.containerProfileSaid,
    ].every((value) => said.test(value)) ||
    !sha1.test(input.h1Commit) ||
    !sha1.test(input.h1Tree) ||
    (input.arm === 'C1') !== (input.reviewedImplementationSaid === undefined) ||
    (input.reviewedImplementationSaid !== undefined &&
      !said.test(input.reviewedImplementationSaid)) ||
    input.publicConditions.length === 0 ||
    input.publicConditions.length > 64 ||
    input.configuration.artifact.d !== input.configurationArtifactSaid ||
    decodeEvidenceArtifact(input.configuration.artifact, input.configuration.bytes).kind !==
      'Accepted' ||
    (input.arm === 'C1') !== (input.implementation === undefined) ||
    (input.implementation !== undefined &&
      (input.implementation.artifact.d !== input.reviewedImplementationSaid ||
        decodeEvidenceArtifact(input.implementation.artifact, input.implementation.bytes).kind !==
          'Accepted')) ||
    input.signal.aborted
  )
    return false;
  const ids = new Set<string>();
  for (const condition of input.publicConditions) {
    const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
    if (
      ids.has(condition.id) ||
      stimulus.byteLength === 0 ||
      stimulus.byteLength > 32 * 1024 ||
      stimulus.toString('base64url') !== condition.stimulusBase64Url
    )
      return false;
    ids.add(condition.id);
  }
  return true;
}

/** Actual native public observations happen before any SAIDed successor revision exists. */
export async function observeSuccessorPublicReplay(
  input: SuccessorPublicReplayInput,
  ports: {
    readonly catalogue: {
      review(input: {
        readonly sourceDirectory: string;
        readonly sourceGitCommit: string;
        readonly sourceGitTree: string;
      }): Promise<
        | {
            readonly kind: 'Reviewed';
            readonly publicConditions: EvaluationVerifierBundleInput['publicConditions'];
          }
        | { readonly kind: 'SourceMismatch' | 'Unavailable' }
      >;
    };
    readonly behavior: SuccessorBehaviorReplay;
    readonly construction: TaskArtifactConstruction;
    readonly observation: ReceiptObservation;
    readonly custody: Pick<SuccessorReplayReceiptCustody, 'retain'>;
  },
): Promise<SuccessorPublicReplayObservation> {
  if (!validInput(input)) return { kind: 'Blocked', gate: 'Binding' };
  try {
    const catalogue = await ports.catalogue.review({
      sourceDirectory: input.sourceDirectory,
      sourceGitCommit: input.h1Commit,
      sourceGitTree: input.h1Tree,
    });
    if (
      catalogue.kind !== 'Reviewed' ||
      !isDeepStrictEqual(catalogue.publicConditions, input.publicConditions)
    )
      return { kind: 'Blocked', gate: 'Catalogue' };
    const behavior = await ports.behavior.replay(input);
    if (
      behavior.kind !== 'Replayed' ||
      behavior.proof.hypothesisSaid !== input.h0Said ||
      (input.arm === 'C1' && behavior.proof.kind !== 'C1Instruction') ||
      (input.arm === 'C2' && behavior.proof.kind !== 'C2Workflow') ||
      (input.arm === 'C3' && behavior.proof.kind !== 'C3ContextSelection')
    )
      return { kind: 'Blocked', gate: 'TreatmentReplay' };
    const built = await ports.construction.build({
      capturedSourceSaid: input.capturedSourceSaid,
      reviewedRecipeSaid: input.reviewedRecipeSaid,
      toolchainSaid: input.toolchainSaid,
      containerProfileSaid: input.containerProfileSaid,
      signal: input.signal,
    });
    if (
      built.kind !== 'Frozen' ||
      built.sourceSaid !== input.capturedSourceSaid ||
      ![built.executableSaid, built.buildReceiptSaid, built.cleanupReceiptSaid].every((value) =>
        said.test(value),
      )
    )
      return { kind: 'Blocked', gate: 'Build' };
    const observations: {
      readonly id: string;
      readonly stimulusSaid: string;
      readonly observation: Extract<
        Awaited<ReturnType<ReceiptObservation['observe']>>,
        { kind: 'Observed' }
      >['observation'];
      readonly rawObservationSaid: string;
      readonly cleanupReceiptSaid: string;
      readonly verdict: 'Pass' | 'Fail';
    }[] = [];
    for (const condition of input.publicConditions) {
      if (input.signal.aborted) return { kind: 'Blocked', gate: 'PublicObservation' };
      const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
      const prepared = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
      if (prepared.kind !== 'Prepared') return { kind: 'Blocked', gate: 'PublicObservation' };
      const observed = await ports.observation.observe({
        executableSaid: built.executableSaid,
        stimulus,
        stimulusSaid: prepared.artifact.d,
        caseScope: 'Public',
        signal: input.signal,
      });
      if (
        observed.kind !== 'Observed' ||
        observed.executableSaid !== built.executableSaid ||
        observed.protectedObservation !== undefined ||
        !said.test(observed.rawObservationSaid) ||
        !said.test(observed.cleanupReceiptSaid) ||
        observedPublicCase(condition.expected, observed.observation) === undefined
      )
        return { kind: 'Blocked', gate: 'PublicObservation' };
      observations.push({
        id: condition.id,
        stimulusSaid: prepared.artifact.d,
        observation: observed.observation,
        rawObservationSaid: observed.rawObservationSaid,
        cleanupReceiptSaid: observed.cleanupReceiptSaid,
        verdict:
          observedPublicCase(condition.expected, observed.observation) === true ? 'Pass' : 'Fail',
      });
    }
    const catalogueBytes = Buffer.from(JSON.stringify(input.publicConditions), 'utf8');
    const catalogueArtifact = prepareEvidenceArtifact(catalogueBytes, 'application/json');
    if (catalogueArtifact.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Binding' };
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'SuccessorPublicReplay',
        h0Said: input.h0Said,
        sourceInventorySaid: input.sourceInventorySaid,
        arm: input.arm,
        h1Commit: input.h1Commit,
        h1Tree: input.h1Tree,
        configurationArtifactSaid: input.configurationArtifactSaid,
        behavior: behavior.proof,
        ...(input.reviewedImplementationSaid === undefined
          ? {}
          : { reviewedImplementationSaid: input.reviewedImplementationSaid }),
        capturedSourceSaid: input.capturedSourceSaid,
        reviewedRecipeSaid: input.reviewedRecipeSaid,
        toolchainSaid: input.toolchainSaid,
        containerProfileSaid: input.containerProfileSaid,
        publicCatalogueSaid: catalogueArtifact.artifact.d,
        executableSaid: built.executableSaid,
        buildReceiptSaid: built.buildReceiptSaid,
        buildCleanupReceiptSaid: built.cleanupReceiptSaid,
        observations,
      }),
      'utf8',
    );
    const artifact = prepareEvidenceArtifact(bytes, 'application/json');
    if (artifact.kind !== 'Prepared' || bytes.byteLength > 32 * 1024)
      return { kind: 'Blocked', gate: 'Custody' };
    const retained = await ports.custody.retain({ artifact: artifact.artifact, bytes });
    if (retained.kind !== 'Retained' || retained.artifactSaid !== artifact.artifact.d)
      return { kind: 'Blocked', gate: 'Custody' };
    return { kind: 'Observed', artifact: artifact.artifact, bytes };
  } catch {
    return { kind: 'Blocked', gate: 'PublicObservation' };
  }
}
