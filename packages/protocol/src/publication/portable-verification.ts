import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
import { decodeEvidenceArtifact, evidenceArtifactSchema } from '../evidence/evidence-artifact.js';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const object = { additionalProperties: false } as const;
const check = (name: string) =>
  Type.Object({ name: Type.Literal(name), evidenceSaid: said }, object);
export const portableVerificationInputSchema = Type.Object(
  {
    packageSaid: said,
    checks: Type.Tuple([
      check('Sanitization'),
      check('CapabilityIsolation'),
      check('PortableBehavior'),
      check('FreshPublicVerification'),
      check('ProtectedRegression'),
    ]),
    rawEvidence: Type.Array(
      Type.Object(
        {
          artifact: evidenceArtifactSchema,
          bytesBase64Url: Type.String({ minLength: 1, maxLength: 90000 }),
        },
        object,
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  object,
);
export const portableHarnessVerificationSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('PortableHarnessVerification'),
    suite: Type.Literal('CleanPublicReferenceV1'),
    ...portableVerificationInputSchema.properties,
  },
  object,
);
export type PortableHarnessVerification = Type.Static<typeof portableHarnessVerificationSchema>;
export function preparePortableHarnessVerification(
  input: unknown,
):
  | { readonly kind: 'Prepared'; readonly verification: PortableHarnessVerification }
  | { readonly kind: 'Rejected' } {
  if (
    !Value.Check(portableVerificationInputSchema, input) ||
    Buffer.byteLength(JSON.stringify(input), 'utf8') > 64 * 1024
  )
    return { kind: 'Rejected' };
  const captured = new Set<string>();
  for (const entry of input.rawEvidence) {
    const bytes = Buffer.from(entry.bytesBase64Url, 'base64url');
    if (
      bytes.toString('base64url') !== entry.bytesBase64Url ||
      decodeEvidenceArtifact(entry.artifact, bytes).kind !== 'Accepted' ||
      captured.has(entry.artifact.d)
    )
      return { kind: 'Rejected' };
    captured.add(entry.artifact.d);
  }
  if (
    input.checks.some((item) => !captured.has(item.evidenceSaid)) ||
    input.rawEvidence.some(
      (item) => !input.checks.some((check) => check.evidenceSaid === item.artifact.d),
    )
  )
    return { kind: 'Rejected' };
  try {
    const verification: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'PortableHarnessVerification',
      suite: 'CleanPublicReferenceV1',
      packageSaid: input.packageSaid,
      checks: input.checks,
      rawEvidence: input.rawEvidence,
    })[1];
    return Value.Check(portableHarnessVerificationSchema, verification)
      ? { kind: 'Prepared', verification }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
}
export function decodePortableHarnessVerification(
  input: unknown,
  packageSaid: string,
):
  | { readonly kind: 'Accepted'; readonly verification: PortableHarnessVerification }
  | { readonly kind: 'Rejected' } {
  if (!Value.Check(portableHarnessVerificationSchema, input) || input.packageSaid !== packageSaid)
    return { kind: 'Rejected' };
  const prepared = preparePortableHarnessVerification({
    packageSaid: input.packageSaid,
    checks: input.checks,
    rawEvidence: input.rawEvidence,
  });
  return prepared.kind === 'Prepared' &&
    JSON.stringify(prepared.verification) === JSON.stringify(input)
    ? { kind: 'Accepted', verification: prepared.verification }
    : { kind: 'Rejected' };
}
