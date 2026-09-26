import Type from 'typebox';
import Value from 'typebox/value';
import { decodeEvidenceArtifact, type EvidenceArtifact } from '../evidence/evidence-artifact.js';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const verdict = Type.Union([Type.Literal('Pass'), Type.Literal('Fail')]);
export const runTerminalVerificationSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('RunTerminalVerification'),
    runId: uuid,
    taskRevisionSaid: said,
    harnessRevisionSaid: said,
    segmentSaid: said,
    evaluationId: uuid,
    manifestSaid: said,
    submittedSourceSaid: said,
    verificationSourceSaid: said,
    executableSaid: said,
    buildReceiptSaid: said,
    buildCleanupReceiptSaid: said,
    publicCases: Type.Array(
      Type.Object(
        {
          conditionId: Type.String({ minLength: 1, maxLength: 96 }),
          verdict,
          rawObservationSaid: said,
          cleanupReceiptSaid: said,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    terminalCaseArtifactSaid: said,
    encryptedObservationSaid: said,
    terminalCleanupReceiptSaid: said,
    terminalVerdict: verdict,
    verdict,
  },
  { additionalProperties: false },
);
export type RunTerminalVerificationReceipt = Type.Static<typeof runTerminalVerificationSchema>;
export function decodeRunTerminalVerification(
  artifact: EvidenceArtifact,
  bytes: Uint8Array,
):
  | { readonly kind: 'Accepted'; readonly receipt: RunTerminalVerificationReceipt }
  | { readonly kind: 'Rejected' } {
  try {
    if (
      artifact.mediaType !== 'application/json' ||
      decodeEvidenceArtifact(artifact, bytes).kind !== 'Accepted'
    )
      return { kind: 'Rejected' };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !Value.Check(runTerminalVerificationSchema, value) ||
      JSON.stringify(value) !== text ||
      value.submittedSourceSaid !== value.verificationSourceSaid ||
      new Set(value.publicCases.map((item) => item.conditionId)).size !==
        value.publicCases.length ||
      value.verdict !==
        (value.terminalVerdict === 'Pass' &&
        value.publicCases.every((item) => item.verdict === 'Pass')
          ? 'Pass'
          : 'Fail')
    )
      return { kind: 'Rejected' };
    return { kind: 'Accepted', receipt: value };
  } catch {
    return { kind: 'Rejected' };
  }
}
