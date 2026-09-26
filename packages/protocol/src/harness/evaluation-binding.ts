import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvaluationManifest, type EvaluationManifest } from '../evaluation/manifest.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
export const harnessEvaluationBindingSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('HarnessEvaluationBinding'),
    harnessRevisionSaid: said,
    evaluationManifestSaid: said,
  },
  { additionalProperties: false },
);

export type HarnessEvaluationBinding = Type.Static<typeof harnessEvaluationBindingSchema>;
export type HarnessEvaluationBindingRejection =
  | 'SchemaInvalid'
  | 'ManifestInvalid'
  | 'ManifestMismatch'
  | 'RevisionNotInManifest'
  | 'SaidMismatch'
  | 'SaidConstructionFailed';
export type HarnessEvaluationBindingPreparation =
  | { readonly kind: 'Prepared'; readonly binding: HarnessEvaluationBinding }
  | { readonly kind: 'Rejected'; readonly reason: HarnessEvaluationBindingRejection };
export type HarnessEvaluationBindingDecoding =
  | { readonly kind: 'Accepted'; readonly binding: HarnessEvaluationBinding }
  | { readonly kind: 'Rejected'; readonly reason: HarnessEvaluationBindingRejection };

export function prepareHarnessEvaluationBinding(
  harnessRevisionSaid: string,
  manifest: EvaluationManifest,
): HarnessEvaluationBindingPreparation {
  if (decodeEvaluationManifest(manifest).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'ManifestInvalid' };
  if (!Object.values(manifest.revisions).includes(harnessRevisionSaid))
    return { kind: 'Rejected', reason: 'RevisionNotInManifest' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'HarnessEvaluationBinding',
      harnessRevisionSaid,
      evaluationManifestSaid: manifest.d,
    })[1];
    if (!Value.Check(harnessEvaluationBindingSchema, document))
      return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
    return { kind: 'Prepared', binding: document };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeHarnessEvaluationBinding(
  input: unknown,
  manifest: EvaluationManifest,
): HarnessEvaluationBindingDecoding {
  if (!Value.Check(harnessEvaluationBindingSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (decodeEvaluationManifest(manifest).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'ManifestInvalid' };
  if (input.evaluationManifestSaid !== manifest.d)
    return { kind: 'Rejected', reason: 'ManifestMismatch' };
  if (!Object.values(manifest.revisions).includes(input.harnessRevisionSaid))
    return { kind: 'Rejected', reason: 'RevisionNotInManifest' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', binding: { ...input } };
}
