import { portableHarnessVerificationSchema } from './portable-verification.js';
import Type from 'typebox';
import { harnessPackageSchema } from './harness-package.js';
import { successorHarnessRevisionSchema } from '../harness/successor-revision.js';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const object = { additionalProperties: false } as const;
export const publicationExchangeRoute = '/devrandom/harness/publication/1';
export const publicationSignatureSchema = Type.Object(
  {
    exchange: Type.Unknown(),
    signatures: Type.Array(Type.String({ minLength: 88, maxLength: 200 }), {
      minItems: 1,
      maxItems: 1,
    }),
    keyStateSaid: said,
  },
  object,
);
export const publishedHarnessSchema = Type.Object(
  {
    package: harnessPackageSchema,
    verification: portableHarnessVerificationSchema,
    signature: publicationSignatureSchema,
  },
  object,
);
export const publishHarnessCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    taskId: uuid,
    activationReceiptSaid: said,
    sourceRevision: successorHarnessRevisionSchema,
    configurationBase64: Type.String({ minLength: 4, maxLength: 45000 }),
    implementationBase64: Type.Optional(Type.String({ minLength: 4, maxLength: 175000 })),
    published: publishedHarnessSchema,
  },
  object,
);
export type PublicationSignature = Type.Static<typeof publicationSignatureSchema>;
export type PublishedHarness = Type.Static<typeof publishedHarnessSchema>;
export type PublishHarnessCommand = Type.Static<typeof publishHarnessCommandSchema>;
export const publicationAdmissionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('Published'), packageSaid: said }, object),
  Type.Object({ kind: Type.Literal('AlreadyPublished'), packageSaid: said }, object),
  Type.Object(
    {
      kind: Type.Union([
        Type.Literal('Rejected'),
        Type.Literal('Conflict'),
        Type.Literal('Unavailable'),
      ]),
    },
    object,
  ),
]);
export type PublicationAdmission = Type.Static<typeof publicationAdmissionSchema>;
export const privateHarnessForkSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('PrivateHarnessFork'),
    commandId: uuid,
    lineageId: uuid,
    sourcePackageSaid: said,
    behavior: harnessPackageSchema.properties.behavior,
    requiredCapabilities: harnessPackageSchema.properties.requiredCapabilities,
  },
  object,
);
export type PrivateHarnessFork = Type.Static<typeof privateHarnessForkSchema>;
