import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import Type from 'typebox';
import Value from 'typebox/value';

import type {
  EvidenceTimelineCursor,
  EvidenceTimelineCursorDecoding,
} from '../application/evidence-timeline-cursor.js';

const cursorPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    ownerAid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
    runId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
    afterSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

type CursorPayload = Type.Static<typeof cursorPayloadSchema>;

export class HmacEvidenceTimelineCursor implements EvidenceTimelineCursor {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength < 32) {
      throw new Error('Evidence timeline cursor key must contain at least 32 bytes');
    }
    this.#key = Uint8Array.from(key);
  }

  encode(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly afterSequence: number;
  }): string {
    const payload: CursorPayload = { version: 1, ...input };
    if (!Value.Check(cursorPayloadSchema, payload)) {
      throw new Error('Evidence timeline cursor input is invalid');
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encodedPayload}.${this.#signature(encodedPayload).toString('base64url')}`;
  }

  decode(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly cursor: string;
  }): EvidenceTimelineCursorDecoding {
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
      if (signature.toString('base64url') !== encodedSignature) {
        return { kind: 'CursorRejected' };
      }
      const expected = this.#signature(encodedPayload);
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        return { kind: 'CursorRejected' };
      }
      const untrusted: unknown = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
      if (
        !Value.Check(cursorPayloadSchema, untrusted) ||
        untrusted.ownerAid !== input.ownerAid ||
        untrusted.runId !== input.runId ||
        untrusted.limit !== input.limit
      ) {
        return { kind: 'CursorRejected' };
      }
      return { kind: 'CursorAccepted', afterSequence: untrusted.afterSequence };
    } catch {
      return { kind: 'CursorRejected' };
    }
  }

  #signature(encodedPayload: string): Buffer {
    return createHmac('sha256', this.#key).update(encodedPayload).digest();
  }
}
