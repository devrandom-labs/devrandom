import Type from 'typebox';

export const serverLivenessSchema = Type.Object(
  {
    service: Type.Literal('devrandom-server'),
    status: Type.Literal('live'),
  },
  { additionalProperties: false },
);

export type ServerLiveness = Type.Static<typeof serverLivenessSchema>;

export const hostedWorkReadySchema = Type.Object(
  {
    service: Type.Literal('hosted-work'),
    status: Type.Literal('ready'),
    workAccessPolicy: Type.Object(
      {
        version: Type.Literal('work-access-policy/1'),
        fingerprint: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
        grantLifetimeSeconds: Type.Integer({ minimum: 1, maximum: 1_800 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type HostedWorkReady = Type.Static<typeof hostedWorkReadySchema>;

export const hostedWorkUnavailableSchema = Type.Object(
  {
    service: Type.Literal('hosted-work'),
    status: Type.Literal('unavailable'),
  },
  { additionalProperties: false },
);

export type HostedWorkUnavailable = Type.Static<typeof hostedWorkUnavailableSchema>;
