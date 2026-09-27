import {
  decodeEvolutionHypothesis,
  decodeEvaluationExecutionProfile,
  decodeEvaluationPolicy,
  decodeEvaluationSourceInventory,
  decodeSuccessorHarnessRevision,
  encodeEvaluationVerifierBundle,
  prepareEvaluationManifest,
  type EvaluationPolicy,
  type EvaluationExecutionProfile,
  type EvaluationSourceInventory,
  type EvaluationVerifierBundleInput,
  type EvolutionHypothesis,
  type SuccessorHarnessRevision,
} from '@devrandom/protocol';
import { sealCesrComparisonCases, type ProtectedCaseCustody } from '@devrandom/runtime';

import type { RunQualification } from './harness-evaluation.js';
import type {
  HostedEvaluationAdmission,
  HostedEvaluationManifestLock,
} from '../infrastructure/server-evaluation-http.js';
import type {
  EvaluationManifestCommandFile,
  ManifestCommandInspection,
  ManifestCommandStaging,
} from '../infrastructure/evaluation-manifest-command-file.js';

type Qualified = Extract<Awaited<ReturnType<RunQualification['inspect']>>, { kind: 'Qualified' }>;
type Admitted = Extract<HostedEvaluationAdmission, { kind: 'Admitted' }>;
type Draft = Parameters<EvaluationManifestCommandFile['stage']>[0];
type Command = Extract<ManifestCommandStaging, { kind: 'Staged' }>['command'];

export interface CesrManifestBasis {
  readonly ownerAid: string;
  readonly qualified: Qualified;
  readonly policy: EvaluationPolicy;
  readonly profile: EvaluationExecutionProfile;
  readonly inventory: EvaluationSourceInventory;
  readonly hypothesis: EvolutionHypothesis;
  readonly candidates: readonly SuccessorHarnessRevision[];
  readonly admission: Admitted;
  readonly currentPosition?: {
    readonly evaluationId: string;
    readonly version: number;
    readonly lease: Admitted['lease'];
  };
  readonly sourceDirectory: string;
  readonly sourceGitCommit: string;
  readonly sourceGitTree: string;
  readonly oracleAdapterDigest: string;
  readonly reviewedRecipeSaid: string;
  readonly toolchainSaid: string;
}

export interface CesrManifestConversations {
  readonly readiness: {
    verify(input: {
      readonly qualified: Qualified;
      readonly hypothesis: EvolutionHypothesis;
      readonly candidates: readonly SuccessorHarnessRevision[];
      readonly evaluationId: string;
    }): Promise<{ readonly kind: 'Reviewed' | 'Blocked' | 'Unavailable' }>;
  };
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
  readonly cases: {
    open(input: {
      readonly ownerAid: string;
      readonly evaluationId: string;
      readonly personalAgentAid: string;
      readonly taskId: string;
      readonly taskMandateSaid: string;
      readonly mode: 'Create' | 'Reopen';
    }): Promise<
      | { readonly kind: 'Opened'; readonly custody: ProtectedCaseCustody; release(): void }
      | { readonly kind: 'Missing' | 'Conflict' | 'Unavailable' }
    >;
    drawPayload(): Uint8Array;
  };
  readonly commands: {
    inspect(evaluationId: string): Promise<ManifestCommandInspection>;
    stage(draft: Draft): Promise<ManifestCommandStaging>;
  };
  readonly hosted: {
    lockManifest(command: Command): Promise<HostedEvaluationManifestLock>;
    inspectManifestLock(
      evaluationId: string,
      manifestSaid: string,
      leaseId: string,
    ): Promise<HostedEvaluationManifestLock>;
  };
}

export type CesrManifestLockOutcome =
  | { readonly kind: 'Locked'; readonly evaluationId: string; readonly manifestSaid: string }
  | {
      readonly kind: 'Blocked';
      readonly gate:
        | 'Qualification'
        | 'Hypothesis'
        | 'Candidates'
        | 'Lease'
        | 'Catalogue'
        | 'ProtectedCases'
        | 'Manifest';
    }
  | { readonly kind: 'Unavailable' };

/** Fresh-process continuation of a previously staged exact command; never creates a new M. */
export async function reconcileStagedCesrManifest(
  evaluationId: string,
  ownerAid: string,
  ports: Pick<CesrManifestConversations, 'commands' | 'cases' | 'hosted'>,
): Promise<CesrManifestLockOutcome> {
  const staged = await ports.commands.inspect(evaluationId);
  if (staged.kind === 'Missing') return { kind: 'Blocked', gate: 'Manifest' };
  if (staged.kind !== 'Staged') return { kind: 'Unavailable' };
  const M = staged.command.manifest;
  if (M.evaluationId !== evaluationId || M.ownerAid !== ownerAid)
    return { kind: 'Blocked', gate: 'Manifest' };
  const opened = await ports.cases.open({
    ownerAid,
    evaluationId,
    personalAgentAid: M.personalAgentAid,
    taskId: M.taskId,
    taskMandateSaid: M.taskMandateSaid,
    mode: 'Reopen',
  });
  if (opened.kind !== 'Opened') return { kind: 'Blocked', gate: 'ProtectedCases' };
  try {
    return await acknowledge(staged.command, ports.hosted);
  } finally {
    opened.release();
  }
}

function prerequisites(basis: CesrManifestBasis): boolean {
  const { policy, qualified, hypothesis, candidates, admission } = basis;
  const current = basis.currentPosition ?? admission;
  return (
    decodeEvaluationPolicy(policy).kind === 'Accepted' &&
    decodeEvaluationExecutionProfile(basis.profile).kind === 'Accepted' &&
    decodeEvaluationSourceInventory(basis.inventory).kind === 'Accepted' &&
    basis.profile.d === policy.executionProfileSaid &&
    basis.profile.sourceGitCommit === basis.sourceGitCommit &&
    basis.profile.sourceGitTree === basis.sourceGitTree &&
    basis.inventory.d === policy.sourceInventorySaid &&
    basis.inventory.ownerAid === basis.ownerAid &&
    basis.inventory.taskId === qualified.taskId &&
    basis.inventory.taskRevisionSaid === qualified.taskRevisionSaid &&
    decodeEvolutionHypothesis(hypothesis).kind === 'Accepted' &&
    policy.taskId === qualified.taskId &&
    policy.taskRevisionSaid === qualified.taskRevisionSaid &&
    policy.originRunId === qualified.originRunId &&
    policy.expectedActiveRevisionSaid === qualified.expectedActiveRevisionSaid &&
    policy.executionProfileSaid === qualified.executionProfileSaid &&
    hypothesis.taskId === qualified.taskId &&
    hypothesis.taskRevisionSaid === qualified.taskRevisionSaid &&
    hypothesis.originRunId === qualified.originRunId &&
    hypothesis.retainedCheckpointSaid === qualified.retainedCheckpointSaid &&
    hypothesis.retainedSealSaid === qualified.retainedSealSaid &&
    hypothesis.parentRevisionSaid === qualified.expectedActiveRevisionSaid &&
    hypothesis.personalAgentAid === qualified.personalAgentAid &&
    hypothesis.sourceInventorySaid === policy.sourceInventorySaid &&
    candidates.length === 3 &&
    candidates.every(
      (candidate, index) =>
        decodeSuccessorHarnessRevision(candidate).kind === 'Accepted' &&
        candidate.arm === (['C1', 'C2', 'C3'] as const)[index] &&
        candidate.parentRevisionSaid === qualified.expectedActiveRevisionSaid &&
        candidate.h0Said === hypothesis.d &&
        candidate.taskRevisionSaid === qualified.taskRevisionSaid &&
        candidate.sourceInventorySaid === policy.sourceInventorySaid &&
        candidate.executionProfileSaid === policy.executionProfileSaid,
    ) &&
    admission.lease.evaluationId === admission.evaluationId &&
    Number.isSafeInteger(admission.version) &&
    admission.version >= 1 &&
    Number.isSafeInteger(admission.lease.version) &&
    admission.lease.version >= 1 &&
    // Research evidence advances Evaluation state independently from lease renewal.
    admission.lease.version <= admission.version &&
    current.evaluationId === admission.evaluationId &&
    current.lease.evaluationId === admission.evaluationId &&
    current.lease.leaseId === admission.lease.leaseId &&
    Number.isSafeInteger(current.version) &&
    current.version >= admission.version &&
    Number.isSafeInteger(current.lease.version) &&
    current.lease.version >= admission.lease.version &&
    current.lease.version <= current.version &&
    Date.parse(current.lease.expiresAt) > Date.now() &&
    Date.parse(current.lease.expiresAt) > Date.parse(current.lease.serverTime) &&
    Date.parse(current.lease.expiresAt) - Date.parse(current.lease.serverTime) <= 45000
  );
}

function stagedMatches(command: Command, basis: CesrManifestBasis): boolean {
  const M = command.manifest;
  const { qualified, policy, admission, hypothesis, candidates } = basis;
  return (
    M.evaluationId === admission.evaluationId &&
    M.taskId === qualified.taskId &&
    M.taskRevisionSaid === qualified.taskRevisionSaid &&
    M.originRunId === qualified.originRunId &&
    M.ownerAid === basis.ownerAid &&
    M.personalAgentAid === qualified.personalAgentAid &&
    M.taskMandateSaid === qualified.taskMandateSaid &&
    M.retainedCheckpointSaid === qualified.retainedCheckpointSaid &&
    M.retainedSealSaid === qualified.retainedSealSaid &&
    M.policySaid === policy.d &&
    M.revisions.H1 === qualified.expectedActiveRevisionSaid &&
    M.revisions.C1 === candidates[0]?.d &&
    M.revisions.C2 === candidates[1]?.d &&
    M.revisions.C3 === candidates[2]?.d &&
    M.executionProfileSaid === policy.executionProfileSaid &&
    M.sourceInventorySaid === policy.sourceInventorySaid &&
    M.hypothesisSaid === hypothesis.d &&
    JSON.stringify(M.allocation) === JSON.stringify(policy.allocation) &&
    command.leaseId === admission.lease.leaseId
  );
}

async function acknowledge(
  command: Command,
  hosted: CesrManifestConversations['hosted'],
): Promise<CesrManifestLockOutcome> {
  const locked = await hosted.lockManifest(command);
  if (locked.kind === 'Unavailable' || locked.kind === 'ResponseInvalid')
    return { kind: 'Unavailable' };
  if (locked.kind !== 'Locked' && locked.kind !== 'AlreadyLocked')
    return { kind: 'Blocked', gate: 'Manifest' };
  const inspected = await hosted.inspectManifestLock(
    command.manifest.evaluationId,
    command.manifest.d,
    command.leaseId,
  );
  return inspected.kind === 'Locked' &&
    inspected.receipt.evaluationId === command.manifest.evaluationId &&
    inspected.receipt.manifestSaid === command.manifest.d &&
    inspected.receipt.ownerAid === command.manifest.ownerAid &&
    inspected.receipt.policySaid === command.manifest.policySaid &&
    inspected.receipt.leaseId === command.leaseId &&
    inspected.receipt.currentLeaseVersion >= inspected.receipt.lockedAtLeaseVersion &&
    inspected.receipt.currentEvaluationVersion >= inspected.receipt.lockedAtEvaluationVersion
    ? {
        kind: 'Locked',
        evaluationId: command.manifest.evaluationId,
        manifestSaid: command.manifest.d,
      }
    : inspected.kind === 'Unavailable' || inspected.kind === 'ResponseInvalid'
      ? { kind: 'Unavailable' }
      : { kind: 'Blocked', gate: 'Manifest' };
}

/** E3 M transition: exact Q/H0/sibling bindings precede private sealing and hosted lock. */
export async function lockCesrComparisonManifest(
  basis: CesrManifestBasis,
  ports: CesrManifestConversations,
): Promise<CesrManifestLockOutcome> {
  if (!prerequisites(basis)) return { kind: 'Blocked', gate: 'Candidates' };
  const readiness = await ports.readiness.verify({
    qualified: basis.qualified,
    hypothesis: basis.hypothesis,
    candidates: basis.candidates,
    evaluationId: basis.admission.evaluationId,
  });
  if (readiness.kind === 'Unavailable') return { kind: 'Unavailable' };
  if (readiness.kind !== 'Reviewed') return { kind: 'Blocked', gate: 'Candidates' };
  const existing = await ports.commands.inspect(basis.admission.evaluationId);
  if (existing.kind === 'Unavailable') return { kind: 'Unavailable' };
  const keyBinding = {
    ownerAid: basis.ownerAid,
    evaluationId: basis.admission.evaluationId,
    personalAgentAid: basis.qualified.personalAgentAid,
    taskId: basis.qualified.taskId,
    taskMandateSaid: basis.qualified.taskMandateSaid,
  };
  if (existing.kind === 'Staged') {
    if (!stagedMatches(existing.command, basis)) return { kind: 'Blocked', gate: 'Manifest' };
    const key = await ports.cases.open({ ...keyBinding, mode: 'Reopen' });
    if (key.kind !== 'Opened') return { kind: 'Blocked', gate: 'ProtectedCases' };
    try {
      return await acknowledge(existing.command, ports.hosted);
    } finally {
      key.release();
    }
  }
  const catalogue = await ports.catalogue.review({
    sourceDirectory: basis.sourceDirectory,
    sourceGitCommit: basis.sourceGitCommit,
    sourceGitTree: basis.sourceGitTree,
  });
  if (catalogue.kind === 'Unavailable') return { kind: 'Unavailable' };
  if (catalogue.kind !== 'Reviewed') return { kind: 'Blocked', gate: 'Catalogue' };
  let key = await ports.cases.open({ ...keyBinding, mode: 'Create' });
  // A crash can leave key/nonce custody durable before the first M command is staged.
  if (key.kind === 'Conflict') key = await ports.cases.open({ ...keyBinding, mode: 'Reopen' });
  if (key.kind !== 'Opened') return { kind: 'Blocked', gate: 'ProtectedCases' };
  try {
    const sealed = await sealCesrComparisonCases(
      {
        evaluationId: basis.admission.evaluationId,
        taskId: basis.qualified.taskId,
        taskRevisionSaid: basis.qualified.taskRevisionSaid,
        ownerAid: basis.ownerAid,
        personalAgentAid: basis.qualified.personalAgentAid,
        policySaid: basis.policy.d,
        executionProfileSaid: basis.policy.executionProfileSaid,
        oracleAdapterDigest: basis.oracleAdapterDigest,
        reviewedRecipeSaid: basis.reviewedRecipeSaid,
        toolchainSaid: basis.toolchainSaid,
        publicConditions: catalogue.publicConditions,
      },
      { custody: key.custody, drawPayload: () => ports.cases.drawPayload() },
    );
    if (sealed.kind !== 'Prepared') return { kind: 'Blocked', gate: 'ProtectedCases' };
    const M = prepareEvaluationManifest({
      evaluationId: basis.admission.evaluationId,
      taskId: basis.qualified.taskId,
      taskRevisionSaid: basis.qualified.taskRevisionSaid,
      originRunId: basis.qualified.originRunId,
      ownerAid: basis.ownerAid,
      personalAgentAid: basis.qualified.personalAgentAid,
      taskMandateSaid: basis.qualified.taskMandateSaid,
      retainedCheckpointSaid: basis.qualified.retainedCheckpointSaid,
      retainedSealSaid: basis.qualified.retainedSealSaid,
      policySaid: basis.policy.d,
      revisions: {
        H1: basis.qualified.expectedActiveRevisionSaid,
        C1: basis.candidates[0]?.d,
        C2: basis.candidates[1]?.d,
        C3: basis.candidates[2]?.d,
      },
      executionProfileSaid: basis.policy.executionProfileSaid,
      sourceInventorySaid: basis.policy.sourceInventorySaid,
      hypothesisSaid: basis.hypothesis.d,
      verifierSaid: sealed.bundle.d,
      protectedCaseArtifactSaid: sealed.bundle.protectedCase.stimulus.d,
      finalCaseArtifactSaid: sealed.bundle.terminalCase.stimulus.d,
      publicConditionIds: catalogue.publicConditions.map((item) => item.id),
      heldOutCaseCount: 1,
      allocation: basis.policy.allocation,
    });
    if (M.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Manifest' };
    const encoded = encodeEvaluationVerifierBundle(sealed.bundle);
    if (encoded.kind !== 'Encoded') return { kind: 'Blocked', gate: 'Manifest' };
    const staged = await ports.commands.stage({
      version: 1,
      expectedEvaluationVersion: basis.currentPosition?.version ?? basis.admission.version,
      leaseId: basis.admission.lease.leaseId,
      manifest: M.manifest,
      verifierBundle: sealed.bundle,
      verifierBundleBytesBase64Url: Buffer.from(encoded.bytes).toString('base64url'),
      protectedArtifacts: [...sealed.protectedArtifacts],
    });
    if (staged.kind === 'Unavailable') return { kind: 'Unavailable' };
    if (staged.kind !== 'Staged' || !stagedMatches(staged.command, basis))
      return { kind: 'Blocked', gate: 'Manifest' };
    return await acknowledge(staged.command, ports.hosted);
  } finally {
    key.release();
  }
}
