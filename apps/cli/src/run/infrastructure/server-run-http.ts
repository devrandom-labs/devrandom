import {
  decodeRunProjection,
  decodeRunSuccessorSegment,
  runContinuationRequestSchema,
  runContinuationReceiptSchema,
  type RunContinuationRequest,
  decodeRunLeaseRenewalReceipt,
  runAdmissionCommandSchema,
  runAdmissionPendingProjectionSchema,
  runIncarnationParametersSchema,
  runLeaseAcquisitionBodySchema,
  runLeaseProjectionSchema,
  runLeaseRenewalHeaderNames,
  runLeaseTimesAreValid,
  runParametersSchema,
  runProblemSchema,
  runProjectionSchema,
  type RunAdmissionCommand,
  type RunLeaseAcquisitionBody,
  type RunProblem,
} from '@devrandom/protocol';
import Value from 'typebox/value';

import type {
  HostedRunAdmission,
  HostedRunFailure,
  HostedRunLease,
  HostedRunRenewal,
  HostedRuns,
} from '../application/baseline-run-admission.js';
import type { HostedRunContinuations } from '../application/resume-task.js';

import type {
  HostedRunInspection,
  HostedRunStatuses,
} from '../application/task-run-observation.js';
import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

const runRequestTimeoutMilliseconds = 10_000;

type RunHttpError =
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: RunProblem };

class RunHttpFailure extends Error {
  readonly detail: RunHttpError;

  constructor(detail: RunHttpError) {
    super(detail.kind);
    this.name = 'RunHttpFailure';
    this.detail = detail;
  }
}

function failure(cause: unknown): HostedRunFailure {
  if (!(cause instanceof RunHttpFailure)) {
    return { kind: 'ResponseInvalid' };
  }
  return cause.detail;
}

export class ServerRunHttp implements HostedRuns, HostedRunStatuses {
  readonly #origin: DevrandomServerOrigin;
  readonly #authorization: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) {
      throw new RunHttpFailure({ kind: 'ResponseInvalid' });
    }
    this.#origin = origin;
    this.#authorization = `Bearer ${bearer}`;
    this.#fetch = fetch;
  }

  async inspect(runId: string): Promise<HostedRunInspection> {
    if (!Value.Check(runParametersSchema, { runId })) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(`/api/runs/${encodeURIComponent(runId)}`, {
        method: 'GET',
      });
      if (response.status !== 200) {
        return this.#rejected(response);
      }
      if (!Value.Check(runProjectionSchema, response.body)) {
        return { kind: 'ResponseInvalid' };
      }
      const run = Value.Parse(runProjectionSchema, response.body);
      return decodeRunProjection(run).kind === 'Accepted' && run.runId === runId
        ? { kind: 'Found', run }
        : { kind: 'ResponseInvalid' };
    } catch (cause) {
      return failure(cause);
    }
  }

  async admit(command: RunAdmissionCommand): Promise<HostedRunAdmission> {
    if (!Value.Check(runAdmissionCommandSchema, command)) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request('/api/runs', {
        method: 'POST',
        body: JSON.stringify(command),
      });
      if (response.status === 202) {
        if (
          !Value.Check(runAdmissionPendingProjectionSchema, response.body) ||
          response.body.commandId !== command.commandId ||
          response.body.admissionExchangeSaid !== command.admissionExchangeSaid
        ) {
          return { kind: 'ResponseInvalid' };
        }
        return { kind: 'Pending', projection: response.body };
      }
      if (response.status !== 200 && response.status !== 201) {
        return this.#rejected(response);
      }
      if (!Value.Check(runProjectionSchema, response.body)) {
        return { kind: 'ResponseInvalid' };
      }
      const projection = Value.Parse(runProjectionSchema, response.body);
      if (
        decodeRunProjection(projection).kind !== 'Accepted' ||
        projection.commandId !== command.commandId ||
        projection.admissionExchangeSaid !== command.admissionExchangeSaid
      ) {
        return { kind: 'ResponseInvalid' };
      }
      return response.status === 201
        ? { kind: 'Created', projection }
        : { kind: 'Reconciled', projection };
    } catch (cause) {
      return failure(cause);
    }
  }

  async acquireLease(
    runId: string,
    incarnationId: string,
    command: RunLeaseAcquisitionBody,
  ): Promise<HostedRunLease> {
    if (
      !Value.Check(runIncarnationParametersSchema, { runId, incarnationId }) ||
      !Value.Check(runLeaseAcquisitionBodySchema, command)
    ) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(
        `/api/runs/${encodeURIComponent(runId)}/incarnations/${encodeURIComponent(incarnationId)}`,
        { method: 'PUT', body: JSON.stringify(command) },
      );
      if (response.status !== 200 && response.status !== 201) {
        return this.#rejected(response);
      }
      if (!Value.Check(runLeaseProjectionSchema, response.body)) {
        return { kind: 'ResponseInvalid' };
      }
      const projection = Value.Parse(runLeaseProjectionSchema, response.body);
      if (
        projection.runId !== runId ||
        projection.incarnationId !== incarnationId ||
        !runLeaseTimesAreValid(projection.serverTime, projection.expiresAt)
      ) {
        return { kind: 'ResponseInvalid' };
      }
      return response.status === 201
        ? { kind: 'Acquired', projection }
        : { kind: 'Reconciled', projection };
    } catch (cause) {
      return failure(cause);
    }
  }

  async renewLease(
    runId: string,
    incarnationId: string,
    command: RunLeaseAcquisitionBody,
  ): Promise<HostedRunRenewal> {
    if (
      !Value.Check(runIncarnationParametersSchema, { runId, incarnationId }) ||
      !Value.Check(runLeaseAcquisitionBodySchema, command)
    ) {
      return { kind: 'InputInvalid' };
    }
    try {
      const response = await this.#request(
        `/api/runs/${encodeURIComponent(runId)}/incarnations/${encodeURIComponent(incarnationId)}/lease`,
        { method: 'PUT', body: JSON.stringify(command) },
      );
      if (response.status !== 204) {
        return this.#rejected(response);
      }
      const decoded = decodeRunLeaseRenewalReceipt(runId, incarnationId, {
        [runLeaseRenewalHeaderNames.serverTime]: response.headers.get(
          runLeaseRenewalHeaderNames.serverTime,
        ),
        [runLeaseRenewalHeaderNames.expiresAt]: response.headers.get(
          runLeaseRenewalHeaderNames.expiresAt,
        ),
        [runLeaseRenewalHeaderNames.runVersion]: response.headers.get(
          runLeaseRenewalHeaderNames.runVersion,
        ),
      });
      return decoded.kind === 'Accepted'
        ? { kind: 'Renewed', receipt: decoded.receipt }
        : { kind: 'ResponseInvalid' };
    } catch (cause) {
      return failure(cause);
    }
  }

  async admitContinuation(
    runId: string,
    command: RunContinuationRequest,
  ): ReturnType<HostedRunContinuations['admitContinuation']> {
    if (
      !Value.Check(runParametersSchema, { runId }) ||
      !Value.Check(runContinuationRequestSchema, command)
    )
      return { kind: 'InputInvalid' };
    try {
      const response = await this.#request(`/api/runs/${encodeURIComponent(runId)}/continuations`, {
        method: 'POST',
        body: JSON.stringify(command),
      });
      if (response.status !== 200 && response.status !== 201) return this.#rejected(response);
      if (!Value.Check(runContinuationReceiptSchema, response.body))
        return { kind: 'ResponseInvalid' };
      const receipt = Value.Parse(runContinuationReceiptSchema, response.body);
      const run = decodeRunProjection(receipt.run);
      const segment = decodeRunSuccessorSegment(receipt.segment);
      const expected = response.status === 201 ? 'Admitted' : 'Equivalent';
      if (
        receipt.disposition !== expected ||
        run.kind !== 'Accepted' ||
        segment.kind !== 'Accepted' ||
        run.run.binding.runId !== runId ||
        segment.segment.runId !== runId ||
        run.run.currentExecution?.segmentSaid !== segment.segment.d ||
        segment.segment.successor.incarnationId !== command.successorIncarnationId ||
        segment.segment.successor.evidenceStreamId !== command.successorStreamId ||
        segment.segment.predecessor.checkpointSaid !== command.predecessorCheckpointSaid ||
        segment.segment.predecessor.sealExchangeSaid !== command.predecessorSealSaid ||
        segment.segment.predecessor.chainHeadSaid !== command.predecessorHeadSaid ||
        segment.segment.activation.pointerVersion !== command.expectedActivePointerVersion ||
        segment.segment.activation.decisionReceiptSaid !== command.expectedActivationReceiptSaid
      )
        return { kind: 'ResponseInvalid' };
      return { kind: expected, receipt };
    } catch (cause) {
      return failure(cause);
    }
  }

  async #request(
    path: string,
    input: { readonly method: 'GET' } | { readonly method: 'POST' | 'PUT'; readonly body: string },
  ): Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }> {
    const cancellation = new AbortController();
    const signal = cancellation.signal;
    const timeout = setTimeout(() => {
      cancellation.abort();
    }, runRequestTimeoutMilliseconds);
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: input.method,
        headers:
          input.method === 'GET'
            ? { authorization: this.#authorization }
            : { authorization: this.#authorization, 'content-type': 'application/json' },
        ...(input.method === 'GET' ? {} : { body: input.body }),
        signal,
      });
      signal.throwIfAborted();
      if (response.headers.get('cache-control') !== 'no-store') {
        cancellation.abort();
        throw new RunHttpFailure({ kind: 'ResponseInvalid' });
      }
      if (response.status === 204) {
        return { status: response.status, headers: response.headers, body: undefined };
      }
      const encoded = await response.text();
      signal.throwIfAborted();
      let body: unknown;
      try {
        body = JSON.parse(encoded);
      } catch {
        throw new RunHttpFailure({ kind: 'ResponseInvalid' });
      }
      return { status: response.status, headers: response.headers, body };
    } catch (cause) {
      if (cause instanceof RunHttpFailure) throw cause;
      throw new RunHttpFailure({ kind: 'ServerUnavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }

  #rejected(response: { readonly status: number; readonly body: unknown }): HostedRunFailure {
    if (Value.Check(runProblemSchema, response.body) && response.body.status === response.status) {
      return { kind: 'RequestRejected', problem: Value.Parse(runProblemSchema, response.body) };
    }
    return { kind: 'ResponseInvalid' };
  }
}
