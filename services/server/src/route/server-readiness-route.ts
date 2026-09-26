import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';

import {
  type HostedWorkReady,
  hostedWorkReadySchema,
  type HostedWorkUnavailable,
  hostedWorkUnavailableSchema,
  type ServerLiveness,
  serverLivenessSchema,
} from '@devrandom/protocol';

export interface HostedWorkReadinessProbe {
  verify(): Promise<void>;
}

const liveServer = {
  service: 'devrandom-server',
  status: 'live',
} satisfies ServerLiveness;

const unavailableHostedWork = {
  service: 'hosted-work',
  status: 'unavailable',
} satisfies HostedWorkUnavailable;

export function serverReadinessRoute(
  readiness: HostedWorkReadinessProbe,
  workAccessPolicy: HostedWorkReady['workAccessPolicy'],
): FastifyPluginCallbackTypebox {
  const readyHostedWork = {
    service: 'hosted-work',
    status: 'ready',
    workAccessPolicy,
  } satisfies HostedWorkReady;
  return (server, _options, done) => {
    server.get(
      '/health/live',
      {
        schema: {
          operationId: 'getServerLiveness',
          response: { 200: serverLivenessSchema },
        },
      },
      async (_request, reply) => reply.code(200).send(liveServer),
    );
    server.get(
      '/ready/work',
      {
        schema: {
          operationId: 'getWorkReadiness',
          response: {
            200: hostedWorkReadySchema,
            503: hostedWorkUnavailableSchema,
          },
        },
      },
      async (_request, reply) => {
        try {
          await readiness.verify();
          await reply.code(200).send(readyHostedWork);
        } catch {
          await reply.code(503).send(unavailableHostedWork);
        }
      },
    );
    done();
  };
}
