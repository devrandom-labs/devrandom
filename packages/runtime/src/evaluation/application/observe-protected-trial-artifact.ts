import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import type { EvaluationExecutionBinding, EvaluationLeaseReceipt } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  cesrVerifierObservationSchema,
  decodeEvaluationEvidenceEvent,
  decodeEvaluationVerifierBundleBytes,
  prepareEvidenceArtifact,
  type EvaluationManifest,
  type EvaluationEvidenceEvent,
  type EvaluationVerifierBundle,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  ProtectedCaseCustody,
  ReceiptObservation,
  TaskArtifactConstruction,
  TrialExecution,
} from './evaluation-conversations.js';
import type { ProtectedTrialInput } from './run-protected-trial.js';
import { assessProtectedCesrCase } from './assess-protected-cesr-case.js';
import { runProtectedTrial } from './run-protected-trial.js';

/** Exact parent-only verifier bundle custody, scoped by the acknowledged manifest. */
export interface EvaluationCaseInventory {
  open(
    manifest: EvaluationManifest,
  ): Promise<
    | { readonly kind: 'Opened'; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

/** Verified hosted M lock, including the active lease that authorizes this trial. */
export interface EvaluationManifestLock {
  inspect(input: Pick<ProtectedTrialInput, 'manifest' | 'lease'>): Promise<
    | {
        readonly kind: 'Acknowledged';
        readonly evaluationId: string;
        readonly manifestSaid: string;
        readonly ownerAid: string;
        readonly policySaid: string;
        readonly leaseId: string;
        readonly leaseVersion: number;
        readonly acknowledgementSaid: string;
      }
    | { readonly kind: 'Unlocked' | 'Unavailable' }
  >;
}

/** The parent checks the reviewed adapter bytes it will actually invoke. */
export interface ReviewedReceiptOracle {
  inspect(): Promise<
    { readonly kind: 'Reviewed'; readonly digest: string } | { readonly kind: 'Unavailable' }
  >;
}

/**
 * Trusted-parent custody conversation. The M lock already retains the first two
 * ciphertexts. The adapter checks that lock, retains only the new observation,
 * and acknowledges its one Trial ArtifactCaptured event at the stopped head.
 * A lost lock read or batch acknowledgement is Unavailable, never Acknowledged.
 */
export interface EvaluationProtectedArtifacts {
  retain(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly lease: EvaluationLeaseReceipt;
    readonly expectedHeadSaid: string;
    readonly artifacts: readonly [
      ProtectedEvaluationArtifact,
      ProtectedEvaluationArtifact,
      ProtectedEvaluationArtifact,
    ];
  }): Promise<
    | {
        readonly kind: 'Acknowledged';
        readonly artifactSaids: readonly string[];
        /** The one accepted Trial ArtifactCaptured event for the new observation only. */
        readonly event: EvaluationEvidenceEvent;
        readonly throughSequence: number;
        readonly headSaid: string;
      }
    | { readonly kind: 'Conflict' | 'LeaseLost' | 'Unavailable' }
  >;
}

export interface ProtectedTrialArtifactDependencies {
  readonly lock: EvaluationManifestLock;
  readonly cases: EvaluationCaseInventory;
  readonly oracle: ReviewedReceiptOracle;
  readonly execution: TrialExecution;
  readonly construction: TaskArtifactConstruction;
  readonly observation: ReceiptObservation;
  readonly custody: ProtectedCaseCustody;
  readonly protectedArtifacts: EvaluationProtectedArtifacts;
}

type FrozenArtifact = Extract<
  Awaited<ReturnType<TaskArtifactConstruction['build']>>,
  { kind: 'Frozen' }
>;

export type ProtectedTrialArtifactObservation =
  | {
      readonly kind: 'Incomplete';
      readonly frontier:
        | 'CaseInventory'
        | 'ManifestLock'
        | 'OracleIdentity'
        | 'TrialExecution'
        | 'ArtifactConstruction'
        | 'PublicObservation'
        | 'ProtectedObservation'
        | 'ProtectedCustody';
      /** This proof can survive a later custody failure; it is not a retained trial verdict. */
      readonly frozenArtifact?: FrozenArtifact;
    }
  | {
      readonly kind: 'Retained';
      readonly capturedSourceSaid: string;
      readonly trialEvidenceHeadSaid: string;
      readonly trialCleanupReceiptSaid: string;
      readonly providerUsageEventSaids: readonly string[];
      readonly frozenArtifact: FrozenArtifact;
      readonly publicCases: readonly {
        readonly id: string;
        readonly verdict: 'Pass' | 'Fail';
        readonly rawObservationSaid: string;
        readonly cleanupReceiptSaid: string;
      }[];
      readonly protectedVerdict: 'Pass' | 'Fail';
      readonly protectedObservationSaid: string;
      readonly protectedCleanupReceiptSaid: string;
      readonly acknowledgedArtifactSaids: readonly [string, string, string];
      readonly custodyEvidenceHeadSaid: string;
      readonly custodyEvidenceSequence: number;
    };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function observedPublicCase(
  expected: EvaluationVerifierBundle['publicConditions'][number]['expected'],
  actual: unknown,
): boolean | undefined {
  if (!Value.Check(cesrVerifierObservationSchema, actual)) return undefined;
  if (actual.kind === 'Rejected' && actual.error === 'AnyRejection') return undefined;
  if (expected.kind === 'Rejected' && expected.error === 'AnyRejection')
    return actual.kind === 'Rejected';
  if (expected.kind === 'Rejected')
    return actual.kind === 'Rejected' && actual.error === expected.error;
  if (actual.kind !== 'Parsed') return false;
  return (
    expected.receipts.length === actual.receipts.length &&
    expected.receipts.every((receipt, index) => {
      const corresponding = actual.receipts[index];
      return (
        corresponding !== undefined &&
        receipt.version === corresponding.version &&
        receipt.payload === corresponding.payload
      );
    })
  );
}

export type PublicTrialArtifactObservation =
  | Extract<ProtectedTrialArtifactObservation, { kind: 'Incomplete' }>
  | ({
      readonly kind: 'PublicObserved';
      readonly manifestSaid: string;
      readonly binding: EvaluationExecutionBinding;
    } & Pick<
      Extract<ProtectedTrialArtifactObservation, { kind: 'Retained' }>,
      | 'capturedSourceSaid'
      | 'trialEvidenceHeadSaid'
      | 'trialCleanupReceiptSaid'
      | 'providerUsageEventSaids'
      | 'frozenArtifact'
      | 'publicCases'
    >);

/** Single-attempt convenience; search controls must freeze both public observations first. */
export async function observeProtectedTrialArtifact(
  input: ProtectedTrialInput,
  dependencies: ProtectedTrialArtifactDependencies,
): Promise<ProtectedTrialArtifactObservation> {
  if (input.binding.phase.kind === 'Trial' && input.binding.phase.arm === 'H1TaskSearch')
    return { kind: 'Incomplete', frontier: 'PublicObservation' };
  const observed = await observePublicTrialArtifact(input, dependencies);
  if (observed.kind !== 'PublicObserved') return observed;
  return gradePublicTrialArtifact(
    { ...input, publicObservation: observed, expectedHeadSaid: observed.trialEvidenceHeadSaid },
    dependencies,
  );
}

async function inspectTrialBasis(
  input: ProtectedTrialInput,
  dependencies: ProtectedTrialArtifactDependencies,
): Promise<
  | { readonly kind: 'Bound'; readonly bundle: EvaluationVerifierBundle }
  | Extract<ProtectedTrialArtifactObservation, { kind: 'Incomplete' }>
> {
  if (interrupted(input.signal)) return { kind: 'Incomplete', frontier: 'TrialExecution' };
  try {
    const lock = await dependencies.lock.inspect({ manifest: input.manifest, lease: input.lease });
    if (
      lock.kind !== 'Acknowledged' ||
      lock.evaluationId !== input.manifest.evaluationId ||
      lock.manifestSaid !== input.manifest.d ||
      lock.ownerAid !== input.manifest.ownerAid ||
      lock.policySaid !== input.manifest.policySaid ||
      lock.leaseId !== input.lease.leaseId ||
      lock.leaseVersion !== input.lease.version ||
      !said.test(lock.acknowledgementSaid)
    )
      return { kind: 'Incomplete', frontier: 'ManifestLock' };
  } catch {
    return { kind: 'Incomplete', frontier: 'ManifestLock' };
  }
  let bundle: EvaluationVerifierBundle;
  try {
    const opened = await dependencies.cases.open(input.manifest);
    if (opened.kind !== 'Opened') return { kind: 'Incomplete', frontier: 'CaseInventory' };
    const decoded = decodeEvaluationVerifierBundleBytes(opened.bytes);
    if (
      decoded.kind !== 'Accepted' ||
      bindEvaluationVerifierBundle(decoded.bundle, input.manifest).kind !== 'Bound'
    )
      return { kind: 'Incomplete', frontier: 'CaseInventory' };
    bundle = decoded.bundle;
  } catch {
    return { kind: 'Incomplete', frontier: 'CaseInventory' };
  }
  try {
    const reviewed = await dependencies.oracle.inspect();
    if (reviewed.kind !== 'Reviewed' || reviewed.digest !== bundle.oracleAdapterDigest)
      return { kind: 'Incomplete', frontier: 'OracleIdentity' };
  } catch {
    return { kind: 'Incomplete', frontier: 'OracleIdentity' };
  }
  return { kind: 'Bound', bundle };
}

/** Stops and freezes the task artifact, then observes only disclosed public conditions. */
export async function observePublicTrialArtifact(
  input: ProtectedTrialInput,
  dependencies: ProtectedTrialArtifactDependencies,
): Promise<PublicTrialArtifactObservation> {
  const basis = await inspectTrialBasis(input, dependencies);
  if (basis.kind !== 'Bound') return basis;
  const { bundle } = basis;
  const invoked = await runProtectedTrial(input, dependencies.execution);
  if (invoked.kind !== 'Executed' || invoked.observation.kind !== 'Stopped')
    return { kind: 'Incomplete', frontier: 'TrialExecution' };
  const stopped = invoked.observation;
  if (
    !said.test(stopped.capturedSourceSaid) ||
    !said.test(stopped.evidenceHeadSaid) ||
    !said.test(stopped.cleanupReceiptSaid) ||
    !stopped.providerUsageEventSaids.every((usage) => said.test(usage))
  )
    return { kind: 'Incomplete', frontier: 'TrialExecution' };
  const observed = await observePublicSourceArtifact(
    {
      manifest: input.manifest,
      bundle,
      capturedSourceSaid: stopped.capturedSourceSaid,
      signal: input.signal,
    },
    dependencies,
  );
  if (observed.kind !== 'PublicObserved') return observed;
  return {
    kind: 'PublicObserved',
    manifestSaid: input.manifest.d,
    binding: structuredClone(input.binding),
    capturedSourceSaid: stopped.capturedSourceSaid,
    trialEvidenceHeadSaid: stopped.evidenceHeadSaid,
    trialCleanupReceiptSaid: stopped.cleanupReceiptSaid,
    providerUsageEventSaids: [...stopped.providerUsageEventSaids],
    frozenArtifact: observed.frozenArtifact,
    publicCases: observed.publicCases,
  };
}

/** Reuses the immutable original public cases for an in-trial submission snapshot. */
export async function observePublicSourceArtifact(
  input: {
    readonly manifest: EvaluationManifest;
    readonly bundle: EvaluationVerifierBundle;
    readonly capturedSourceSaid: string;
    readonly signal: AbortSignal;
  },
  dependencies: Pick<ProtectedTrialArtifactDependencies, 'construction' | 'observation'>,
): Promise<
  | Extract<PublicTrialArtifactObservation, { kind: 'Incomplete' }>
  | ({ readonly kind: 'PublicObserved' } & Pick<
      Extract<PublicTrialArtifactObservation, { kind: 'PublicObserved' }>,
      'frozenArtifact' | 'publicCases'
    >)
> {
  if (
    bindEvaluationVerifierBundle(input.bundle, input.manifest).kind !== 'Bound' ||
    !said.test(input.capturedSourceSaid)
  )
    return { kind: 'Incomplete', frontier: 'CaseInventory' };
  const bundle = input.bundle;
  let built: Awaited<ReturnType<TaskArtifactConstruction['build']>>;
  try {
    built = await dependencies.construction.build({
      capturedSourceSaid: input.capturedSourceSaid,
      reviewedRecipeSaid: bundle.reviewedRecipeSaid,
      toolchainSaid: bundle.toolchainSaid,
      containerProfileSaid: input.manifest.executionProfileSaid,
      signal: input.signal,
    });
  } catch {
    return { kind: 'Incomplete', frontier: 'ArtifactConstruction' };
  }
  if (
    built.kind !== 'Frozen' ||
    built.sourceSaid !== input.capturedSourceSaid ||
    !said.test(built.executableSaid) ||
    !said.test(built.buildReceiptSaid) ||
    !said.test(built.cleanupReceiptSaid)
  )
    return { kind: 'Incomplete', frontier: 'ArtifactConstruction' };
  const publicCases: {
    id: string;
    verdict: 'Pass' | 'Fail';
    rawObservationSaid: string;
    cleanupReceiptSaid: string;
  }[] = [];
  for (const condition of bundle.publicConditions) {
    if (interrupted(input.signal))
      return { kind: 'Incomplete', frontier: 'PublicObservation', frozenArtifact: built };
    const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
    const prepared = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared')
      return { kind: 'Incomplete', frontier: 'PublicObservation', frozenArtifact: built };
    let observed: Awaited<ReturnType<ReceiptObservation['observe']>>;
    try {
      observed = await dependencies.observation.observe({
        executableSaid: built.executableSaid,
        stimulus,
        stimulusSaid: prepared.artifact.d,
        caseScope: 'Public',
        signal: input.signal,
      });
    } catch {
      return { kind: 'Incomplete', frontier: 'PublicObservation', frozenArtifact: built };
    }
    if (
      observed.kind !== 'Observed' ||
      observed.executableSaid !== built.executableSaid ||
      observed.protectedObservation !== undefined ||
      !said.test(observed.rawObservationSaid) ||
      !said.test(observed.cleanupReceiptSaid)
    )
      return { kind: 'Incomplete', frontier: 'PublicObservation', frozenArtifact: built };
    const passed = observedPublicCase(condition.expected, observed.observation);
    if (passed === undefined)
      return { kind: 'Incomplete', frontier: 'PublicObservation', frozenArtifact: built };
    publicCases.push({
      id: condition.id,
      verdict: passed ? 'Pass' : 'Fail',
      rawObservationSaid: observed.rawObservationSaid,
      cleanupReceiptSaid: observed.cleanupReceiptSaid,
    });
  }
  return { kind: 'PublicObserved', frozenArtifact: built, publicCases };
}

/** Grade exact frozen bytes after the trusted caller has durably selected any search control. */
export async function gradePublicTrialArtifact(
  input: ProtectedTrialInput & {
    readonly publicObservation: Extract<PublicTrialArtifactObservation, { kind: 'PublicObserved' }>;
    readonly expectedHeadSaid: string;
  },
  dependencies: ProtectedTrialArtifactDependencies,
): Promise<ProtectedTrialArtifactObservation> {
  const basis = await inspectTrialBasis(input, dependencies);
  if (basis.kind !== 'Bound') return basis;
  const { bundle } = basis;
  const observed = input.publicObservation;
  const built = observed.frozenArtifact;
  const publicCases = observed.publicCases;
  if (
    observed.manifestSaid !== input.manifest.d ||
    !isDeepStrictEqual(observed.binding, input.binding) ||
    built.sourceSaid !== observed.capturedSourceSaid ||
    !said.test(input.expectedHeadSaid) ||
    !isDeepStrictEqual(
      publicCases.map((item) => item.id),
      input.manifest.publicConditionIds,
    )
  )
    return { kind: 'Incomplete', frontier: 'PublicObservation' };
  const protectedCase = bundle.protectedCase;
  const assessed = await assessProtectedCesrCase(
    {
      evaluationId: input.manifest.evaluationId,
      objectSaid: protectedCase.objectSaid,
      segment: 0,
      executableSaid: built.executableSaid,
      stimulusArtifact: protectedCase.stimulus,
      expectedArtifact: protectedCase.expected,
      signal: input.signal,
    },
    dependencies.custody,
    dependencies.observation,
  );
  if (assessed.kind !== 'Assessed')
    return { kind: 'Incomplete', frontier: 'ProtectedObservation', frozenArtifact: built };
  const expectedSaids = [
    protectedCase.stimulus.d,
    protectedCase.expected.d,
    assessed.observationArtifact.d,
  ] as const;
  let acknowledged: Extract<
    Awaited<ReturnType<EvaluationProtectedArtifacts['retain']>>,
    { kind: 'Acknowledged' }
  >;
  try {
    const retained = await dependencies.protectedArtifacts.retain({
      binding: input.binding,
      manifest: input.manifest,
      lease: input.lease,
      expectedHeadSaid: input.expectedHeadSaid,
      artifacts: [protectedCase.stimulus, protectedCase.expected, assessed.observationArtifact],
    });
    if (
      retained.kind !== 'Acknowledged' ||
      retained.artifactSaids.length !== 3 ||
      retained.artifactSaids.some((item, index) => item !== expectedSaids[index]) ||
      decodeEvaluationEvidenceEvent(retained.event).kind !== 'Accepted' ||
      retained.event.sequence !== retained.throughSequence ||
      retained.event.d !== retained.headSaid ||
      retained.event.previous.kind !== 'Previous' ||
      retained.event.previous.eventSaid !== input.expectedHeadSaid ||
      retained.event.evaluationId !== input.binding.evaluationId ||
      retained.event.streamId !== input.binding.evidenceStreamId ||
      retained.event.originRunId !== input.binding.originRunId ||
      retained.event.taskId !== input.binding.taskId ||
      retained.event.taskRevisionSaid !== input.binding.taskRevisionSaid ||
      retained.event.personalAgentAid !== input.binding.personalAgentAid ||
      retained.event.taskMandateSaid !== input.binding.taskMandateSaid ||
      retained.event.harnessRevisionSaid !== input.binding.harnessRevisionSaid ||
      JSON.stringify(retained.event.phase) !== JSON.stringify(input.binding.phase) ||
      retained.event.detail.kind !== 'ArtifactCaptured' ||
      retained.event.detail.custody !== 'ProtectedCiphertext' ||
      retained.event.detail.artifactSaid !== assessed.observationArtifact.d
    )
      return { kind: 'Incomplete', frontier: 'ProtectedCustody', frozenArtifact: built };
    acknowledged = retained;
  } catch {
    return { kind: 'Incomplete', frontier: 'ProtectedCustody', frozenArtifact: built };
  }
  return {
    kind: 'Retained',
    capturedSourceSaid: observed.capturedSourceSaid,
    trialEvidenceHeadSaid: observed.trialEvidenceHeadSaid,
    trialCleanupReceiptSaid: observed.trialCleanupReceiptSaid,
    providerUsageEventSaids: observed.providerUsageEventSaids,
    frozenArtifact: built,
    publicCases,
    protectedVerdict: assessed.verdict,
    protectedObservationSaid: assessed.observationArtifact.d,
    protectedCleanupReceiptSaid: assessed.cleanupReceiptSaid,
    acknowledgedArtifactSaids: expectedSaids,
    custodyEvidenceHeadSaid: acknowledged.headSaid,
    custodyEvidenceSequence: acknowledged.throughSequence,
  };
}
