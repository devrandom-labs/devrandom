import {
  decodeBaselineHarnessRevision,
  decodeEvaluationExecutionProfile,
  decodeEvaluationManifest,
  decodeSuccessorHarnessRevision,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
  type EvaluationManifest,
} from '@devrandom/protocol';

import type { ExecutableSuccessorDescriptor } from '../../harness/application/materialize-successor.js';
import { digestRunRuntimePrompt } from '../../run/run-execution-profile-custody.js';

const maximumTreatmentBytes = 32 * 1_024;
const maximumInstructionBytes = 8 * 1_024;
const maximumWorkerPromptBytes = 128 * 1_024;
const sha1 = /^[a-f0-9]{40}$/u;

export interface C1TrialBehaviorInput {
  readonly reviewed?: ExecutableSuccessorDescriptor | undefined;
  readonly treatmentBytes: Uint8Array;
  readonly successorBytes: Uint8Array;
  readonly manifest?: EvaluationManifest | undefined;
  readonly profile?: EvaluationExecutionProfile | undefined;
  readonly baseSystemPrompt: string;
  readonly taskPrompt: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
}

export type C1TrialBehaviorBinding =
  | {
      readonly kind: 'Bound';
      readonly systemPrompt: string;
      readonly promptDigest: string;
      readonly treatmentArtifactSaid: string;
      readonly receiptBytes: Uint8Array;
    }
  | { readonly kind: 'Blocked'; readonly reason: 'Revision' | 'Treatment' | 'Prompt' };

function canonicalDocument(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes)
    return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    return JSON.stringify(document) === text ? document : undefined;
  } catch {
    return undefined;
  }
}

/** Trusted parent binds reviewed C1 bytes to one frozen Manifest and actual worker prompt. */
export function bindC1TrialBehavior(input: C1TrialBehaviorInput): C1TrialBehaviorBinding {
  const reviewed = input.reviewed;
  const manifest = input.manifest;
  const profile = input.profile;
  if (reviewed === undefined || manifest === undefined || profile === undefined)
    return { kind: 'Blocked', reason: 'Revision' };
  const decodedH1 = decodeBaselineHarnessRevision(reviewed.h1);
  const decodedSuccessor = decodeSuccessorHarnessRevision(
    canonicalDocument(input.successorBytes, 16 * 1_024),
  );
  if (
    decodedH1.kind !== 'Accepted' ||
    decodedSuccessor.kind !== 'Accepted' ||
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    decodeEvaluationExecutionProfile(profile).kind !== 'Accepted'
  )
    return { kind: 'Blocked', reason: 'Revision' };
  const h1 = decodedH1.revision;
  const successor = decodedSuccessor.revision;
  if (
    successor.arm !== 'C1' ||
    reviewed.treatment.kind !== 'Instruction' ||
    reviewed.successorRevisionSaid !== successor.d ||
    reviewed.binding.arm !== 'C1' ||
    reviewed.binding.parentRevisionSaid !== h1.d ||
    reviewed.binding.h0Said !== successor.h0Said ||
    reviewed.binding.taskRevisionSaid !== successor.taskRevisionSaid ||
    reviewed.binding.sourceInventorySaid !== successor.sourceInventorySaid ||
    reviewed.binding.executionProfileSaid !== successor.executionProfileSaid ||
    successor.parentRevisionSaid !== h1.d ||
    successor.taskRevisionSaid !== h1.task.revisionSaid ||
    successor.sourceInventorySaid !== manifest.sourceInventorySaid ||
    successor.executionProfileSaid !== profile.d ||
    successor.h0Said !== manifest.hypothesisSaid ||
    manifest.revisions.H1 !== h1.d ||
    manifest.revisions.C1 !== successor.d ||
    manifest.executionProfileSaid !== profile.d ||
    manifest.taskId !== h1.task.taskId ||
    manifest.taskRevisionSaid !== h1.task.revisionSaid ||
    manifest.personalAgentAid !== h1.authority.personalAgentAid ||
    manifest.taskMandateSaid !== h1.authority.taskMandateSaid ||
    h1.repository.objectFormat !== 'sha1' ||
    h1.repository.commit !== profile.sourceGitCommit ||
    h1.repository.tree !== profile.sourceGitTree ||
    !sha1.test(input.candidateCommit) ||
    !sha1.test(input.candidateTree)
  )
    return { kind: 'Blocked', reason: 'Revision' };
  const prepared = prepareEvidenceArtifact(input.treatmentBytes, 'application/json');
  if (
    prepared.kind !== 'Prepared' ||
    input.treatmentBytes.byteLength > maximumTreatmentBytes ||
    prepared.artifact.d !== successor.configurationArtifactSaid ||
    reviewed.configuration.d !== prepared.artifact.d ||
    reviewed.configuration.mediaType !== 'application/json'
  )
    return { kind: 'Blocked', reason: 'Treatment' };
  const document = canonicalDocument(input.treatmentBytes, maximumTreatmentBytes);
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document) ||
    Object.keys(document).sort().join(',') !== 'arm,instructionText,version' ||
    !('version' in document) ||
    document.version !== 1 ||
    !('arm' in document) ||
    document.arm !== 'C1' ||
    !('instructionText' in document) ||
    typeof document.instructionText !== 'string' ||
    document.instructionText.trim().length === 0 ||
    Buffer.byteLength(document.instructionText, 'utf8') > maximumInstructionBytes ||
    Array.from(document.instructionText).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    return { kind: 'Blocked', reason: 'Treatment' };
  if (
    digestRunRuntimePrompt(input.baseSystemPrompt, input.taskPrompt) !==
    profile.h1RuntimePromptDigest
  )
    return { kind: 'Blocked', reason: 'Prompt' };
  const systemPrompt = `${input.baseSystemPrompt}\n\nReviewed C1 instruction (${prepared.artifact.d}):\n${document.instructionText}`;
  if (Buffer.byteLength(systemPrompt, 'utf8') > maximumWorkerPromptBytes)
    return { kind: 'Blocked', reason: 'Prompt' };
  const promptDigest = digestRunRuntimePrompt(systemPrompt, input.taskPrompt);
  const receiptBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'C1TrialBehaviorBound',
      manifestSaid: manifest.d,
      executionProfileSaid: profile.d,
      h1RevisionSaid: h1.d,
      successorRevisionSaid: successor.d,
      candidateCommit: input.candidateCommit,
      candidateTree: input.candidateTree,
      treatmentArtifactSaid: prepared.artifact.d,
      baselinePromptDigest: profile.h1RuntimePromptDigest,
      workerPromptDigest: promptDigest,
    }),
    'utf8',
  );
  return {
    kind: 'Bound',
    systemPrompt,
    promptDigest,
    treatmentArtifactSaid: prepared.artifact.d,
    receiptBytes,
  };
}
