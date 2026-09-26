import {
  decodeEvaluationExecutionProfile,
  identifyHarnessInstruction,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
  type EvidenceArtifactMediaType,
} from '@devrandom/protocol';

import { digestRunRuntimePrompt } from './runtime-prompt-digest.js';
export { digestRunRuntimePrompt } from './runtime-prompt-digest.js';

type HarnessInstructionResource = Extract<
  ReturnType<typeof identifyHarnessInstruction>,
  { readonly kind: 'Identified' }
>['resource'];

interface MaterializedInstruction {
  readonly path: string;
  readonly content: string;
}

export interface RunExecutionProfileEvidence {
  readonly run: {
    readonly binding: {
      readonly runId: string;
      readonly repository: { readonly commit: string; readonly tree: string };
    };
  };
  storeArtifact(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: EvidenceArtifactMediaType;
  }):
    | { readonly kind: 'Stored' | 'AlreadyStored'; readonly artifact: { readonly d: string } }
    | { readonly kind: string };
  record(input: {
    readonly occurredAt: string;
    readonly producer: { readonly kind: 'RunSupervisor' };
    readonly event: {
      readonly kind: 'RunExecutionProfileBound';
      readonly executionProfileSaid: string;
      readonly profileArtifactSaid: string;
      readonly worktreeBranch: string;
    };
  }):
    | { readonly kind: 'Recorded'; readonly event: { readonly d: string } }
    | {
        readonly kind: string;
      };
}

export type RunExecutionProfileBinding =
  | { readonly kind: 'Bound'; readonly profileArtifactSaid: string; readonly eventSaid: string }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'ProfileInvalid'
        | 'RunBindingMismatch'
        | 'InstructionMismatch'
        | 'PromptMismatch'
        | 'LimitsMismatch'
        | 'CleanupMismatch'
        | 'ArtifactUnavailable'
        | 'EventUnavailable';
    };

export type RunExecutionProfileInspection =
  | { readonly kind: 'Compatible' }
  | Extract<RunExecutionProfileBinding, { readonly kind: 'Rejected' }>;

/** The same exact system prompt used by the baseline H1 Pi executor. */
export function runInstructionPrompt(instructions: readonly MaterializedInstruction[]): string {
  return instructions
    .map(({ path, content }) => `<instruction path="${path}">\n${content}\n</instruction>`)
    .join('\n');
}

export function identifyRunH1InstructionInventory(
  instructions: readonly MaterializedInstruction[],
  expected: readonly HarnessInstructionResource[],
): Uint8Array | undefined {
  if (instructions.length !== expected.length) return undefined;
  for (const [index, instruction] of instructions.entries()) {
    const identified = identifyHarnessInstruction(instruction);
    const resource = expected[index];
    if (
      identified.kind !== 'Identified' ||
      resource === undefined ||
      identified.resource.path !== resource.path ||
      identified.resource.contentSaid !== resource.contentSaid
    )
      return undefined;
  }
  return Buffer.from(
    JSON.stringify({ version: 1, kind: 'RunH1InstructionInventory', resources: expected }),
    'utf8',
  );
}

function artifactSaid(bytes: Uint8Array): string | undefined {
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  return prepared.kind === 'Prepared' ? prepared.artifact.d : undefined;
}

/** Checks exact bytes before the Run Supervisor emits a local profile event reference. */
export function inspectRunExecutionProfileBinding(input: {
  readonly profile: EvaluationExecutionProfile;
  readonly instructions: readonly MaterializedInstruction[];
  readonly instructionResources: readonly HarnessInstructionResource[];
  readonly systemPrompt: string;
  readonly taskPrompt: string;
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
  readonly worktreeBranch: string;
  readonly run: RunExecutionProfileEvidence['run'];
}): RunExecutionProfileInspection {
  const profile = input.profile;
  const run = input.run;
  if (decodeEvaluationExecutionProfile(profile).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'ProfileInvalid' };
  if (
    profile.sourceGitCommit !== run.binding.repository.commit ||
    profile.sourceGitTree !== run.binding.repository.tree ||
    input.worktreeBranch !== `devrandom/run/${run.binding.runId}`
  )
    return { kind: 'Rejected', reason: 'RunBindingMismatch' };
  const inventory = identifyRunH1InstructionInventory(
    input.instructions,
    input.instructionResources,
  );
  if (inventory === undefined || artifactSaid(inventory) !== profile.h1InstructionSaid)
    return { kind: 'Rejected', reason: 'InstructionMismatch' };
  if (
    runInstructionPrompt(input.instructions) !== input.systemPrompt ||
    digestRunRuntimePrompt(input.systemPrompt, input.taskPrompt) !== profile.h1RuntimePromptDigest
  )
    return { kind: 'Rejected', reason: 'PromptMismatch' };
  if (artifactSaid(input.effectiveLimitsReceipt) !== profile.effectiveLimitsReceiptSaid)
    return { kind: 'Rejected', reason: 'LimitsMismatch' };
  if (artifactSaid(input.parentDeathCleanupReceipt) !== profile.parentDeathCleanupReceiptSaid)
    return { kind: 'Rejected', reason: 'CleanupMismatch' };
  return { kind: 'Compatible' };
}

/** Stores exact local custody before emitting an event; hosted acknowledgement follows delivery. */
export function bindRunExecutionProfile(input: {
  readonly profile: EvaluationExecutionProfile;
  readonly instructions: readonly MaterializedInstruction[];
  readonly instructionResources: readonly HarnessInstructionResource[];
  readonly systemPrompt: string;
  readonly taskPrompt: string;
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
  readonly worktreeBranch: string;
  readonly evidence: RunExecutionProfileEvidence;
  now(): string;
}): RunExecutionProfileBinding {
  const inspected = inspectRunExecutionProfileBinding({
    ...input,
    run: input.evidence.run,
  });
  if (inspected.kind !== 'Compatible') return inspected;
  const profile = input.profile;
  const inventory = identifyRunH1InstructionInventory(
    input.instructions,
    input.instructionResources,
  );
  if (inventory === undefined) return { kind: 'Rejected', reason: 'InstructionMismatch' };
  const profileBytes = Buffer.from(JSON.stringify(profile), 'utf8');
  const profileArtifactSaid = artifactSaid(profileBytes);
  if (profileArtifactSaid === undefined) return { kind: 'Rejected', reason: 'ProfileInvalid' };
  for (const [bytes, expectedSaid] of [
    [inventory, profile.h1InstructionSaid],
    [input.effectiveLimitsReceipt, profile.effectiveLimitsReceiptSaid],
    [input.parentDeathCleanupReceipt, profile.parentDeathCleanupReceiptSaid],
    [profileBytes, profileArtifactSaid],
  ] as const) {
    const stored = input.evidence.storeArtifact({ bytes, mediaType: 'application/json' });
    if (
      (stored.kind !== 'Stored' && stored.kind !== 'AlreadyStored') ||
      !('artifact' in stored) ||
      stored.artifact.d !== expectedSaid
    )
      return { kind: 'Rejected', reason: 'ArtifactUnavailable' };
  }
  const recorded = input.evidence.record({
    occurredAt: input.now(),
    producer: { kind: 'RunSupervisor' },
    event: {
      kind: 'RunExecutionProfileBound',
      executionProfileSaid: profile.d,
      profileArtifactSaid,
      worktreeBranch: input.worktreeBranch,
    },
  });
  return recorded.kind === 'Recorded' && 'event' in recorded
    ? { kind: 'Bound', profileArtifactSaid, eventSaid: recorded.event.d }
    : { kind: 'Rejected', reason: 'EventUnavailable' };
}
