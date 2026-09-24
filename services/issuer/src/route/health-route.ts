import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';

import {
  type IssuerHealth,
  issuerHealthSchema,
  type IssuerUnavailable,
  issuerUnavailableSchema,
} from '@devrandom/protocol';

export interface IssuerReadinessProbe {
  verify(): Promise<void>;
}

export type IssuerHealthIdentity = Pick<
  IssuerHealth,
  'issuerAid' | 'issuerOobi' | 'registryId' | 'schemaId'
>;

const unavailableIssuer = {
  service: 'issuer',
  status: 'unavailable',
} satisfies IssuerUnavailable;

export function healthRoute(
  readiness: IssuerReadinessProbe,
  identity: IssuerHealthIdentity,
): FastifyPluginCallbackTypebox {
  const readyIssuer = {
    service: 'issuer',
    status: 'ready',
    ...identity,
  } satisfies IssuerHealth;
  return (server, _options, done) => {
    server.get(
      '/health',
      {
        schema: {
          operationId: 'getIssuerHealth',
          response: {
            200: issuerHealthSchema,
            503: issuerUnavailableSchema,
          },
        },
      },
      async (_request, reply) => {
        try {
          await readiness.verify();
          await reply.code(200).send(readyIssuer);
        } catch {
          await reply.code(503).send(unavailableIssuer);
        }
      },
    );
    done();
  };
}
