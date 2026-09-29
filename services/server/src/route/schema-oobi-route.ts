import {
  credentialSchema,
  credentialSchemaDocumentSchema,
  promotionMandateSchema,
  promotionMandateV2Schema,
  promotionMandateV3Schema,
  taskMandateSchema,
  taskMandateV2Schema,
  taskMandateV3Schema,
  taskMandateV4Schema,
  promotionMandateV4Schema,
  promotionMandateV6Schema,
  promotionMandateV5Schema,
  promotionMandateV7Schema,
  promotionMandateV8Schema,
  promotionMandateV9Schema,
  promotionMandateV10Schema,
  promotionMandateV11Schema,
  taskMandateV5Schema,
  taskMandateV6Schema,
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
  { said: taskMandateV6Schema.$id, body: Buffer.from(JSON.stringify(taskMandateV6Schema), 'utf8') },
  {
    said: promotionMandateV10Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV10Schema), 'utf8'),
  },
  {
    said: promotionMandateV11Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV11Schema), 'utf8'),
  },
  { said: taskMandateV5Schema.$id, body: Buffer.from(JSON.stringify(taskMandateV5Schema), 'utf8') },
  {
    said: promotionMandateV8Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV8Schema), 'utf8'),
  },
  {
    said: promotionMandateV9Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV9Schema), 'utf8'),
  },
  {
    said: promotionMandateV7Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV7Schema), 'utf8'),
  },
  {
    said: promotionMandateV6Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV6Schema), 'utf8'),
  },
  { said: taskMandateV4Schema.$id, body: Buffer.from(JSON.stringify(taskMandateV4Schema), 'utf8') },
  { said: taskMandateV3Schema.$id, body: Buffer.from(JSON.stringify(taskMandateV3Schema), 'utf8') },
  {
    said: promotionMandateV4Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV4Schema), 'utf8'),
  },
  {
    said: promotionMandateV5Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV5Schema), 'utf8'),
  },

  {
    said: credentialSchema.$id,
    body: Buffer.from(JSON.stringify(credentialSchemaResponse), 'utf8'),
  },
  { said: taskMandateSchema.$id, body: Buffer.from(JSON.stringify(taskMandateSchema), 'utf8') },
  { said: taskMandateV2Schema.$id, body: Buffer.from(JSON.stringify(taskMandateV2Schema), 'utf8') },
  {
    said: promotionMandateSchema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateSchema), 'utf8'),
  },
  {
    said: promotionMandateV2Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV2Schema), 'utf8'),
  },
  {
    said: promotionMandateV3Schema.$id,
    body: Buffer.from(JSON.stringify(promotionMandateV3Schema), 'utf8'),
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
