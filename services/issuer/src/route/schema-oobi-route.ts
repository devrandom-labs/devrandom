import { credentialSchema, credentialSchemaDocumentSchema } from '@devrandom/protocol';
import type { FastifyPluginCallback } from 'fastify';
import Type from 'typebox';
import Value from 'typebox/value';

const schemaOobiParams = Type.Object({ said: Type.String() }, { additionalProperties: false });
const credentialSchemaDocument: unknown = JSON.parse(JSON.stringify(credentialSchema));
const credentialSchemaResponse = Value.Parse(
  credentialSchemaDocumentSchema,
  credentialSchemaDocument,
);
const credentialSchemaBody = Buffer.from(JSON.stringify(credentialSchemaResponse), 'utf8');

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
          200: credentialSchemaDocumentSchema,
          404: Type.Null(),
        },
      },
    },
    (request, reply) => {
      if (request.params.said !== credentialSchema.$id) {
        reply.code(404).send(null);
        return;
      }
      reply.code(200).header('content-type', 'application/schema+json').send(credentialSchemaBody);
    },
  );
  done();
};
