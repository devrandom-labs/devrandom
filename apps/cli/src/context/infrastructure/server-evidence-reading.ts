import { Buffer } from 'node:buffer';

import {
  decodeEvaluationSourceInventory,
  exactEvidenceReadingSchema,
  prepareEvidenceArtifact,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import type { EvidenceReading } from '@devrandom/runtime';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const readingResponse = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('Read'),
    bytesBase64Url: Type.String({ maxLength: 43_691, pattern: '^[A-Za-z0-9_-]*$' }),
    totalBytes: Type.Integer({ minimum: 0, maximum: 512 * 1024 }),
    sourceSaid: said,
    readReceiptSaid: said,
  },
  { additionalProperties: false },
);
const problem = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    correlationId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    title: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** HTTP adapter for one exact, current, owner-scoped source inventory. */
export class ServerEvidenceReading implements EvidenceReading {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #inventory: EvaluationSourceInventory;
  readonly #fetch: DevrandomFetch;

  constructor(
    origin: DevrandomServerOrigin,
    bearer: string,
    sourceInventory: EvaluationSourceInventory,
    fetch: DevrandomFetch,
  ) {
    const inventory = decodeEvaluationSourceInventory(sourceInventory);
    if (inventory.kind !== 'Accepted') throw new Error('Context source inventory invalid');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('Context bearer invalid');
    this.#origin = origin;
    this.#bearer = bearer;
    this.#inventory = inventory.inventory;
    this.#fetch = fetch;
  }

  async read(input: Parameters<EvidenceReading['read']>[0]): ReturnType<EvidenceReading['read']> {
    const query = { version: 1 as const, ...input };
    if (
      !Value.Check(exactEvidenceReadingSchema, query) ||
      input.taskId !== this.#inventory.taskId ||
      input.sourceInventorySaid !== this.#inventory.d
    )
      return { kind: 'Denied' };
    const source = this.#inventory.sources.find(
      (candidate) => candidate.rawEvidenceSaid === input.evidenceSaid,
    );
    if (source === undefined) return { kind: 'NotFound' };
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/api/evidence/read`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { kind: 'Unavailable' };
    }
    if (response.headers.get('cache-control') !== 'no-store') return { kind: 'Unavailable' };
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      return { kind: 'Unavailable' };
    }
    if (response.status === 200) {
      if (!Value.Check(readingResponse, body) || body.sourceSaid !== source.episodeSaid)
        return { kind: 'Unavailable' };
      const bytes = Buffer.from(body.bytesBase64Url, 'base64url');
      if (
        bytes.toString('base64url') !== body.bytesBase64Url ||
        bytes.byteLength > input.maximumBytes ||
        input.offset + bytes.byteLength > body.totalBytes ||
        (input.offset < body.totalBytes && bytes.byteLength === 0)
      )
        return { kind: 'Unavailable' };
      const receiptBytes = new TextEncoder().encode(
        JSON.stringify({
          ownerAid: this.#inventory.ownerAid,
          taskId: input.taskId,
          sourceInventorySaid: input.sourceInventorySaid,
          episodeSaid: source.episodeSaid,
          evidenceSaid: input.evidenceSaid,
          offset: input.offset,
          returnedBytes: bytes.byteLength,
          totalBytes: body.totalBytes,
        }),
      );
      const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
      if (receipt.kind !== 'Prepared' || receipt.artifact.d !== body.readReceiptSaid)
        return { kind: 'Unavailable' };
      return {
        kind: 'Read',
        bytes: Uint8Array.from(bytes),
        totalBytes: body.totalBytes,
        sourceSaid: body.sourceSaid,
        readReceiptSaid: body.readReceiptSaid,
      };
    }
    if (!Value.Check(problem, body) || body.status !== response.status)
      return { kind: 'Unavailable' };
    if (response.status === 404 && body.code === 'EvidenceReadNotFound')
      return { kind: 'NotFound' };
    if (response.status === 403 && body.code === 'EvidenceReadDenied') return { kind: 'Denied' };
    return { kind: 'Unavailable' };
  }
}
