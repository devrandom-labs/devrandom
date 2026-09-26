import {
  decodeEvaluationEvidenceBatch,
  decodePublicEvaluationArtifact,
  decodeProtectedEvaluationArtifact,
  evaluationEvidenceUploadSchema,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type EvaluationEvidenceUpload = Type.Static<typeof evaluationEvidenceUploadSchema>;
export type EvaluationEvidenceAcceptance =
  | {
      readonly kind: 'Accepted' | 'AlreadyAccepted';
      readonly evaluationId: string;
      readonly streamId: string;
      readonly batchSaid: string;
      readonly acceptedThroughSequence: number;
      readonly chainHeadSaid: string;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'InvalidBatch' | 'Binding' | 'MissingBytes' }
  | { readonly kind: 'Gap' | 'Conflict' | 'QuotaExceeded' | 'Unavailable' };

export interface EvaluationEvidenceBatches {
  accept(input: {
    readonly ownerAid: string;
    readonly upload: EvaluationEvidenceUpload;
  }): Promise<EvaluationEvidenceAcceptance>;
}

export async function acceptEvaluationEvidence(
  input: { readonly ownerAid: string; readonly upload: unknown },
  dependencies: { readonly batches: EvaluationEvidenceBatches },
): Promise<EvaluationEvidenceAcceptance> {
  const { upload } = input;
  if (!Value.Check(evaluationEvidenceUploadSchema, upload))
    return { kind: 'Rejected', reason: 'InvalidBatch' };
  if (decodeEvaluationEvidenceBatch(upload.batch, upload.events).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'InvalidBatch' };
  if (
    upload.publicArtifacts.some(
      (artifact) => decodePublicEvaluationArtifact(artifact).kind !== 'Accepted',
    ) ||
    upload.protectedArtifacts.some(
      (artifact) =>
        decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
        artifact.evaluationId !== upload.batch.evaluationId,
    )
  )
    return { kind: 'Rejected', reason: 'Binding' };
  return dependencies.batches.accept({ ownerAid: input.ownerAid, upload });
}
