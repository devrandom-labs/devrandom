import {
  runtimeRecoveryReconciliationBodySchema,
  type RuntimeRecoveryReconciliationBody,
  appendEvidenceBatchBodySchema,
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  decodePublicVerifierReceipt,
  decodeEvidenceBatchAcknowledgement,
  decodeEvidenceStreamProjection,
  decodeEvidenceTimelinePage,
  evidenceArtifactAcknowledgementSchema,
  evidenceProblemSchema,
  evidenceSealReconciliationBodySchema,
  evidenceTimelineQuerySchema,
  runParametersSchema,
  verifierReceiptReadingSchema,
  terminalCalibrationReconciliationBodySchema,
  type TerminalCalibrationReconciliationBody,
  type AppendEvidenceBatchBody,
  type EvidenceArtifact,
  type EvidenceSealReconciliationBody,
  type EvidenceTimelineQuery,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  HostedArtifactStorage,
  HostedBatchAppend,
  HostedEvidence,
  HostedEvidenceFailure,
} from '../application/evidence-delivery.js';
import type {
  HostedEvidenceSealReconciliation,
  HostedEvidenceSeals,
} from '../application/evidence-seal-delivery.js';
import type {
  HostedRunTimelineInspection,
  HostedRunTimelines,
} from '../application/task-run-observation.js';
import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

const evidenceRequestTimeoutMilliseconds = 10_000;

interface EvidenceHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

function rejected(response: EvidenceHttpResponse): HostedEvidenceFailure {
  return Value.Check(evidenceProblemSchema, response.body) &&
    response.body.status === response.status
    ? { kind: 'RequestRejected', problem: Value.Parse(evidenceProblemSchema, response.body) }
    : { kind: 'ResponseInvalid' };
}

export class ServerEvidenceHttp implements HostedEvidence, HostedEvidenceSeals, HostedRunTimelines {
  readonly #origin: DevrandomServerOrigin;
  readonly #authorization: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) {
      throw new TypeError('Evidence HTTP requires one valid Work Access bearer');
    }
    this.#origin = origin;
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetch;
  }

  async inspect(runId: string, query: EvidenceTimelineQuery): Promise<HostedRunTimelineInspection> {
    if (
      !Value.Check(runParametersSchema, { runId }) ||
      !Value.Check(evidenceTimelineQuerySchema, query)
    ) {
      return { kind: 'InputInvalid' };
    }
    const parameters = new URLSearchParams();
    if (query.evidenceStreamId !== undefined)
      parameters.set('evidenceStreamId', query.evidenceStreamId);
    if (query.limit !== undefined) parameters.set('limit', String(query.limit));
    if (query.cursor !== undefined) parameters.set('cursor', query.cursor);
    const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/timeline${suffix}`,
      {
        method: 'GET',
        headers: { authorization: this.#authorization },
      },
    );
    if (response.kind !== 'Received') {
      return response.failure;
    }
    if (response.value.status !== 200) {
      return rejected(response.value);
    }
    const decoded = decodeEvidenceTimelinePage(response.value.body, runId);
    return decoded.kind === 'Accepted'
      ? { kind: 'Found', page: decoded.page }
      : { kind: 'ResponseInvalid' };
  }

  /** Reads bounded raw custody under the current bearer; a descriptor is rederived from bytes. */
  async readArtifact(
    runId: string,
    artifactSaid: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' | 'ResponseInvalid' | 'ServerUnavailable' }
  > {
    if (
      !Value.Check(runParametersSchema, { runId }) ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(artifactSaid)
    )
      return { kind: 'ResponseInvalid' };
    const cancellation = new AbortController();
    const combined =
      signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal]);
    const timeout = setTimeout(() => {
      cancellation.abort();
    }, evidenceRequestTimeoutMilliseconds);
    try {
      combined.throwIfAborted();
      const response = await this.#fetch(
        `${this.#origin}/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactSaid)}`,
        { method: 'GET', headers: { authorization: this.#authorization }, signal: combined },
      );
      combined.throwIfAborted();
      if (response.headers.get('cache-control') !== 'no-store') return { kind: 'ResponseInvalid' };
      if (response.status === 404) return { kind: 'NotFound' };
      if (
        response.status !== 200 ||
        response.headers.get('content-type') !== 'application/octet-stream' ||
        response.headers.get('etag') !== `"${artifactSaid}"`
      )
        return { kind: 'ResponseInvalid' };
      const mediaType = response.headers.get('x-devrandom-artifact-media-type');
      if (mediaType === null || response.body === null) return { kind: 'ResponseInvalid' };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const read = await reader.read();
        combined.throwIfAborted();
        if (read.done) break;
        total += read.value.byteLength;
        if (total > 512 * 1_024) {
          await reader.cancel();
          return { kind: 'ResponseInvalid' };
        }
        chunks.push(read.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const prepared = prepareEvidenceArtifact(bytes, mediaType);
      return prepared.kind === 'Prepared' && prepared.artifact.d === artifactSaid
        ? { kind: 'Read', artifact: prepared.artifact, bytes }
        : { kind: 'ResponseInvalid' };
    } catch {
      return { kind: 'ServerUnavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async readVerifierReceipt(
    runId: string,
    receiptSaid: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'Read';
        readonly checkpointSaid: string;
        readonly receipt: PublicVerifierReceipt;
      }
    | { readonly kind: 'NotFound' | 'ResponseInvalid' | 'ServerUnavailable' }
  > {
    if (
      !Value.Check(runParametersSchema, { runId }) ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(receiptSaid)
    )
      return { kind: 'ResponseInvalid' };
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/verifier-receipts/${encodeURIComponent(receiptSaid)}`,
      {
        method: 'GET',
        headers: { authorization: this.#authorization },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.kind !== 'Received') {
      return response.failure.kind === 'ServerUnavailable'
        ? { kind: 'ServerUnavailable' }
        : { kind: 'ResponseInvalid' };
    }
    if (response.value.status === 404) return { kind: 'NotFound' };
    if (
      response.value.status !== 200 ||
      !Value.Check(verifierReceiptReadingSchema, response.value.body)
    )
      return { kind: 'ResponseInvalid' };
    const body = Value.Parse(verifierReceiptReadingSchema, response.value.body);
    return body.runId === runId &&
      body.receipt.d === receiptSaid &&
      decodePublicVerifierReceipt(body.receipt).kind === 'Accepted'
      ? { kind: 'Read', checkpointSaid: body.checkpointSaid, receipt: body.receipt }
      : { kind: 'ResponseInvalid' };
  }

  async reconcileSeal(
    runId: string,
    body: EvidenceSealReconciliationBody,
  ): Promise<HostedEvidenceSealReconciliation> {
    if (
      !Value.Check(runParametersSchema, { runId }) ||
      !Value.Check(evidenceSealReconciliationBodySchema, body)
    ) {
      return { kind: 'InputInvalid' };
    }
    const response = await this.#request(`/api/runs/${encodeURIComponent(runId)}/evidence-seal`, {
      method: 'PUT',
      headers: {
        authorization: this.#authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.kind !== 'Received') {
      return response.failure;
    }
    if (response.value.status !== 200 && response.value.status !== 202) {
      return rejected(response.value);
    }
    const decoded = decodeEvidenceStreamProjection(response.value.body);
    if (decoded.kind !== 'Accepted' || decoded.projection.runId !== runId) {
      return { kind: 'ResponseInvalid' };
    }
    const stream = decoded.projection;
    if (
      response.value.status === 202 &&
      stream.seal.kind === 'SealExchangePending' &&
      stream.seal.sealExchangeSaid === body.sealExchangeSaid
    ) {
      return { kind: 'Pending', stream: { ...stream, seal: stream.seal } };
    }
    if (
      response.value.status === 200 &&
      stream.seal.kind === 'Sealed' &&
      stream.seal.sealExchangeSaid === body.sealExchangeSaid
    ) {
      return { kind: 'Sealed', stream: { ...stream, seal: stream.seal } };
    }
    return { kind: 'ResponseInvalid' };
  }

  async storeArtifact(
    runId: string,
    artifact: EvidenceArtifact,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<HostedArtifactStorage> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId) ||
      decodeEvidenceArtifact(artifact, bytes).kind !== 'Accepted'
    ) {
      return { kind: 'InputInvalid' };
    }
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.d)}`,
      {
        method: 'PUT',
        headers: {
          authorization: this.#authorization,
          'content-type': artifact.mediaType,
        },
        body: Uint8Array.from(bytes),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.kind !== 'Received') {
      return response.failure;
    }
    if (response.value.status !== 200 && response.value.status !== 201) {
      return rejected(response.value);
    }
    if (!Value.Check(evidenceArtifactAcknowledgementSchema, response.value.body)) {
      return { kind: 'ResponseInvalid' };
    }
    const acknowledgement = Value.Parse(evidenceArtifactAcknowledgementSchema, response.value.body);
    if (
      acknowledgement.runId !== runId ||
      acknowledgement.artifact.d !== artifact.d ||
      decodeEvidenceArtifact(acknowledgement.artifact, bytes).kind !== 'Accepted'
    ) {
      return { kind: 'ResponseInvalid' };
    }
    const expectedDisposition = response.value.status === 201 ? 'Stored' : 'AlreadyStored';
    if (acknowledgement.disposition !== expectedDisposition) {
      return { kind: 'ResponseInvalid' };
    }
    return { kind: expectedDisposition, acknowledgement };
  }

  async appendBatch(
    runId: string,
    body: AppendEvidenceBatchBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend> {
    if (!Value.Check(appendEvidenceBatchBodySchema, body) || body.batch.runId !== runId) {
      return { kind: 'InputInvalid' };
    }
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/evidence-batches/${encodeURIComponent(body.batch.d)}`,
      {
        method: 'PUT',
        headers: {
          authorization: this.#authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.kind !== 'Received') {
      return response.failure;
    }
    if (response.value.status !== 200 && response.value.status !== 201) {
      return rejected(response.value);
    }
    const acknowledgement = decodeEvidenceBatchAcknowledgement(response.value.body, body.batch);
    if (acknowledgement.kind !== 'Accepted') {
      return { kind: 'ResponseInvalid' };
    }
    const expectedDisposition = response.value.status === 201 ? 'Accepted' : 'AlreadyAccepted';
    if (acknowledgement.acknowledgement.disposition.kind !== expectedDisposition) {
      return { kind: 'ResponseInvalid' };
    }
    return { kind: 'Accepted', acknowledgement: acknowledgement.acknowledgement };
  }

  async reconcileTerminalCalibration(
    runId: string,
    body: TerminalCalibrationReconciliationBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend> {
    if (
      !Value.Check(terminalCalibrationReconciliationBodySchema, body) ||
      body.body.batch.runId !== runId
    )
      return { kind: 'InputInvalid' };
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/evidence-terminal-reconciliation`,
      {
        method: 'POST',
        headers: { authorization: this.#authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.kind !== 'Received') return response.failure;
    if (response.value.status !== 200 && response.value.status !== 201)
      return rejected(response.value);
    const decoded = decodeEvidenceBatchAcknowledgement(response.value.body, body.body.batch);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.acknowledgement.disposition.kind !==
        (response.value.status === 201 ? 'Accepted' : 'AlreadyAccepted')
    )
      return { kind: 'ResponseInvalid' };
    return { kind: 'Accepted', acknowledgement: decoded.acknowledgement };
  }

  async reconcileRuntimeRecovery(
    runId: string,
    body: RuntimeRecoveryReconciliationBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend> {
    if (
      !Value.Check(runtimeRecoveryReconciliationBodySchema, body) ||
      body.body.batch.runId !== runId
    )
      return { kind: 'InputInvalid' };
    const response = await this.#request(
      `/api/runs/${encodeURIComponent(runId)}/evidence-runtime-reconciliation`,
      {
        method: 'POST',
        headers: { authorization: this.#authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.kind !== 'Received') return response.failure;
    if (response.value.status !== 200 && response.value.status !== 201)
      return rejected(response.value);
    const decoded = decodeEvidenceBatchAcknowledgement(response.value.body, body.body.batch);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.acknowledgement.disposition.kind !==
        (response.value.status === 201 ? 'Accepted' : 'AlreadyAccepted')
    )
      return { kind: 'ResponseInvalid' };
    return { kind: 'Accepted', acknowledgement: decoded.acknowledgement };
  }

  async #request(
    path: string,
    init: RequestInit,
  ): Promise<
    | { readonly kind: 'Received'; readonly value: EvidenceHttpResponse }
    | { readonly kind: 'Failed'; readonly failure: HostedEvidenceFailure }
  > {
    const cancellation = new AbortController();
    const signal =
      init.signal === undefined || init.signal === null
        ? cancellation.signal
        : AbortSignal.any([init.signal, cancellation.signal]);
    const timeout = setTimeout(() => {
      cancellation.abort();
    }, evidenceRequestTimeoutMilliseconds);
    try {
      signal.throwIfAborted();
      const response = await this.#fetch(`${this.#origin}${path}`, { ...init, signal });
      signal.throwIfAborted();
      if (response.headers.get('cache-control') !== 'no-store') {
        cancellation.abort();
        return { kind: 'Failed', failure: { kind: 'ResponseInvalid' } };
      }
      const encoded = await response.text();
      signal.throwIfAborted();
      let body: unknown;
      try {
        body = JSON.parse(encoded);
      } catch {
        return { kind: 'Failed', failure: { kind: 'ResponseInvalid' } };
      }
      signal.throwIfAborted();
      return { kind: 'Received', value: { status: response.status, body } };
    } catch {
      return { kind: 'Failed', failure: { kind: 'ServerUnavailable' } };
    } finally {
      clearTimeout(timeout);
    }
  }
}
