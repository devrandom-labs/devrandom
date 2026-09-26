import { decodeBaselineHarnessRevision, prepareEvidenceArtifact } from '@devrandom/protocol';
import {
  validVersionedHistoryPolicy,
  type SuccessorTreatmentReview,
  type VersionedFormatHistoryPolicy,
} from '@devrandom/runtime';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function canonicalDocument(bytes: Uint8Array | undefined, maximum: number): unknown {
  if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > maximum) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed) === text ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type JsonObject = { readonly [key: string]: unknown };

function keys(value: unknown, expected: string): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected
  );
}

function safeInstruction(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 8 * 1024 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code >= 32 || [9, 10, 13].includes(code)) && code !== 127;
    })
  );
}

function reviewedConfiguration(arm: 'C1' | 'C2' | 'C3', value: unknown): boolean {
  if (arm === 'C1')
    return (
      keys(value, 'arm,instructionText,version') &&
      value.version === 1 &&
      value.arm === arm &&
      safeInstruction(value.instructionText)
    );
  if (arm === 'C2') return keys(value, 'arm,version') && value.version === 1 && value.arm === arm;
  return (
    keys(
      value,
      'arm,formatMarker,maximumContextBytes,maximumItems,priority,triggerPaths,version',
    ) &&
    value.version === 1 &&
    value.arm === arm &&
    typeof value.formatMarker === 'string' &&
    Array.isArray(value.triggerPaths) &&
    value.triggerPaths.every((path: unknown) => typeof path === 'string') &&
    Array.isArray(value.priority) &&
    value.priority.every(
      (kind: unknown) => kind === 'Failure' || kind === 'Contract' || kind === 'Edit',
    ) &&
    typeof value.maximumItems === 'number' &&
    typeof value.maximumContextBytes === 'number' &&
    validVersionedHistoryPolicy(value as unknown as VersionedFormatHistoryPolicy)
  );
}

function reviewedImplementation(arm: 'C2' | 'C3', value: unknown): boolean {
  if (arm === 'C2') {
    const steps = keys(value, 'kind,steps,trigger,version') ? value.steps : undefined;
    return (
      keys(value, 'kind,steps,trigger,version') &&
      value.version === 1 &&
      value.kind === 'RecoveryWorkflow' &&
      value.trigger === 'QualifiedRetainedFailure' &&
      Array.isArray(steps) &&
      steps.length === 4 &&
      ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'].every(
        (step, index) => steps[index] === step,
      )
    );
  }
  return (
    keys(value, 'algorithm,kind,version') &&
    value.version === 1 &&
    value.kind === 'VersionedFormatContextSelection' &&
    value.algorithm === 'ExactPublicHistoryV1'
  );
}

/** The reviewed input format used again when the parent invokes public treatment behavior. */
export function reviewTreatmentBytes(
  arm: 'C1' | 'C2' | 'C3',
  configurationBytes: Uint8Array,
  implementationBytes?: Uint8Array,
): boolean {
  if (!reviewedConfiguration(arm, canonicalDocument(configurationBytes, 32 * 1024))) return false;
  return arm === 'C1'
    ? implementationBytes === undefined
    : reviewedImplementation(arm, canonicalDocument(implementationBytes, 128 * 1024));
}

/** Parent adapter for bounded C1/C2/C3 treatment bytes, before immutable Git branching. */
export class ParentSuccessorTreatmentReview implements SuccessorTreatmentReview {
  review(
    input: Parameters<SuccessorTreatmentReview['review']>[0],
  ): ReturnType<SuccessorTreatmentReview['review']> {
    const { binding, h1 } = input;
    if (
      decodeBaselineHarnessRevision(h1).kind !== 'Accepted' ||
      h1.d !== binding.parentRevisionSaid ||
      h1.task.revisionSaid !== binding.taskRevisionSaid ||
      ![
        binding.h0Said,
        binding.sourceInventorySaid,
        binding.executionProfileSaid,
        input.successorRevisionSaid,
      ].every((value) => said.test(value)) ||
      !said.test(input.configurationArtifactSaid) ||
      !['C1', 'C2', 'C3'].includes(binding.arm)
    )
      return Promise.resolve({ kind: 'Rejected' });
    if (input.configurationBytes.byteLength > 32 * 1024)
      return Promise.resolve({ kind: 'Rejected' });
    const configuration = prepareEvidenceArtifact(input.configurationBytes, 'application/json');
    if (
      configuration.kind !== 'Prepared' ||
      configuration.artifact.d !== input.configurationArtifactSaid ||
      !reviewTreatmentBytes(
        binding.arm,
        input.configurationBytes,
        input.reviewedImplementationBytes,
      )
    )
      return Promise.resolve({ kind: 'Rejected' });
    if (binding.arm === 'C1') {
      return Promise.resolve(
        input.reviewedImplementationSaid === undefined &&
          input.reviewedImplementationBytes === undefined
          ? {
              kind: 'Reviewed',
              binding,
              successorRevisionSaid: input.successorRevisionSaid,
              configurationArtifactSaid: input.configurationArtifactSaid,
            }
          : { kind: 'Rejected' },
      );
    }
    if (
      input.reviewedImplementationSaid === undefined ||
      input.reviewedImplementationBytes === undefined
    )
      return Promise.resolve({ kind: 'Rejected' });
    if (input.reviewedImplementationBytes.byteLength > 128 * 1024)
      return Promise.resolve({ kind: 'Rejected' });
    const implementation = prepareEvidenceArtifact(
      input.reviewedImplementationBytes,
      'application/octet-stream',
    );
    if (
      implementation.kind !== 'Prepared' ||
      implementation.artifact.d !== input.reviewedImplementationSaid ||
      !reviewTreatmentBytes(
        binding.arm,
        input.configurationBytes,
        input.reviewedImplementationBytes,
      )
    )
      return Promise.resolve({ kind: 'Rejected' });
    return Promise.resolve({
      kind: 'Reviewed',
      binding,
      successorRevisionSaid: input.successorRevisionSaid,
      configurationArtifactSaid: input.configurationArtifactSaid,
      reviewedImplementationSaid: input.reviewedImplementationSaid,
    });
  }
}
