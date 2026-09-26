import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';

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
    const sendIdentityReadiness = async (reply: FastifyReply): Promise<void> => {
      try {
        await readiness.verify();
        await reply.code(200).send(readyIssuer);
      } catch {
        await reply.code(503).send(unavailableIssuer);
      }
    };
    const identityResponse = {
      200: issuerHealthSchema,
      503: issuerUnavailableSchema,
    };
    server.get(
      '/health',
      {
        schema: {
          operationId: 'getIssuerHealth',
          response: identityResponse,
        },
      },
      async (_request, reply) => sendIdentityReadiness(reply),
    );
    server.get(
      '/ready/identity',
      {
        schema: {
          operationId: 'getIdentityReadiness',
          response: identityResponse,
        },
      },
      async (_request, reply) => sendIdentityReadiness(reply),
    );
    done();
  };
}
