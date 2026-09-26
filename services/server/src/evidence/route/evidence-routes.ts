import { ProtectedCredentials, taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  appendEvidenceBatchBodySchema,
  decodeEvidenceArtifactUpload,
  evidenceArtifactAcknowledgementSchema,
  evidenceArtifactBodyByteLimit,
  evidenceArtifactMetadataHeadersSchema,
  evidenceArtifactParametersSchema,
  evidenceArtifactRawBodySchema,
  evidenceBatchAcknowledgementSchema,
  evidenceBatchParametersSchema,
  evidenceCapabilityInvalidProblemSchema,
  evidenceConflictProblemSchema,
  evidenceQuotaExceededProblemSchema,
  evidenceRejectedProblemSchema,
  evidenceRequestInvalidProblemSchema,
  evidenceRunNotFoundProblemSchema,
  evidenceSealReconciliationBodySchema,
  evidenceStreamProjectionSchema,
  evidenceTimelinePageSchema,
  evidenceTimelineQuerySchema,
  evidenceUnavailableProblemSchema,
  runParametersSchema,
  workAccessAuthorizationHeadersSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  type EvidenceProblem,
  type WorkAccessScope,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type from 'typebox';
import { Check, Convert, Errors } from 'typebox/value';

import type {
  AcceptEvidenceBatchOutcome,
  EvidenceBatchCommandInput,
} from '../application/accept-evidence-batch.js';
import type {
  EvidenceArtifactAdmission,
  EvidenceArtifactAdmissionInput,
} from '../application/evidence-artifacts.js';
import { projectEvidenceStream } from '../application/evidence-stream-projection.js';
import type {
  InspectEvidenceTimelineInput,
  InspectEvidenceTimelineOutcome,
} from '../application/inspect-evidence-timeline.js';
import type {
  ReconcileEvidenceSealInput,
  ReconcileEvidenceSealOutcome,
} from '../application/reconcile-evidence-seal.js';

type EvidenceScope = Extract<WorkAccessScope, 'evidence:append' | 'evidence:seal' | 'run:read'>;

export type EvidenceAccessAuthorization =
  | { readonly kind: 'EvidenceAccessAuthorized'; readonly ownerAid: string }
  | { readonly kind: 'EvidenceAccessInvalid' }
  | { readonly kind: 'EvidenceAccessExpired' }
  | { readonly kind: 'EvidenceAccessReleased' }
  | { readonly kind: 'EvidenceAccessRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'EvidenceAccessScopeRejected' }
  | { readonly kind: 'EvidenceAccessConcurrentUpdate' }
  | { readonly kind: 'EvidenceAccessExhausted' }
  | { readonly kind: 'EvidenceAccessUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface EvidenceAccessAuthorizer {
  authorize(input: {
    readonly bearerSecret: string;
    readonly scope: EvidenceScope;
    readonly observedAt: string;
  }): Promise<EvidenceAccessAuthorization>;
}

export interface EvidenceConversation {
  admitArtifact(input: EvidenceArtifactAdmissionInput): Promise<EvidenceArtifactAdmission>;
  acceptBatch(input: EvidenceBatchCommandInput): Promise<AcceptEvidenceBatchOutcome>;
  reconcileSeal(input: ReconcileEvidenceSealInput): Promise<ReconcileEvidenceSealOutcome>;
  inspectTimeline(input: InspectEvidenceTimelineInput): Promise<InspectEvidenceTimelineOutcome>;
}

export interface EvidenceRoutesConfiguration {
  readonly access: EvidenceAccessAuthorizer;
  readonly conversation: EvidenceConversation;
  now(): string;
  newCorrelationId(): string;
}

const unauthorizedResponses = Type.Union([
  evidenceCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
]);
const forbiddenResponses = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
]);
const conflictResponses = Type.Union([
  workAccessGrantConcurrentUpdateProblemSchema,
  evidenceConflictProblemSchema,
]);

const authorizationResponses = {
  401: unauthorizedResponses,
  403: forbiddenResponses,
  409: conflictResponses,
  429: workAccessGrantExhaustedProblemSchema,
};

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

async function sendProblem(reply: FastifyReply, problem: EvidenceProblem): Promise<void> {
  await reply.code(problem.status).type('application/problem+json').send(problem);
}

function evidenceProblem(
  code: 'EvidenceRequestInvalid' | 'EvidenceCapabilityInvalid' | 'EvidenceRunNotFound',
  correlationId: string,
): EvidenceProblem {
  switch (code) {
    case 'EvidenceRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/evidence-request-invalid',
        title: 'Evidence request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'EvidenceCapabilityInvalid':
      return {
        type: 'https://devrandom.example/problems/evidence-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code,
        correlationId,
      };
    case 'EvidenceRunNotFound':
      return {
        type: 'https://devrandom.example/problems/evidence-run-not-found',
        title: 'Evidence Run was not found',
        status: 404,
        code,
        correlationId,
      };
  }
}

function conflictProblem(
  reason:
    | 'ArtifactConflict'
    | 'BatchConflict'
    | 'CheckpointConflict'
    | 'SealConflict'
    | 'CursorConcurrentUpdate',
  correlationId: string,
): EvidenceProblem {
  return {
    type: 'https://devrandom.example/problems/evidence-conflict',
    title: 'Evidence delivery conflicts with the accepted stream',
    status: 409,
    code: 'EvidenceConflict',
    correlationId,
    reason,
  };
}

async function authorize(
  reply: FastifyReply,
  authorization: string,
  scope: EvidenceScope,
  configuration: EvidenceRoutesConfiguration,
): Promise<string | undefined> {
  const outcome = await configuration.access.authorize({
    bearerSecret: bearerSecret(authorization),
    scope,
    observedAt: configuration.now(),
  });
  const correlationId = configuration.newCorrelationId();
  switch (outcome.kind) {
    case 'EvidenceAccessAuthorized':
      return outcome.ownerAid;
    case 'EvidenceAccessInvalid':
      await sendProblem(reply, evidenceProblem('EvidenceCapabilityInvalid', correlationId));
      return undefined;
    case 'EvidenceAccessExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId,
      });
      return undefined;
    case 'EvidenceAccessReleased':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-released',
        title: 'Work Access Grant was released',
        status: 401,
        code: 'WorkAccessGrantReleased',
        correlationId,
      });
      return undefined;
    case 'EvidenceAccessRevoked':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId,
        reason: outcome.reason,
      });
      return undefined;
    case 'EvidenceAccessScopeRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId,
        requiredScope: scope,
      });
      return undefined;
    case 'EvidenceAccessConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
        title: 'Work Access Grant changed concurrently',
        status: 409,
        code: 'WorkAccessGrantConcurrentUpdate',
        correlationId,
      });
      return undefined;
    case 'EvidenceAccessExhausted':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId,
      });
      return undefined;
    case 'EvidenceAccessUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-unavailable',
        title: 'Evidence dependency is unavailable',
        status: 503,
        code: 'EvidenceUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return undefined;
  }
}

async function sendArtifactOutcome(
  reply: FastifyReply,
  outcome: EvidenceArtifactAdmission,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'EvidenceArtifactStored':
      await reply.code(201).send(outcome.acknowledgement);
      return;
    case 'EvidenceArtifactAlreadyStored':
      await reply.code(200).send(outcome.acknowledgement);
      return;
    case 'EvidenceRunNotFound':
      await sendProblem(reply, evidenceProblem('EvidenceRunNotFound', correlationId));
      return;
    case 'EvidenceArtifactConflict':
      await sendProblem(reply, conflictProblem('ArtifactConflict', correlationId));
      return;
    case 'EvidenceStreamSealed':
      await sendProblem(reply, conflictProblem('SealConflict', correlationId));
      return;
    case 'EvidenceCursorConcurrentUpdate':
      await sendProblem(reply, conflictProblem('CursorConcurrentUpdate', correlationId));
      return;
    case 'RunEvidenceQuotaExceeded':
    case 'GlobalEvidenceQuotaExceeded':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-quota-exceeded',
        title: 'Evidence size or storage quota was exceeded',
        status: 413,
        code: 'EvidenceQuotaExceeded',
        correlationId,
        reason: outcome.kind,
      });
      return;
    case 'EvidenceArtifactRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-rejected',
        title: 'Evidence content was rejected',
        status: 422,
        code: 'EvidenceRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendUnavailable(reply, outcome.dependency, correlationId);
  }
}

async function sendBatchOutcome(
  reply: FastifyReply,
  outcome: AcceptEvidenceBatchOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'EvidenceBatchAccepted':
      await reply.code(201).send(outcome.acknowledgement);
      return;
    case 'EvidenceBatchAlreadyAccepted':
      await reply.code(200).send(outcome.acknowledgement);
      return;
    case 'EvidenceRequestInvalid':
      await sendProblem(reply, evidenceProblem('EvidenceRequestInvalid', correlationId));
      return;
    case 'EvidenceRunNotFound':
      await sendProblem(reply, evidenceProblem('EvidenceRunNotFound', correlationId));
      return;
    case 'EvidenceBatchConflict':
      await sendProblem(reply, conflictProblem('BatchConflict', correlationId));
      return;
    case 'EvidenceCheckpointConflict':
      await sendProblem(reply, conflictProblem('CheckpointConflict', correlationId));
      return;
    case 'EvidenceSequenceGap':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-conflict',
        title: 'Evidence delivery conflicts with the accepted stream',
        status: 409,
        code: 'EvidenceConflict',
        correlationId,
        reason: 'SequenceGap',
        expectedStartingSequence: outcome.expectedStartingSequence,
        receivedStartingSequence: outcome.receivedStartingSequence,
      });
      return;
    case 'EvidenceCursorConcurrentUpdate':
      await sendProblem(reply, conflictProblem('CursorConcurrentUpdate', correlationId));
      return;
    case 'EvidenceStreamSealed':
      await sendProblem(reply, conflictProblem('SealConflict', correlationId));
      return;
    case 'RunEvidenceQuotaExceeded':
    case 'GlobalEvidenceQuotaExceeded':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-quota-exceeded',
        title: 'Evidence size or storage quota was exceeded',
        status: 413,
        code: 'EvidenceQuotaExceeded',
        correlationId,
        reason: outcome.kind,
      });
      return;
    case 'EvidenceBatchRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-rejected',
        title: 'Evidence content was rejected',
        status: 422,
        code: 'EvidenceRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendUnavailable(reply, outcome.dependency, correlationId);
  }
}

async function sendSealOutcome(
  reply: FastifyReply,
  outcome: ReconcileEvidenceSealOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'EvidenceStreamSealed':
    case 'EvidenceStreamAlreadySealed':
      await reply.code(200).send(projectEvidenceStream(outcome.stream));
      return;
    case 'EvidenceSealPending':
      await reply.code(202).send({
        ...projectEvidenceStream(outcome.stream),
        seal: { kind: 'SealExchangePending', sealExchangeSaid: outcome.sealExchangeSaid },
      });
      return;
    case 'EvidenceRunNotFound':
      await sendProblem(reply, evidenceProblem('EvidenceRunNotFound', correlationId));
      return;
    case 'EvidenceSealConflict':
      await sendProblem(reply, conflictProblem('SealConflict', correlationId));
      return;
    case 'EvidenceSealCursorIncomplete':
      await sendProblem(reply, conflictProblem('CheckpointConflict', correlationId));
      return;
    case 'EvidenceCursorConcurrentUpdate':
      await sendProblem(reply, conflictProblem('CursorConcurrentUpdate', correlationId));
      return;
    case 'EvidenceSealRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/evidence-rejected',
        title: 'Evidence content was rejected',
        status: 422,
        code: 'EvidenceRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendUnavailable(reply, outcome.dependency, correlationId);
  }
}

async function sendTimelineOutcome(
  reply: FastifyReply,
  outcome: InspectEvidenceTimelineOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'EvidenceTimelineFound':
      await reply.code(200).send(outcome.page);
      return;
    case 'EvidenceTimelineCursorRejected':
      await sendProblem(reply, evidenceProblem('EvidenceRequestInvalid', correlationId));
      return;
    case 'EvidenceRunNotFound':
      await sendProblem(reply, evidenceProblem('EvidenceRunNotFound', correlationId));
      return;
    case 'DependencyUnavailable':
      await sendUnavailable(reply, outcome.dependency, correlationId);
  }
}

async function sendUnavailable(
  reply: FastifyReply,
  dependency: 'HostedMongoDB' | 'Keria' | 'Witness',
  correlationId: string,
): Promise<void> {
  await sendProblem(reply, {
    type: 'https://devrandom.example/problems/evidence-unavailable',
    title: 'Evidence dependency is unavailable',
    status: 503,
    code: 'EvidenceUnavailable',
    correlationId,
    dependency,
  });
}

function artifactRoutes(configuration: EvidenceRoutesConfiguration): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.removeContentTypeParser(['application/json', 'text/plain']);
    server.addContentTypeParser(
      ['application/octet-stream', 'application/json', 'text/plain', 'text/x-diff'],
      { parseAs: 'buffer' },
      (_request, body, next) => {
        next(null, body);
      },
    );
    server.put(
      '/api/runs/:runId/artifacts/:artifactSaid',
      {
        bodyLimit: evidenceArtifactBodyByteLimit,
        schema: {
          operationId: 'admitEvidenceArtifact',
          consumes: [
            'application/octet-stream',
            'application/json',
            'text/plain; charset=utf-8',
            'text/x-diff; charset=utf-8',
          ],
          headers: Type.Intersect([
            workAccessAuthorizationHeadersSchema,
            evidenceArtifactMetadataHeadersSchema,
          ]),
          params: evidenceArtifactParametersSchema,
          body: evidenceArtifactRawBodySchema,
          response: {
            ...authorizationResponses,
            200: evidenceArtifactAcknowledgementSchema,
            201: evidenceArtifactAcknowledgementSchema,
            400: evidenceRequestInvalidProblemSchema,
            404: evidenceRunNotFoundProblemSchema,
            413: evidenceQuotaExceededProblemSchema,
            422: evidenceRejectedProblemSchema,
            503: evidenceUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const ownerAid = await authorize(
          reply,
          request.headers.authorization,
          'evidence:append',
          configuration,
        );
        if (ownerAid === undefined) {
          return;
        }
        if (request.body instanceof Uint8Array) {
          const disclosure = new ProtectedCredentials([
            bearerSecret(request.headers.authorization),
          ]).inspect(request.body);
          if (disclosure.kind === 'WithheldSecret') {
            await sendProblem(reply, {
              type: 'https://devrandom.example/problems/evidence-rejected',
              title: 'Evidence content was rejected',
              status: 422,
              code: 'EvidenceRejected',
              correlationId: configuration.newCorrelationId(),
              reason: 'SecretDetected',
            });
            return;
          }
        }
        const decoded = decodeEvidenceArtifactUpload(request.params, request.headers, request.body);
        if (decoded.kind === 'Rejected') {
          const correlationId = configuration.newCorrelationId();
          if (decoded.reason === 'ArtifactBodyTooLarge') {
            await sendProblem(reply, {
              type: 'https://devrandom.example/problems/evidence-quota-exceeded',
              title: 'Evidence size or storage quota was exceeded',
              status: 413,
              code: 'EvidenceQuotaExceeded',
              correlationId,
              reason: 'ArtifactTooLarge',
            });
            return;
          }
          if (decoded.reason === 'ArtifactSaidMismatch') {
            await sendProblem(reply, {
              type: 'https://devrandom.example/problems/evidence-rejected',
              title: 'Evidence content was rejected',
              status: 422,
              code: 'EvidenceRejected',
              correlationId,
              reason: decoded.reason,
            });
            return;
          }
          await sendProblem(reply, evidenceProblem('EvidenceRequestInvalid', correlationId));
          return;
        }
        const outcome = await configuration.conversation.admitArtifact({
          ownerAid,
          runId: request.params.runId,
          artifact: decoded.artifact,
          bytes: decoded.bytes,
          receivedAt: configuration.now(),
        });
        await sendArtifactOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );
    done();
  };
}

export function evidenceRoutes(
  configuration: EvidenceRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema, httpPart }) => (input) => {
      const decoded: unknown = httpPart === 'querystring' ? Convert(schema, input) : input;
      if (Check(schema, decoded)) {
        return { value: decoded };
      }
      const [firstError] = Errors(schema, decoded);
      return { error: new Error(firstError?.message ?? 'request does not match route schema') };
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    server.setErrorHandler(async (failure, _request, reply) => {
      const fastifyCode: unknown =
        failure instanceof Error && 'code' in failure ? failure.code : undefined;
      const bodyTooLarge = fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE';
      const validationContext: unknown =
        failure instanceof Error && 'validationContext' in failure
          ? failure.validationContext
          : undefined;
      const requestInvalid =
        validationContext === 'body' ||
        validationContext === 'params' ||
        validationContext === 'querystring' ||
        fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY';
      if (!bodyTooLarge && validationContext !== 'headers' && !requestInvalid) {
        await reply.status(500).send();
        return;
      }
      const correlationId = configuration.newCorrelationId();
      if (bodyTooLarge) {
        await sendProblem(reply, {
          type: 'https://devrandom.example/problems/evidence-quota-exceeded',
          title: 'Evidence size or storage quota was exceeded',
          status: 413,
          code: 'EvidenceQuotaExceeded',
          correlationId,
          reason: 'RequestBodyTooLarge',
        });
        return;
      }
      await sendProblem(
        reply,
        evidenceProblem(
          validationContext === 'headers' ? 'EvidenceCapabilityInvalid' : 'EvidenceRequestInvalid',
          correlationId,
        ),
      );
    });

    void server.register(artifactRoutes(configuration));

    server.put(
      '/api/runs/:runId/evidence-batches/:batchSaid',
      {
        bodyLimit: taskBudgetCeilings.evidenceBatchBodyBytes,
        schema: {
          operationId: 'acceptEvidenceBatch',
          headers: workAccessAuthorizationHeadersSchema,
          params: evidenceBatchParametersSchema,
          body: appendEvidenceBatchBodySchema,
          response: {
            ...authorizationResponses,
            200: evidenceBatchAcknowledgementSchema,
            201: evidenceBatchAcknowledgementSchema,
            400: evidenceRequestInvalidProblemSchema,
            404: evidenceRunNotFoundProblemSchema,
            413: evidenceQuotaExceededProblemSchema,
            422: evidenceRejectedProblemSchema,
            503: evidenceUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const ownerAid = await authorize(
          reply,
          request.headers.authorization,
          'evidence:append',
          configuration,
        );
        if (ownerAid === undefined) {
          return;
        }
        const disclosure = new ProtectedCredentials([
          bearerSecret(request.headers.authorization),
        ]).inspect(new TextEncoder().encode(JSON.stringify(request.body)));
        if (disclosure.kind === 'WithheldSecret') {
          await sendProblem(reply, {
            type: 'https://devrandom.example/problems/evidence-rejected',
            title: 'Evidence content was rejected',
            status: 422,
            code: 'EvidenceRejected',
            correlationId: configuration.newCorrelationId(),
            reason: 'SecretDetected',
          });
          return;
        }
        const outcome = await configuration.conversation.acceptBatch({
          ownerAid,
          parameters: request.params,
          body: request.body,
          receivedAt: configuration.now(),
        });
        await sendBatchOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.put(
      '/api/runs/:runId/evidence-seal',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'reconcileEvidenceSeal',
          headers: workAccessAuthorizationHeadersSchema,
          params: runParametersSchema,
          body: evidenceSealReconciliationBodySchema,
          response: {
            ...authorizationResponses,
            200: evidenceStreamProjectionSchema,
            202: evidenceStreamProjectionSchema,
            400: evidenceRequestInvalidProblemSchema,
            404: evidenceRunNotFoundProblemSchema,
            413: evidenceQuotaExceededProblemSchema,
            422: evidenceRejectedProblemSchema,
            503: evidenceUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const ownerAid = await authorize(
          reply,
          request.headers.authorization,
          'evidence:seal',
          configuration,
        );
        if (ownerAid === undefined) {
          return;
        }
        const outcome = await configuration.conversation.reconcileSeal({
          ownerAid,
          runId: request.params.runId,
          sealExchangeSaid: request.body.sealExchangeSaid,
          observedAt: configuration.now(),
        });
        await sendSealOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/runs/:runId/timeline',
      {
        schema: {
          operationId: 'inspectEvidenceTimeline',
          headers: workAccessAuthorizationHeadersSchema,
          params: runParametersSchema,
          querystring: evidenceTimelineQuerySchema,
          response: {
            ...authorizationResponses,
            200: evidenceTimelinePageSchema,
            400: evidenceRequestInvalidProblemSchema,
            404: evidenceRunNotFoundProblemSchema,
            503: evidenceUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const ownerAid = await authorize(
          reply,
          request.headers.authorization,
          'run:read',
          configuration,
        );
        if (ownerAid === undefined) {
          return;
        }
        const outcome = await configuration.conversation.inspectTimeline({
          ownerAid,
          runId: request.params.runId,
          query: request.query,
        });
        await sendTimelineOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
