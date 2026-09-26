import Type from 'typebox';
import Value from 'typebox/value';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
/** This is proposal vocabulary; none of the unavailable requests adds an executable tool. */
export const harnessProposalCapabilitySchema = Type.Union([
  Type.Literal('ReadRepository'),
  Type.Literal('EditRepository'),
  Type.Literal('RunFormatter'),
  Type.Literal('RunStaticAnalysis'),
  Type.Literal('RunTests'),
  Type.Literal('SubmitResult'),
  Type.Literal('DeployProduction'),
  Type.Literal('ExpandMandate'),
  Type.Literal('ReplaceProtectedEvaluationManifest'),
  Type.Literal('DeleteEvaluationEvidence'),
  Type.Literal('ActivateHarnessRevision'),
]);
export const harnessAuthorityProposalSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('HarnessAuthorityProposal'),
    taskRevisionSaid: said,
    parentRevisionSaid: said,
    requestedCapabilities: Type.Array(harnessProposalCapabilitySchema, {
      minItems: 1,
      maxItems: 11,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type HarnessAuthorityProposal = Type.Static<typeof harnessAuthorityProposalSchema>;
export function decodeHarnessAuthorityProposal(
  input: unknown,
):
  | { readonly kind: 'Accepted'; readonly proposal: HarnessAuthorityProposal }
  | { readonly kind: 'Rejected' } {
  return Value.Check(harnessAuthorityProposalSchema, input)
    ? { kind: 'Accepted', proposal: input }
    : { kind: 'Rejected' };
}
