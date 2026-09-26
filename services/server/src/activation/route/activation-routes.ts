import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import {
  activationCommitCommandSchema,
  activationCommitReceiptSchema,
  workAccessAuthorizationHeadersSchema,
  type ActivationCommitCommand,
  type ActivationCommitReceipt,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

const taskParameters = Type.Object(
  {
    taskId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);
const problem = Type.Object(
  {
    code: Type.String(),
    correlationId: Type.String(),
    status: Type.Integer(),
    title: Type.String(),
    type: Type.String(),
  },
  { additionalProperties: false },
);

export interface ActivationRoutesConfiguration {
  readonly access: {
    authorize(input: {
      readonly bearerSecret: string;
      readonly scope: 'activation:commit';
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    >;
  };
  readonly activation: {
    commit(input: {
      readonly ownerAid: string;
      readonly command: ActivationCommitCommand;
    }): Promise<ActivationCommitReceipt>;
  };
  now(): string;
  newCorrelationId(): string;
}

export function activationRoutes(
  configuration: ActivationRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      const [first] = Errors(schema, input);
      return {
        error: Object.assign(new Error(first?.message ?? 'invalid activation request'), {
          statusCode: 400,
        }),
      };
    });
    server.setErrorHandler(async (error, _request, reply) => {
      const reportedStatus =
        error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const status = reportedStatus === 400 ? 400 : reportedStatus === 413 ? 413 : 500;
      const code =
        status === 400
          ? 'ActivationRequestInvalid'
          : status === 413
            ? 'ActivationBodyTooLarge'
            : 'ActivationUnavailable';
      await reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://devrandom.example/problems/${code.toLowerCase()}`,
          title: code,
          status,
          code,
          correlationId: configuration.newCorrelationId(),
        });
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    const fail = async (reply: FastifyReply, status: number, code: string) =>
      reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://devrandom.example/problems/${code.toLowerCase()}`,
          title: code,
          status,
          code,
          correlationId: configuration.newCorrelationId(),
        });

    server.put(
      '/api/tasks/:taskId/activation',
      {
        bodyLimit: 256 * 1_024,
        schema: {
          operationId: 'commitActivation',
          headers: workAccessAuthorizationHeadersSchema,
          params: taskParameters,
          body: activationCommitCommandSchema,
          response: {
            200: activationCommitReceiptSchema,
            201: activationCommitReceiptSchema,
            400: problem,
            403: problem,
            409: problem,
            422: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await configuration.access.authorize({
          bearerSecret: request.headers.authorization.slice('Bearer '.length),
          scope: 'activation:commit',
          observedAt: configuration.now(),
        });
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'ActivationAccessDenied');
        if (request.params.taskId !== request.body.taskId)
          return fail(reply, 400, 'ActivationTaskBindingRejected');
        const receipt = await configuration.activation.commit({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        if (receipt.kind === 'Committed' || receipt.kind === 'AlreadyCommitted')
          return reply.code(receipt.kind === 'Committed' ? 201 : 200).send(receipt);
        const status = receipt.kind === 'Conflict' ? 409 : receipt.kind === 'Rejected' ? 422 : 503;
        return fail(reply, status, `Activation${receipt.kind}`);
      },
    );
    done();
  };
}
