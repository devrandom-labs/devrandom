import { portableCapabilities, safePortableInstruction } from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const object = { additionalProperties: false } as const;
export const portableBehaviorSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('Instruction'), text: Type.String({ minLength: 1, maxLength: 8192 }) },
    object,
  ),
  Type.Object(
    {
      kind: Type.Literal('RecoveryWorkflow'),
      trigger: Type.Literal('QualifiedRetainedFailure'),
      steps: Type.Tuple([
        Type.Literal('RetrieveExperience'),
        Type.Literal('ReadExactSource'),
        Type.Literal('Replan'),
        Type.Literal('FreshPublicVerify'),
      ]),
    },
    object,
  ),
  Type.Object(
    {
      kind: Type.Literal('VersionedFormatContextSelection'),
      algorithm: Type.Literal('ExactPublicHistoryV1'),
      formatMarker: Type.Object({ parameter: Type.Literal('formatMarker') }, object),
      triggerPaths: Type.Object({ parameter: Type.Literal('formatPaths') }, object),
      priority: Type.Array(
        Type.Union([Type.Literal('Failure'), Type.Literal('Contract'), Type.Literal('Edit')]),
        { minItems: 3, maxItems: 3, uniqueItems: true },
      ),
      maximumItems: Type.Integer({ minimum: 1, maximum: 8 }),
      maximumContextBytes: Type.Integer({ minimum: 128, maximum: 32768 }),
    },
    object,
  ),
]);
export const harnessPackageInputSchema = Type.Object(
  { publisherAid: said, sourceRevisionSaid: said, behavior: portableBehaviorSchema },
  object,
);
export const harnessPackageSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('PortableHarness'),
    ...harnessPackageInputSchema.properties,
    requiredCapabilities: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
    portabilityProfile: Type.Literal('PortableBehaviorV1'),
    compatibility: Type.Object(
      {
        model: Type.Literal('ConsumerSelected'),
        runtime: Type.Literal('DevrandomPiV1'),
        tools: Type.Literal('DeclaredCapabilities'),
        environment: Type.Literal('ConsumerProvidedRepository'),
      },
      object,
    ),
  },
  object,
);
export type HarnessPackage = Type.Static<typeof harnessPackageSchema>;
export function prepareHarnessPackage(
  input: unknown,
): { readonly kind: 'Prepared'; readonly package: HarnessPackage } | { readonly kind: 'Rejected' } {
  if (
    !Value.Check(harnessPackageInputSchema, input) ||
    (input.behavior.kind === 'Instruction' && !safePortableInstruction(input.behavior.text, []))
  )
    return { kind: 'Rejected' };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'PortableHarness',
      publisherAid: input.publisherAid,
      sourceRevisionSaid: input.sourceRevisionSaid,
      behavior: input.behavior,
      requiredCapabilities: [...portableCapabilities(input.behavior)],
      portabilityProfile: 'PortableBehaviorV1',
      compatibility: {
        model: 'ConsumerSelected',
        runtime: 'DevrandomPiV1',
        tools: 'DeclaredCapabilities',
        environment: 'ConsumerProvidedRepository',
      },
    })[1];
    return Value.Check(harnessPackageSchema, document)
      ? { kind: 'Prepared', package: document }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
}
export function decodeHarnessPackage(
  input: unknown,
): { readonly kind: 'Accepted'; readonly package: HarnessPackage } | { readonly kind: 'Rejected' } {
  if (!Value.Check(harnessPackageSchema, input)) return { kind: 'Rejected' };
  const prepared = prepareHarnessPackage({
    publisherAid: input.publisherAid,
    sourceRevisionSaid: input.sourceRevisionSaid,
    behavior: input.behavior,
  });
  return prepared.kind === 'Prepared' && JSON.stringify(prepared.package) === JSON.stringify(input)
    ? { kind: 'Accepted', package: prepared.package }
    : { kind: 'Rejected' };
}
