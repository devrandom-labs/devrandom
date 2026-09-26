type MongoSchemaScalar = boolean | number | string | null;
export type MongoSchemaValue = MongoSchemaScalar | MongoSchemaObject | readonly MongoSchemaValue[];

export interface MongoSchemaObject {
  [keyword: string]: MongoSchemaValue | undefined;
}

export class TypeboxMongoSchemaInvalid extends Error {
  constructor() {
    super('TypeboxMongoSchemaInvalid');
    this.name = 'TypeboxMongoSchemaInvalid';
  }
}

export function typeboxMongoSchema(input: unknown): MongoSchemaValue {
  if (
    input === null ||
    typeof input === 'boolean' ||
    typeof input === 'number' ||
    typeof input === 'string'
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((member: unknown) => typeboxMongoSchema(member));
  }
  if (typeof input !== 'object') {
    throw new TypeboxMongoSchemaInvalid();
  }
  const output: MongoSchemaObject = {};
  for (const keyword of Object.keys(input)) {
    const value: unknown = Reflect.get(input, keyword);
    if (keyword === 'const') {
      output['enum'] = [typeboxMongoSchema(value)];
    } else if (keyword === 'type' && value === 'integer') {
      output['bsonType'] = 'number';
      output['multipleOf'] = 1;
    } else if (keyword === 'pattern' && typeof value === 'string') {
      output[keyword] = value.replace(/\\u([0-9a-f]{4})/giu, '\\x{$1}');
    } else {
      output[keyword] = typeboxMongoSchema(value);
    }
  }
  return output;
}
