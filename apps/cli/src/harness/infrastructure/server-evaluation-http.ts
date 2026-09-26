import {
  decodeEvaluationClosure,
  decodeEvaluationEvidenceBatch,
  decodeEvaluationExecutionProfile,
  decodeEvaluationManifest,
  decodeEvaluationSourceInventory,
  decodeEvaluationVerifierBundleBytes,
  decodeProtectedEvaluationArtifact,
  decodePublicEvaluationArtifact,
  evaluationAdmissionCommandSchema,
  evaluationAdmissionReceiptSchema,
  evaluationClosureCommandSchema,
  evaluationEvidenceAcknowledgementSchema,
  evaluationEvidenceUploadSchema,
  evaluationLeaseRenewalCommandSchema,
  evaluationLeaseRenewalReceiptSchema,
  evaluationManifestLockCommandSchema,
  evaluationManifestLockReceiptSchema,
  evaluationPreparationCommandSchema,
  bindEvaluationVerifierBundle,
} from '@devrandom/protocol';
import { taskBudgetCeilings, taskEvaluationBudgetCeilings } from '@devrandom/domain';
import Type from 'typebox';
import Value from 'typebox/value';

import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';

export type HostedEvaluationPreparation =
  | { readonly kind: 'Prepared' | 'AlreadyPrepared' }
  | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' };

export type HostedEvaluationAdmission =
  | {
      readonly kind: 'Admitted';
      readonly evaluationId: string;
      readonly version: number;
      readonly lease: {
        readonly evaluationId: string;
        readonly leaseId: string;
        readonly version: number;
        readonly serverTime: string;
        readonly expiresAt: string;
      };
      readonly evidenceStreamId: string;
      readonly reservationSaid: string;
    }
  | {
      readonly kind: 'Blocked';
      readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
    }
  | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' };

export type HostedEvaluationEvidenceDelivery =
  | {
      readonly kind: 'Acknowledged';
      readonly acknowledgement: Type.Static<typeof evaluationEvidenceAcknowledgementSchema>;
    }
  | {
      readonly kind:
        'Rejected' | 'Denied' | 'Conflict' | 'QuotaExceeded' | 'Unavailable' | 'ResponseInvalid';
    };

export type HostedEvaluationLeaseRenewal =
  | {
      readonly kind: 'Renewed' | 'AlreadyRenewed';
      readonly receipt: Type.Static<typeof evaluationLeaseRenewalReceiptSchema>;
    }
  | {
      readonly kind:
        'Lost' | 'Blocked' | 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid';
    };

export type HostedEvaluationClosure =
  | { readonly kind: 'Closed' | 'AlreadyClosed'; readonly closureSaid: string }
  | {
      readonly kind:
        'Rejected' | 'Denied' | 'Incomplete' | 'Conflict' | 'Unavailable' | 'ResponseInvalid';
    };

export type HostedEvaluationManifestLock =
  | {
      readonly kind: 'Locked' | 'AlreadyLocked';
      readonly receipt: Type.Static<typeof evaluationManifestLockReceiptSchema>;
    }
  | {
      readonly kind:
        'Rejected' | 'Denied' | 'NotFound' | 'Conflict' | 'Unavailable' | 'ResponseInvalid';
    };

const gates = ['Profile', 'Source', 'Authority', 'Budget', 'Qualification', 'Evidence'] as const;
const requestTimeoutMilliseconds = 10_000;
const problemSchema = Type.Object(
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

interface HttpReading {
  readonly status: number;
  readonly body: unknown;
}

function validProblem(
  response: HttpReading,
): response is HttpReading & { readonly body: Type.Static<typeof problemSchema> } {
  return Value.Check(problemSchema, response.body) && response.body.status === response.status;
}

/** Typed Work Access client for the hosted E3 preparation and reservation boundary. */
export class ServerEvaluationHttp {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('Evaluation bearer invalid');
    this.#origin = origin;
    this.#bearer = bearer;
    this.#fetch = fetch;
  }

  async prepare(
    command: Type.Static<typeof evaluationPreparationCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationPreparation> {
    if (
      !Value.Check(evaluationPreparationCommandSchema, command) ||
      decodeEvaluationExecutionProfile(command.executionProfile).kind !== 'Accepted' ||
      decodeEvaluationSourceInventory(command.sourceInventory).kind !== 'Accepted'
    )
      return { kind: 'Rejected' };
    const response = await this.#post('/api/evaluations/prepare', command, signal);
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200 || response.status === 201) {
      const expected = response.status === 200 ? 'AlreadyPrepared' : 'Prepared';
      return typeof response.body === 'object' &&
        response.body !== null &&
        'kind' in response.body &&
        response.body.kind === expected &&
        Object.keys(response.body).length === 1
        ? { kind: expected }
        : { kind: 'ResponseInvalid' };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 403) return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  async admit(
    command: Type.Static<typeof evaluationAdmissionCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationAdmission> {
    if (!Value.Check(evaluationAdmissionCommandSchema, command)) return { kind: 'Rejected' };
    const response = await this.#post('/api/evaluations', command, signal);
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 201) {
      if (
        !Value.Check(evaluationAdmissionReceiptSchema, response.body) ||
        response.body.kind !== 'Admitted' ||
        response.body.lease.evaluationId !== response.body.evaluationId ||
        response.body.lease.version !== response.body.version ||
        !Number.isFinite(Date.parse(response.body.lease.serverTime)) ||
        !Number.isFinite(Date.parse(response.body.lease.expiresAt)) ||
        Date.parse(response.body.lease.expiresAt) <= Date.parse(response.body.lease.serverTime)
      )
        return { kind: 'ResponseInvalid' };
      return response.body;
    }
    if (response.status === 422) {
      if (!validProblem(response)) return { kind: 'ResponseInvalid' };
      const code = response.body.code;
      const gate = gates.find((candidate) => code === `EvaluationBlocked${candidate}`);
      return gate === undefined ? { kind: 'ResponseInvalid' } : { kind: 'Blocked', gate };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 403) return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  async appendEvidence(
    upload: Type.Static<typeof evaluationEvidenceUploadSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationEvidenceDelivery> {
    if (
      !Value.Check(evaluationEvidenceUploadSchema, upload) ||
      decodeEvaluationEvidenceBatch(upload.batch, upload.events).kind !== 'Accepted' ||
      upload.publicArtifacts.some(
        (artifact) => decodePublicEvaluationArtifact(artifact).kind !== 'Accepted',
      ) ||
      upload.protectedArtifacts.some(
        (artifact) =>
          decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
          artifact.evaluationId !== upload.batch.evaluationId,
      )
    )
      return { kind: 'Rejected' };
    const encoded = JSON.stringify(upload);
    if (Buffer.byteLength(encoded, 'utf8') > taskBudgetCeilings.artifactRequestBodyBytes)
      return { kind: 'QuotaExceeded' };
    const response = await this.#request(
      'POST',
      `/api/evaluations/${upload.batch.evaluationId}/batches`,
      encoded,
      signal,
    );
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200 || response.status === 201) {
      const disposition = response.status === 200 ? 'AlreadyAccepted' : 'Accepted';
      if (
        !Value.Check(evaluationEvidenceAcknowledgementSchema, response.body) ||
        response.body.disposition !== disposition ||
        response.body.evaluationId !== upload.batch.evaluationId ||
        response.body.streamId !== upload.batch.streamId ||
        response.body.batchSaid !== upload.batch.d ||
        response.body.acceptedThroughSequence !== upload.batch.endingSequence ||
        response.body.chainHeadSaid !== upload.events.at(-1)?.d
      )
        return { kind: 'ResponseInvalid' };
      return { kind: 'Acknowledged', acknowledgement: response.body };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 400) return { kind: 'Rejected' };
    if (response.status === 403) return { kind: 'Denied' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 413) return { kind: 'QuotaExceeded' };
    if (response.status === 503) return { kind: 'Unavailable' };
    return { kind: 'ResponseInvalid' };
  }

  async renewLease(
    command: Type.Static<typeof evaluationLeaseRenewalCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationLeaseRenewal> {
    if (!Value.Check(evaluationLeaseRenewalCommandSchema, command)) return { kind: 'Rejected' };
    const response = await this.#request(
      'PUT',
      `/api/evaluations/${command.evaluationId}/lease`,
      JSON.stringify(command),
      signal,
    );
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200) {
      if (
        !Value.Check(evaluationLeaseRenewalReceiptSchema, response.body) ||
        (response.body.kind !== 'Renewed' && response.body.kind !== 'AlreadyRenewed') ||
        response.body.evaluationId !== command.evaluationId ||
        response.body.version !== command.expectedEvaluationVersion + 1 ||
        response.body.lease.evaluationId !== command.evaluationId ||
        response.body.lease.leaseId !== command.leaseId ||
        response.body.lease.version !== response.body.version ||
        !Number.isFinite(Date.parse(response.body.lease.serverTime)) ||
        !Number.isFinite(Date.parse(response.body.lease.expiresAt)) ||
        Date.parse(response.body.lease.expiresAt) <= Date.parse(response.body.lease.serverTime)
      )
        return { kind: 'ResponseInvalid' };
      return { kind: response.body.kind, receipt: response.body };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 400 || response.status === 403) return { kind: 'Rejected' };
    if (response.status === 409)
      return { kind: response.body.code === 'EvaluationLeaseLost' ? 'Lost' : 'Conflict' };
    if (response.status === 422) return { kind: 'Blocked' };
    if (response.status === 503) return { kind: 'Unavailable' };
    return { kind: 'ResponseInvalid' };
  }

  async lockManifest(
    command: Type.Static<typeof evaluationManifestLockCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationManifestLock> {
    if (
      !Value.Check(evaluationManifestLockCommandSchema, command) ||
      decodeEvaluationManifest(command.manifest).kind !== 'Accepted' ||
      bindEvaluationVerifierBundle(command.verifierBundle, command.manifest).kind !== 'Bound'
    )
      return { kind: 'Rejected' };
    const verifierBytes = Buffer.from(command.verifierBundleBytesBase64Url, 'base64url');
    const decodedBytes = decodeEvaluationVerifierBundleBytes(verifierBytes);
    if (
      verifierBytes.toString('base64url') !== command.verifierBundleBytesBase64Url ||
      decodedBytes.kind !== 'Accepted' ||
      decodedBytes.bundle.d !== command.verifierBundle.d ||
      JSON.stringify(decodedBytes.bundle) !== JSON.stringify(command.verifierBundle)
    )
      return { kind: 'Rejected' };
    const expectedArtifacts = [
      command.verifierBundle.protectedCase.stimulus,
      command.verifierBundle.protectedCase.expected,
      command.verifierBundle.terminalCase.stimulus,
      command.verifierBundle.terminalCase.expected,
    ];
    if (
      command.protectedArtifacts.some(
        (artifact, index) =>
          decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
          JSON.stringify(artifact) !== JSON.stringify(expectedArtifacts[index]),
      )
    )
      return { kind: 'Rejected' };
    const encoded = JSON.stringify(command);
    if (Buffer.byteLength(encoded, 'utf8') > taskEvaluationBudgetCeilings.artifactRequestBodyBytes)
      return { kind: 'Rejected' };
    const response = await this.#request(
      'PUT',
      `/api/evaluations/${command.manifest.evaluationId}/manifest`,
      encoded,
      signal,
    );
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200 || response.status === 201) {
      const kind = response.status === 201 ? 'Locked' : 'AlreadyLocked';
      return this.#manifestReceipt(response.body, {
        kind,
        evaluationId: command.manifest.evaluationId,
        manifestSaid: command.manifest.d,
        ownerAid: command.manifest.ownerAid,
        policySaid: command.manifest.policySaid,
        leaseId: command.leaseId,
        minimumEvaluationVersion: command.expectedEvaluationVersion + 1,
      });
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 403) return { kind: 'Denied' };
    if (response.status === 404) return { kind: 'NotFound' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 413 || response.status === 422)
      return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  async inspectManifestLock(
    evaluationId: string,
    manifestSaid: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationManifestLock> {
    if (
      !Value.Check(evaluationManifestLockReceiptSchema.properties.evaluationId, evaluationId) ||
      !Value.Check(evaluationManifestLockReceiptSchema.properties.manifestSaid, manifestSaid) ||
      !Value.Check(evaluationManifestLockReceiptSchema.properties.leaseId, leaseId)
    )
      return { kind: 'Rejected' };
    const response = await this.#request(
      'GET',
      `/api/evaluations/${evaluationId}/manifest/${manifestSaid}`,
      undefined,
      signal,
    );
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200)
      return this.#manifestReceipt(response.body, {
        kind: 'Locked',
        evaluationId,
        manifestSaid,
        leaseId,
      });
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 403) return { kind: 'Denied' };
    if (response.status === 404) return { kind: 'NotFound' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 503) return { kind: 'Unavailable' };
    if (response.status === 400 || response.status === 422) return { kind: 'Rejected' };
    return { kind: 'ResponseInvalid' };
  }

  #manifestReceipt(
    body: unknown,
    expected: {
      readonly kind: 'Locked' | 'AlreadyLocked';
      readonly evaluationId: string;
      readonly manifestSaid: string;
      readonly leaseId: string;
      readonly ownerAid?: string;
      readonly policySaid?: string;
      readonly minimumEvaluationVersion?: number;
    },
  ): HostedEvaluationManifestLock {
    if (
      !Value.Check(evaluationManifestLockReceiptSchema, body) ||
      body.kind !== expected.kind ||
      body.evaluationId !== expected.evaluationId ||
      body.manifestSaid !== expected.manifestSaid ||
      body.leaseId !== expected.leaseId ||
      (expected.ownerAid !== undefined && body.ownerAid !== expected.ownerAid) ||
      (expected.policySaid !== undefined && body.policySaid !== expected.policySaid) ||
      (expected.minimumEvaluationVersion !== undefined &&
        body.lockedAtEvaluationVersion !== expected.minimumEvaluationVersion) ||
      body.currentEvaluationVersion < body.lockedAtEvaluationVersion ||
      body.currentLeaseVersion < body.lockedAtLeaseVersion
    )
      return { kind: 'ResponseInvalid' };
    return { kind: body.kind, receipt: body };
  }

  async closeEvidence(
    command: Type.Static<typeof evaluationClosureCommandSchema>,
    signal?: AbortSignal,
  ): Promise<HostedEvaluationClosure> {
    if (
      !Value.Check(evaluationClosureCommandSchema, command) ||
      decodeEvaluationClosure(command.closure).kind !== 'Accepted'
    )
      return { kind: 'Rejected' };
    const encoded = JSON.stringify(command);
    if (Buffer.byteLength(encoded, 'utf8') > taskBudgetCeilings.ordinaryJsonRequestBodyBytes)
      return { kind: 'Rejected' };
    const response = await this.#request(
      'PUT',
      `/api/evaluations/${command.closure.evaluationId}/closure`,
      encoded,
      signal,
    );
    if (response === undefined) return { kind: 'Unavailable' };
    if (response.status === 200 || response.status === 201) {
      const kind = response.status === 200 ? 'AlreadyClosed' : 'Closed';
      if (
        typeof response.body !== 'object' ||
        response.body === null ||
        !('kind' in response.body) ||
        response.body.kind !== kind ||
        !('closureSaid' in response.body) ||
        response.body.closureSaid !== command.closure.d ||
        Object.keys(response.body).length !== 2
      )
        return { kind: 'ResponseInvalid' };
      return { kind, closureSaid: command.closure.d };
    }
    if (!validProblem(response)) return { kind: 'ResponseInvalid' };
    if (response.status === 400) return { kind: 'Rejected' };
    if (response.status === 403) return { kind: 'Denied' };
    if (response.status === 409) return { kind: 'Conflict' };
    if (response.status === 422) return { kind: 'Incomplete' };
    if (response.status === 503) return { kind: 'Unavailable' };
    return { kind: 'ResponseInvalid' };
  }

  async #post(
    path: string,
    command: object,
    signal?: AbortSignal,
  ): Promise<HttpReading | undefined> {
    return this.#request('POST', path, JSON.stringify(command), signal);
  }

  async #request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    encoded: string | undefined,
    signal?: AbortSignal,
  ): Promise<HttpReading | undefined> {
    try {
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(requestTimeoutMilliseconds)
          : AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#bearer}`,
          ...(encoded === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      if (response.headers.get('cache-control') !== 'no-store') {
        return { status: -1, body: undefined };
      }
      try {
        return { status: response.status, body: (await response.json()) as unknown };
      } catch {
        return { status: -1, body: undefined };
      }
    } catch {
      return undefined;
    }
  }
}
