import { Buffer } from 'node:buffer';
import {
  bindEvaluationVerifierBundle,
  cesrVerifierObservationSchema,
  decodeEvaluationVerifierBundleBytes,
  prepareEvidenceArtifact,
  type EvaluationManifest,
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

/** Exact hosted/private custody acknowledgement before a protected result is durable. */
export interface EvaluationProtectedArtifacts {
  retain(input: {
    readonly evaluationId: string;
    readonly artifacts: readonly [
      ProtectedEvaluationArtifact,
      ProtectedEvaluationArtifact,
      ProtectedEvaluationArtifact,
    ];
  }): Promise<
    | { readonly kind: 'Acknowledged'; readonly artifactSaids: readonly string[] }
    | { readonly kind: 'Conflict' | 'Unavailable' }
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
    };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function observedPublicCase(
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

/** E3's parent-only stopped source -> frozen executable -> verifier conversation. */
export async function observeProtectedTrialArtifact(
  input: ProtectedTrialInput,
  dependencies: ProtectedTrialArtifactDependencies,
): Promise<ProtectedTrialArtifactObservation> {
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
  let built: Awaited<ReturnType<TaskArtifactConstruction['build']>>;
  try {
    built = await dependencies.construction.build({
      capturedSourceSaid: stopped.capturedSourceSaid,
      reviewedRecipeSaid: bundle.reviewedRecipeSaid,
      toolchainSaid: bundle.toolchainSaid,
      containerProfileSaid: input.containerProfileSaid,
      signal: input.signal,
    });
  } catch {
    return { kind: 'Incomplete', frontier: 'ArtifactConstruction' };
  }
  if (
    built.kind !== 'Frozen' ||
    built.sourceSaid !== stopped.capturedSourceSaid ||
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
  try {
    const retained = await dependencies.protectedArtifacts.retain({
      evaluationId: input.manifest.evaluationId,
      artifacts: [protectedCase.stimulus, protectedCase.expected, assessed.observationArtifact],
    });
    if (
      retained.kind !== 'Acknowledged' ||
      retained.artifactSaids.length !== 3 ||
      retained.artifactSaids.some((item, index) => item !== expectedSaids[index])
    )
      return { kind: 'Incomplete', frontier: 'ProtectedCustody', frozenArtifact: built };
  } catch {
    return { kind: 'Incomplete', frontier: 'ProtectedCustody', frozenArtifact: built };
  }
  return {
    kind: 'Retained',
    capturedSourceSaid: stopped.capturedSourceSaid,
    trialEvidenceHeadSaid: stopped.evidenceHeadSaid,
    trialCleanupReceiptSaid: stopped.cleanupReceiptSaid,
    providerUsageEventSaids: stopped.providerUsageEventSaids,
    frozenArtifact: built,
    publicCases,
    protectedVerdict: assessed.verdict,
    protectedObservationSaid: assessed.observationArtifact.d,
    protectedCleanupReceiptSaid: assessed.cleanupReceiptSaid,
    acknowledgedArtifactSaids: expectedSaids,
  };
}
