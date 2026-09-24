import {
  devrandomUserEligibilityClaims,
  type DevrandomUserEligibilityClaim,
} from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';

export const credentialCapabilities = devrandomUserEligibilityClaims;

export type CredentialCapability = DevrandomUserEligibilityClaim;

const credentialSchemaDefinition = Type.Object(
  {
    v: Type.String({ description: 'Credential format version' }),
    d: Type.String({ description: 'Credential SAID' }),
    i: Type.String({ description: 'Devrandom issuer AID' }),
    ri: Type.String({ description: 'Credential status registry identifier' }),
    s: Type.String({ description: 'Credential schema SAID' }),
    a: Type.Object(
      {
        d: Type.String({ description: 'Attributes block SAID' }),
        i: Type.String({ description: 'User AID' }),
        dt: Type.String({
          description: 'Issuance date and time',
          format: 'date-time',
        }),
        capabilities: Type.Array(Type.Enum(credentialCapabilities), {
          description: 'Devrandom operations for which the user is eligible',
          minItems: credentialCapabilities.length,
          maxItems: credentialCapabilities.length,
          uniqueItems: true,
        }),
      },
      {
        description: 'Credential subject attributes',
        additionalProperties: false,
      },
    ),
  },
  {
    $id: '',
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Devrandom Credential',
    description: 'Issuer-backed eligibility claims for the Devrandom platform',
    credentialType: 'DevrandomCredential',
    version: '1.0.0',
    additionalProperties: false,
  },
);

const [credentialSchemaId] = Saider.saidify(
  credentialSchemaDefinition,
  undefined,
  undefined,
  '$id',
);

export const credentialSchema = {
  ...credentialSchemaDefinition,
  $id: credentialSchemaId.qb64,
};

const describedStringSchemaDocument = Type.Object(
  {
    type: Type.Literal('string'),
    description: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const credentialSchemaDocumentSchema = Type.Object(
  {
    type: Type.Literal('object'),
    required: Type.Tuple([
      Type.Literal('v'),
      Type.Literal('d'),
      Type.Literal('i'),
      Type.Literal('ri'),
      Type.Literal('s'),
      Type.Literal('a'),
    ]),
    properties: Type.Object(
      {
        v: describedStringSchemaDocument,
        d: describedStringSchemaDocument,
        i: describedStringSchemaDocument,
        ri: describedStringSchemaDocument,
        s: describedStringSchemaDocument,
        a: Type.Object(
          {
            type: Type.Literal('object'),
            required: Type.Tuple([
              Type.Literal('d'),
              Type.Literal('i'),
              Type.Literal('dt'),
              Type.Literal('capabilities'),
            ]),
            properties: Type.Object(
              {
                d: describedStringSchemaDocument,
                i: describedStringSchemaDocument,
                dt: Type.Object(
                  {
                    type: Type.Literal('string'),
                    description: Type.String({ minLength: 1 }),
                    format: Type.Literal('date-time'),
                  },
                  { additionalProperties: false },
                ),
                capabilities: Type.Object(
                  {
                    type: Type.Literal('array'),
                    items: Type.Object(
                      {
                        enum: Type.Tuple([
                          Type.Literal(credentialCapabilities[0]),
                          Type.Literal(credentialCapabilities[1]),
                          Type.Literal(credentialCapabilities[2]),
                          Type.Literal(credentialCapabilities[3]),
                          Type.Literal(credentialCapabilities[4]),
                        ]),
                      },
                      { additionalProperties: false },
                    ),
                    description: Type.String({ minLength: 1 }),
                    minItems: Type.Literal(credentialCapabilities.length),
                    maxItems: Type.Literal(credentialCapabilities.length),
                    uniqueItems: Type.Literal(true),
                  },
                  { additionalProperties: false },
                ),
              },
              { additionalProperties: false },
            ),
            description: Type.String({ minLength: 1 }),
            additionalProperties: Type.Literal(false),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    $id: Type.Literal(credentialSchema.$id),
    $schema: Type.Literal('http://json-schema.org/draft-07/schema#'),
    title: Type.Literal('Devrandom Credential'),
    description: Type.String({ minLength: 1 }),
    credentialType: Type.Literal('DevrandomCredential'),
    version: Type.Literal('1.0.0'),
    additionalProperties: Type.Literal(false),
  },
  { additionalProperties: false },
);

export type CredentialSchemaDocument = Type.Static<typeof credentialSchemaDocumentSchema>;

export type CredentialPayload = Type.Static<typeof credentialSchemaDefinition>;
