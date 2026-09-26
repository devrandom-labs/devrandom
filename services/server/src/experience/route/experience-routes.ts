import { taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  experienceQueryReceiptSchema,
  experienceQuerySchema,
  workAccessAuthorizationHeadersSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type {
  ExperienceQuery,
  ExperienceRetrievalOutcome,
} from '../application/retrieve-experience.js';

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

export interface ExperienceRoutesConfiguration {
  readonly access: {
    authorize(input: {
      readonly bearerSecret: string;
      readonly scope: 'experience:retrieve';
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    >;
  };
  readonly conversation: {
    retrieve(input: {
      readonly ownerAid: string;
      readonly query: ExperienceQuery;
    }): Promise<ExperienceRetrievalOutcome>;
  };
  now(): string;
  newCorrelationId(): string;
}

export function experienceRoutes(
  configuration: ExperienceRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      const [first] = Errors(schema, input);
      return {
        error: Object.assign(new Error(first?.message ?? 'invalid experience query'), {
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
          ? 'ExperienceRequestInvalid'
          : status === 413
            ? 'ExperienceBodyTooLarge'
            : 'ExperienceUnavailable';
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
    server.post(
      '/api/experience/query',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'retrieveAnalogousExperience',
          headers: workAccessAuthorizationHeadersSchema,
          body: experienceQuerySchema,
          response: {
            200: experienceQueryReceiptSchema,
            400: problem,
            403: problem,
            422: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await configuration.access.authorize({
          bearerSecret: request.headers.authorization.slice('Bearer '.length),
          scope: 'experience:retrieve',
          observedAt: configuration.now(),
        });
        const outcome =
          access.kind === 'Authorized'
            ? await configuration.conversation.retrieve({
                ownerAid: access.ownerAid,
                query: request.body,
              })
            : ({ kind: access.kind } as const);
        if (outcome.kind === 'Retrieved')
          return reply
            .code(200)
            .header('cache-control', 'no-store')
            .send({
              version: 1,
              kind: 'Retrieved',
              sources: [...outcome.sources],
              queryReceiptSaid: outcome.queryReceiptSaid,
              chargedMicroUsd: outcome.chargedMicroUsd,
            });
        const status =
          outcome.kind === 'Unavailable' || outcome.kind === 'IndexNotReady'
            ? 503
            : outcome.kind === 'Irrelevant'
              ? 422
              : 403;
        const code = `Experience${outcome.kind}`;
        return reply
          .code(status)
          .type('application/problem+json')
          .header('cache-control', 'no-store')
          .send({
            type: `https://devrandom.example/problems/${code.toLowerCase()}`,
            title: code,
            status,
            code,
            correlationId: configuration.newCorrelationId(),
          });
      },
    );
    done();
  };
}
