import Type from 'typebox';
import { runParametersSchema } from './run-http.js';

export const runSuccessorSegmentParametersSchema = Type.Object(
  {
    ...runParametersSchema.properties,
    segmentSaid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
  },
  { additionalProperties: false },
);
