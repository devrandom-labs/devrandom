import {
  credentialSchema,
  credentialSchemaDocumentSchema,
  promotionMandateSchema,
  taskMandateSchema,
} from '@devrandom/protocol';
import type { FastifyPluginCallback } from 'fastify';
import Type from 'typebox';
import Value from 'typebox/value';

const schemaOobiParams = Type.Object({ said: Type.String() }, { additionalProperties: false });
const credentialSchemaDocument: unknown = JSON.parse(JSON.stringify(credentialSchema));
const credentialSchemaResponse = Value.Parse(
  credentialSchemaDocumentSchema,
  credentialSchemaDocument,
);
interface PublishedSchema {
  readonly said: string;
  readonly body: Buffer;
}

const publishedSchemas: readonly PublishedSchema[] = [
  {
    said: credentialSchema.$id,
    body: Buffer.from(JSON.stringify(credentialSchemaResponse), 'utf8'),
  },
  { said: taskMandateSchema.$id, body: Buffer.from(JSON.stringify(taskMandateSchema), 'utf8') },
  {
    said: promotionMandateSchema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateSchema), 'utf8'),
  },
];

export const schemaOobiRoute: FastifyPluginCallback = (server, _options, done) => {
  server.get<{ Params: Type.Static<typeof schemaOobiParams> }>(
    '/oobi/:said',
    {
      schema: {
        hide: true,
        operationId: 'getCredentialSchema',
        produces: ['application/schema+json'],
        params: schemaOobiParams,
        response: {
          200: Type.Unknown(),
          404: Type.Null(),
        },
      },
    },
    (request, reply) => {
      const schema = publishedSchemas.find((candidate) => candidate.said === request.params.said);
      if (schema === undefined) {
        reply.code(404).send(null);
        return;
      }
      reply.code(200).header('content-type', 'application/schema+json').send(schema.body);
    },
  );
  done();
};
