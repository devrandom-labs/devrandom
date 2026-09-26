import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  publicationAdmissionSchema,
  publishHarnessCommandSchema,
  publishedHarnessSchema,
  workAccessAuthorizationHeadersSchema,
  type PublicationAdmission,
  type PublishHarnessCommand,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';
import type { HarnessPublicationStorage } from '../application/publish-harness.js';
export interface PublicationRoutesConfiguration {
  readonly access: {
    authorize(input: {
      readonly bearerSecret: string;
      readonly scope: 'harness:publish';
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    >;
  };
  readonly publication: {
    publish(input: {
      readonly ownerAid: string;
      readonly command: PublishHarnessCommand;
    }): Promise<PublicationAdmission>;
    read: HarnessPublicationStorage['read'];
  };
  now(): string;
}
export function publicationRoutes(
  configuration: PublicationRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      return {
        error: Object.assign(
          new Error(Errors(schema, input)[0]?.message ?? 'Invalid publication'),
          { statusCode: 400 },
        ),
      };
    });
    server.put(
      '/api/harness-packages/:packageSaid',
      {
        bodyLimit: 256 * 1024,
        schema: {
          operationId: 'publishHarnessPackage',
          headers: workAccessAuthorizationHeadersSchema,
          params: Type.Object(
            { packageSaid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }) },
            { additionalProperties: false },
          ),
          body: publishHarnessCommandSchema,
          response: {
            200: publicationAdmissionSchema,
            201: publicationAdmissionSchema,
            403: publicationAdmissionSchema,
            409: publicationAdmissionSchema,
            422: publicationAdmissionSchema,
            503: publicationAdmissionSchema,
          },
        },
      },
      async (request, reply) => {
        const access = await configuration.access.authorize({
          bearerSecret: request.headers.authorization.slice('Bearer '.length),
          scope: 'harness:publish',
          observedAt: configuration.now(),
        });
        if (access.kind !== 'Authorized')
          return reply
            .code(access.kind === 'Unavailable' ? 503 : 403)
            .send({ kind: access.kind === 'Unavailable' ? 'Unavailable' : 'Rejected' });
        if (request.params.packageSaid !== request.body.published.package.d)
          return reply.code(422).send({ kind: 'Rejected' });
        const admission = await configuration.publication.publish({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        return reply
          .code(
            admission.kind === 'Published'
              ? 201
              : admission.kind === 'AlreadyPublished'
                ? 200
                : admission.kind === 'Conflict'
                  ? 409
                  : admission.kind === 'Rejected'
                    ? 422
                    : 503,
          )
          .send(admission);
      },
    );
    server.get(
      '/api/harness-packages/:packageSaid',
      {
        schema: {
          operationId: 'fetchHarnessPackage',
          params: Type.Object(
            { packageSaid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }) },
            { additionalProperties: false },
          ),
          response: {
            200: publishedHarnessSchema,
            404: publicationAdmissionSchema,
            503: publicationAdmissionSchema,
          },
        },
      },
      async (request, reply) => {
        const found = await configuration.publication.read(request.params.packageSaid);
        return found.kind === 'Read'
          ? reply.code(200).send(found.published)
          : reply
              .code(found.kind === 'Absent' ? 404 : 503)
              .send({ kind: found.kind === 'Absent' ? 'Rejected' : 'Unavailable' });
      },
    );
    done();
  };
}
