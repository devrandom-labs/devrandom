import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import Type from 'typebox';
import Value from 'typebox/value';

import type { TaskPageCursor, TaskCursorDecoding } from '../application/task-page-cursor.js';

const cursorPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    ownerAid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    createdAt: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    }),
    taskId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

type CursorPayload = Type.Static<typeof cursorPayloadSchema>;

export class HmacTaskPageCursor implements TaskPageCursor {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32) {
      throw new Error('Task page cursor key must contain at least 32 bytes');
    }
    this.#key = Uint8Array.from(key);
  }

  encode(input: {
    readonly ownerAid: string;
    readonly limit: number;
    readonly position: { readonly createdAt: string; readonly taskId: string };
  }): string {
    const payload: CursorPayload = {
      version: 1,
      ownerAid: input.ownerAid,
      limit: input.limit,
      createdAt: input.position.createdAt,
      taskId: input.position.taskId,
    };
    if (!Value.Check(cursorPayloadSchema, payload)) {
      throw new Error('Task page cursor input is invalid');
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encodedPayload}.${this.#signature(encodedPayload).toString('base64url')}`;
  }

  decode(input: {
    readonly ownerAid: string;
    readonly limit: number;
    readonly cursor: string;
  }): TaskCursorDecoding {
    const segments = input.cursor.split('.');
    const encodedPayload = segments[0];
    const encodedSignature = segments[1];
    if (
      segments.length !== 2 ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      encodedPayload.length === 0 ||
      encodedSignature.length === 0
    ) {
      return { kind: 'CursorRejected' };
    }
    try {
      const signature = Buffer.from(encodedSignature, 'base64url');
      const expected = this.#signature(encodedPayload);
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        return { kind: 'CursorRejected' };
      }
      const untrusted: unknown = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
      if (!Value.Check(cursorPayloadSchema, untrusted)) {
        return { kind: 'CursorRejected' };
      }
      if (untrusted.ownerAid !== input.ownerAid || untrusted.limit !== input.limit) {
        return { kind: 'CursorRejected' };
      }
      return {
        kind: 'CursorAccepted',
        position: { createdAt: untrusted.createdAt, taskId: untrusted.taskId },
      };
    } catch {
      return { kind: 'CursorRejected' };
    }
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac('sha256', this.#key).update(encodedPayload).digest();
  }
}
