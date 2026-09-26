import { taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  exactEvidenceReadingSchema,
  workAccessAuthorizationHeadersSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type { EvidenceReadOutcome, ExactEvidenceReading } from '../application/read-evidence.js';

const readingResponse = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('Read'),
    bytesBase64Url: Type.String({ pattern: '^[A-Za-z0-9_-]*$' }),
    totalBytes: Type.Integer({ minimum: 0 }),
    sourceSaid: Type.String(),
    readReceiptSaid: Type.String(),
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

export interface EvidenceReadRoutesConfiguration {
  readonly access: {
    authorize(input: {
      readonly bearerSecret: string;
      readonly scope: 'evidence:read';
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    >;
  };
  readonly conversation: {
    read(input: {
      readonly ownerAid: string;
      readonly query: ExactEvidenceReading;
    }): Promise<EvidenceReadOutcome>;
  };
  now(): string;
  newCorrelationId(): string;
}

export function evidenceReadRoutes(
  configuration: EvidenceReadRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      const [first] = Errors(schema, input);
      return {
        error: Object.assign(new Error(first?.message ?? 'invalid evidence read'), {
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
          ? 'EvidenceReadRequestInvalid'
          : status === 413
            ? 'EvidenceReadBodyTooLarge'
            : 'EvidenceReadUnavailable';
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
      '/api/evidence/read',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'readExactEvidence',
          headers: workAccessAuthorizationHeadersSchema,
          body: exactEvidenceReadingSchema,
          response: {
            200: readingResponse,
            400: problem,
            403: problem,
            404: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await configuration.access.authorize({
          bearerSecret: request.headers.authorization.slice('Bearer '.length),
          scope: 'evidence:read',
          observedAt: configuration.now(),
        });
        const outcome =
          access.kind === 'Authorized'
            ? await configuration.conversation.read({
                ownerAid: access.ownerAid,
                query: request.body,
              })
            : ({ kind: access.kind } as const);
        if (outcome.kind === 'Read')
          return reply
            .code(200)
            .header('cache-control', 'no-store')
            .send({
              version: 1,
              kind: 'Read',
              bytesBase64Url: Buffer.from(outcome.bytes).toString('base64url'),
              totalBytes: outcome.totalBytes,
              sourceSaid: outcome.sourceSaid,
              readReceiptSaid: outcome.readReceiptSaid,
            });
        const status =
          outcome.kind === 'NotFound' ? 404 : outcome.kind === 'Unavailable' ? 503 : 403;
        const code = `EvidenceRead${outcome.kind}`;
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
