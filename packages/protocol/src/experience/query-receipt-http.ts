import { Buffer } from 'node:buffer';

import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { evidenceArtifactSchema } from '../evidence/evidence-artifact.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const experienceQueryReceiptReadParametersSchema = Type.Object(
  { receiptSaid: said },
  { additionalProperties: false },
);
export const experienceQueryReceiptReadQuerySchema = Type.Object(
  {
    taskId: uuid,
    sourceInventorySaid: said,
    offset: Type.String({ pattern: '^(0|[1-9][0-9]{0,5})$' }),
    maximumBytes: Type.String({ pattern: '^[1-9][0-9]{0,4}$' }),
  },
  { additionalProperties: false },
);
export const experienceQueryReceiptReadResponseSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('Read'),
    artifact: evidenceArtifactSchema,
    totalBytes: Type.Integer({ minimum: 0, maximum: 32 * 1024 }),
    offset: Type.Integer({ minimum: 0, maximum: 32 * 1024 }),
    bytesBase64Url: Type.String({ maxLength: 43_691, pattern: '^[A-Za-z0-9_-]*$' }),
  },
  { additionalProperties: false },
);

export type ExperienceQueryReceiptReadResponse = Type.Static<
  typeof experienceQueryReceiptReadResponseSchema
>;

export function decodeExperienceQueryReceiptReadQuery(input: unknown):
  | {
      readonly kind: 'Accepted';
      readonly query: {
        readonly taskId: string;
        readonly sourceInventorySaid: string;
        readonly offset: number;
        readonly maximumBytes: number;
      };
    }
  | { readonly kind: 'Rejected' } {
  if (!Value.Check(experienceQueryReceiptReadQuerySchema, input)) return { kind: 'Rejected' };
  const offset = Number(input.offset);
  const maximumBytes = Number(input.maximumBytes);
  if (offset > 512 * 1024 || maximumBytes > 32 * 1024) return { kind: 'Rejected' };
  return {
    kind: 'Accepted',
    query: {
      taskId: input.taskId,
      sourceInventorySaid: input.sourceInventorySaid,
      offset,
      maximumBytes,
    },
  };
}

export function decodeExperienceQueryReceiptReadResponse(input: unknown):
  | {
      readonly kind: 'Accepted';
      readonly response: ExperienceQueryReceiptReadResponse;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected' } {
  if (!Value.Check(experienceQueryReceiptReadResponseSchema, input)) return { kind: 'Rejected' };
  const bytes = Buffer.from(input.bytesBase64Url, 'base64url');
  let artifactMatches: boolean;
  try {
    artifactMatches = new Saider({ qb64: input.artifact.d }).verify(input.artifact, true, false);
  } catch {
    artifactMatches = false;
  }
  if (
    !artifactMatches ||
    bytes.toString('base64url') !== input.bytesBase64Url ||
    bytes.byteLength > 32 * 1024 ||
    input.offset + bytes.byteLength > input.totalBytes ||
    input.artifact.byteLength !== input.totalBytes
  )
    return { kind: 'Rejected' };
  return { kind: 'Accepted', response: input, bytes };
}
