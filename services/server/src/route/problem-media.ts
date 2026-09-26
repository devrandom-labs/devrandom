import type { SwaggerTransform } from '@fastify/swagger';

const problemTypePrefix = 'https://devrandom.example/problems/';

interface RouteSchemaDeclaration {
  readonly [property: string]: unknown;
}

function schemaDeclaration(value: unknown): RouteSchemaDeclaration | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RouteSchemaDeclaration)
    : undefined;
}

function isProblemSchema(value: unknown): boolean {
  const schema = schemaDeclaration(value);
  if (schema === undefined) return false;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.length > 0 && schema.anyOf.every(isProblemSchema);
  }
  const properties = schemaDeclaration(schema.properties);
  const type = schemaDeclaration(properties?.type);
  const status = schemaDeclaration(properties?.status);
  return (
    typeof type?.const === 'string' &&
    type.const.startsWith(problemTypePrefix) &&
    typeof status?.const === 'number'
  );
}

export const problemMediaOpenApiTransform: SwaggerTransform = ({ schema, url }) => {
  const response = schemaDeclaration(schema.response);
  if (response === undefined) return { schema, url };

  const converted = Object.fromEntries(
    Object.entries(response).map(([status, declaration]) => {
      const declared = schemaDeclaration(declaration);
      if (declared === undefined || !isProblemSchema(declared)) return [status, declaration];
      const { headers, description, ...body } = declared;
      return [
        status,
        {
          ...(headers === undefined ? {} : { headers }),
          ...(description === undefined ? {} : { description }),
          content: { 'application/problem+json': { schema: body } },
        },
      ];
    }),
  );
  return { schema: { ...schema, response: converted }, url };
};
