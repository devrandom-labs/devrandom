import Type from 'typebox';

export const issuerHealthSchema = Type.Object(
  {
    service: Type.Literal('issuer'),
    status: Type.Literal('ready'),
    issuerAid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
    issuerOobi: Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^#]+$' }),
    registryId: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
    schemaId: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
  },
  { additionalProperties: false },
);

export type IssuerHealth = Type.Static<typeof issuerHealthSchema>;

export const issuerUnavailableSchema = Type.Object(
  {
    service: Type.Literal('issuer'),
    status: Type.Literal('unavailable'),
  },
  { additionalProperties: false },
);

export type IssuerUnavailable = Type.Static<typeof issuerUnavailableSchema>;
