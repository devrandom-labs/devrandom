import {
  decodeEvidenceArtifact,
  decodeEvaluationSourceInventory,
  decodeExperienceQueryReceiptReadResponse,
  experienceQueryReceiptSchema,
  experienceQuerySchema,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import type { ExperienceRetrieval } from '@devrandom/runtime';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const source = Type.Object(
  {
    episodeSaid: said,
    rawEvidenceSaid: said,
    score: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const rawQueryReceipt = Type.Object(
  {
    ownerAid: said,
    taskId: uuid,
    sourceInventorySaid: said,
    corpusSaid: said,
    failureQuery: Type.String({ minLength: 1, maxLength: 1024 }),
    sources: Type.Array(source, { minItems: 1, maxItems: 3 }),
    chargedMicroUsd: Type.Integer({ minimum: 0 }),
    indexName: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
    modelVersion: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const problem = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    correlationId: uuid,
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    title: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** HTTP adapter for current scoped Atlas leads, verified against exact raw receipt custody. */
export class ServerExperienceRetrieval implements ExperienceRetrieval {
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

  async retrieve(
    input: Parameters<ExperienceRetrieval['retrieve']>[0],
  ): ReturnType<ExperienceRetrieval['retrieve']> {
    const query = {
      version: 1 as const,
      taskId: input.taskId,
      sourceInventorySaid: input.sourceInventorySaid,
      corpusSaid: input.corpusSaid,
      failureQuery: input.failureQuery,
      maximumResults: input.maximumResults,
    };
    if (
      !Value.Check(experienceQuerySchema, query) ||
      input.taskId !== this.#inventory.taskId ||
      input.taskRevisionSaid !== this.#inventory.taskRevisionSaid ||
      input.sourceInventorySaid !== this.#inventory.d ||
      input.corpusSaid !== this.#inventory.corpusSaid
    )
      return { kind: 'Denied' };
    let response: Response;
    try {
      response = await this.#fetch(`${this.#origin}/api/experience/query`, {
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
    if (response.status !== 200) {
      if (!Value.Check(problem, body) || body.status !== response.status)
        return { kind: 'Unavailable' };
      if (response.status === 422 && body.code === 'ExperienceIrrelevant')
        return { kind: 'Irrelevant' };
      if (response.status === 403 && body.code === 'ExperienceDenied') return { kind: 'Denied' };
      if (response.status === 503 && body.code === 'ExperienceIndexNotReady')
        return { kind: 'IndexNotReady' };
      return { kind: 'Unavailable' };
    }
    if (!Value.Check(experienceQueryReceiptSchema, body) || body.sources.length === 0)
      return { kind: 'Unavailable' };
    const episodes = new Set<string>();
    for (const hit of body.sources) {
      const allowed = this.#inventory.sources.find(
        (candidate) =>
          candidate.episodeSaid === hit.episodeSaid &&
          candidate.rawEvidenceSaid === hit.rawEvidenceSaid,
      );
      if (allowed === undefined || episodes.has(hit.episodeSaid)) return { kind: 'Denied' };
      episodes.add(hit.episodeSaid);
    }
    const receiptQuery = new URLSearchParams({
      taskId: input.taskId,
      sourceInventorySaid: input.sourceInventorySaid,
      offset: '0',
      maximumBytes: '32768',
    });
    let receiptResponse: Response;
    try {
      receiptResponse = await this.#fetch(
        `${this.#origin}/api/experience/query-receipts/${body.queryReceiptSaid}?${receiptQuery}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${this.#bearer}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      return { kind: 'Unavailable' };
    }
    if (receiptResponse.headers.get('cache-control') !== 'no-store') return { kind: 'Unavailable' };
    let receiptBody: unknown;
    try {
      receiptBody = (await receiptResponse.json()) as unknown;
    } catch {
      return { kind: 'Unavailable' };
    }
    if (receiptResponse.status !== 200) {
      if (
        Value.Check(problem, receiptBody) &&
        receiptBody.status === 403 &&
        receiptBody.code === 'ExperienceDenied'
      )
        return { kind: 'Denied' };
      return { kind: 'Unavailable' };
    }
    const decoded = decodeExperienceQueryReceiptReadResponse(receiptBody);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.response.artifact.d !== body.queryReceiptSaid ||
      decoded.response.artifact.mediaType !== 'application/json' ||
      decoded.response.offset !== 0 ||
      decoded.response.totalBytes !== decoded.bytes.byteLength ||
      decodeEvidenceArtifact(decoded.response.artifact, decoded.bytes).kind !== 'Accepted'
    )
      return { kind: 'Unavailable' };
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes));
    } catch {
      return { kind: 'Unavailable' };
    }
    if (
      !Value.Check(rawQueryReceipt, raw) ||
      raw.ownerAid !== this.#inventory.ownerAid ||
      raw.taskId !== input.taskId ||
      raw.sourceInventorySaid !== input.sourceInventorySaid ||
      raw.corpusSaid !== input.corpusSaid ||
      raw.failureQuery !== input.failureQuery ||
      raw.chargedMicroUsd !== body.chargedMicroUsd ||
      JSON.stringify(raw.sources) !== JSON.stringify(body.sources)
    )
      return { kind: 'Unavailable' };
    return {
      kind: 'Retrieved',
      sources: body.sources,
      queryReceiptSaid: body.queryReceiptSaid,
      chargedMicroUsd: body.chargedMicroUsd,
    };
  }
}
