import { taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  decodeRunProjection,
  decodeRunSuccessorSegment,
  runAdmissionCommandSchema,
  runAdmissionForbiddenProblemSchema,
  runAdmissionPendingProjectionSchema,
  runAdmissionRejectedProblemSchema,
  runBodyTooLargeProblemSchema,
  runCapabilityInvalidProblemSchema,
  runCapacityExceededProblemSchema,
  runConflictProblemSchema,
  runContinuationRejectedProblemSchema,
  runContinuationReceiptSchema,
  runContinuationRequestSchema,
  runSuccessorSegmentSchema,
  runSuccessorSegmentParametersSchema,
  runIncarnationParametersSchema,
  runLeaseAcquisitionBodySchema,
  runLeaseProjectionSchema,
  runLeaseRenewalHeaderNames,
  runLeaseRenewalHeadersSchema,
  runParametersSchema,
  runProjectionSchema,
  runRequestInvalidProblemSchema,
  runResourceNotFoundProblemSchema,
  runUnavailableProblemSchema,
  workAccessAuthorizationHeadersSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  type RunProblem,
  type RunContinuationReceipt,
  type RunContinuationRequest,
  type WorkAccessScope,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type {
  AcquireRunLeaseInput,
  AcquireRunLeaseOutcome,
} from '../application/acquire-run-lease.js';
import type { AdmitRunInput, AdmitRunOutcome } from '../application/admit-run.js';
import type { InspectRunInput, InspectRunOutcome } from '../application/inspect-run.js';
import type { RunSuccessorSegments } from '../application/run-successor-segments.js';
import type { RenewRunLeaseInput, RenewRunLeaseOutcome } from '../application/renew-run-lease.js';

type RunScope = Extract<WorkAccessScope, 'run:create' | 'run:execute' | 'run:read'>;

export type RunAccessAuthorization =
  | { readonly kind: 'RunAccessAuthorized'; readonly owner: AdmitRunInput['owner'] }
  | { readonly kind: 'RunAccessInvalid' }
  | { readonly kind: 'RunAccessExpired' }
  | { readonly kind: 'RunAccessReleased' }
  | { readonly kind: 'RunAccessRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'RunAccessScopeRejected' }
  | { readonly kind: 'RunAccessConcurrentUpdate' }
  | { readonly kind: 'RunAccessExhausted' }
  | { readonly kind: 'RunAccessUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface RunAccessAuthorizer {
  authorize(input: {
    readonly bearerSecret: string;
    readonly scope: RunScope;
    readonly observedAt: string;
  }): Promise<RunAccessAuthorization>;
}

export interface RunConversation {
  admit(input: AdmitRunInput): Promise<AdmitRunOutcome>;
  inspect(input: InspectRunInput): Promise<InspectRunOutcome>;
  acquireLease(input: AcquireRunLeaseInput): Promise<AcquireRunLeaseOutcome>;
  renewLease(input: RenewRunLeaseInput): Promise<RenewRunLeaseOutcome>;
}

export interface RunRoutesConfiguration {
  readonly successors?: RunSuccessorSegments;
  readonly access: RunAccessAuthorizer;
  readonly conversation: RunConversation;
  readonly continuation?: {
    admit(input: {
      readonly owner: AdmitRunInput['owner'];
      readonly runId: string;
      readonly command: RunContinuationRequest;
    }): Promise<
      | { readonly kind: 'Admitted' | 'Equivalent'; readonly receipt: RunContinuationReceipt }
      | { readonly kind: 'RunNotFound' | 'Rejected' | 'Unavailable' }
    >;
  };
  now(): string;
  newCorrelationId(): string;
}

const unauthorizedResponses = Type.Union([
  runCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
]);
const forbiddenResponses = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  runAdmissionForbiddenProblemSchema,
]);
const workAccessForbiddenResponses = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
]);
const conflictResponses = Type.Union([
  workAccessGrantConcurrentUpdateProblemSchema,
  runConflictProblemSchema,
]);
const capacityResponses = Type.Union([
  workAccessGrantExhaustedProblemSchema,
  runCapacityExceededProblemSchema,
]);

const runLeaseRenewedResponseSchema = Object.freeze({
  type: 'null',
  description: 'Run incarnation lease renewed',
  headers: runLeaseRenewalHeadersSchema.properties,
});

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

async function sendProblem(reply: FastifyReply, problem: RunProblem): Promise<void> {
  await reply.code(problem.status).type('application/problem+json').send(problem);
}

function baseProblem(
  code: 'RunRequestInvalid' | 'RunCapabilityInvalid' | 'RunBodyTooLarge',
  correlationId: string,
): RunProblem {
  switch (code) {
    case 'RunRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/run-request-invalid',
        title: 'Run request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'RunCapabilityInvalid':
      return {
        type: 'https://devrandom.example/problems/run-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code,
        correlationId,
      };
    case 'RunBodyTooLarge':
      return {
        type: 'https://devrandom.example/problems/run-body-too-large',
        title: 'Run request body is too large',
        status: 413,
        code,
        correlationId,
      };
  }
}

async function authorize(
  reply: FastifyReply,
  authorization: string,
  scope: RunScope,
  configuration: RunRoutesConfiguration,
): Promise<AdmitRunInput['owner'] | undefined> {
  const outcome = await configuration.access.authorize({
    bearerSecret: bearerSecret(authorization),
    scope,
    observedAt: configuration.now(),
  });
  const correlationId = configuration.newCorrelationId();
  switch (outcome.kind) {
    case 'RunAccessAuthorized':
      return outcome.owner;
    case 'RunAccessInvalid':
      await sendProblem(reply, baseProblem('RunCapabilityInvalid', correlationId));
      return undefined;
    case 'RunAccessExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId,
      });
      return undefined;
    case 'RunAccessReleased':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-released',
        title: 'Work Access Grant was released',
        status: 401,
        code: 'WorkAccessGrantReleased',
        correlationId,
      });
      return undefined;
    case 'RunAccessRevoked':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId,
        reason: outcome.reason,
      });
      return undefined;
    case 'RunAccessScopeRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId,
        requiredScope: scope,
      });
      return undefined;
    case 'RunAccessConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
        title: 'Work Access Grant changed concurrently',
        status: 409,
        code: 'WorkAccessGrantConcurrentUpdate',
        correlationId,
      });
      return undefined;
    case 'RunAccessExhausted':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId,
      });
      return undefined;
    case 'RunAccessUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-unavailable',
        title: 'Run dependency is unavailable',
        status: 503,
        code: 'RunUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return undefined;
  }
}

function conflictBase(correlationId: string) {
  return {
    type: 'https://devrandom.example/problems/run-conflict' as const,
    title: 'Run command conflicts with durable state' as const,
    status: 409 as const,
    code: 'RunConflict' as const,
    correlationId,
  };
}

async function sendAdmissionOutcome(
  reply: FastifyReply,
  outcome: AdmitRunOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'RunCreated':
      await reply.code(201).send(outcome.projection);
      return;
    case 'ExistingRun':
      await reply.code(200).send(outcome.projection);
      return;
    case 'RunAdmissionExchangePending':
      await reply.code(202).send(outcome.projection);
      return;
    case 'RunCommandConflict':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'CommandConflict' });
      return;
    case 'ExistingRunRequiresLaterResume':
    case 'RunAlreadyEnded':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: outcome.kind,
        runId: outcome.runId,
      });
      return;
    case 'InitialHarnessIncumbentConflict':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'InitialHarnessIncumbentConflict',
      });
      return;
    case 'ConcurrentRunAdmission':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'ConcurrentUpdate' });
      return;
    case 'RunResourceNotFound':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-resource-not-found',
        title: 'Run resource was not found',
        status: 404,
        code: 'RunResourceNotFound',
        correlationId,
        resource: outcome.resource,
      });
      return;
    case 'RunAdmissionForbidden':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-admission-forbidden',
        title: 'Run admission is not permitted',
        status: 403,
        code: 'RunAdmissionForbidden',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'RunAdmissionRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-admission-rejected',
        title: 'Run admission was rejected',
        status: 422,
        code: 'RunAdmissionRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'RunCapacityExceeded':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-capacity-exceeded',
        title: 'Run capacity is exhausted',
        status: 429,
        code: 'RunCapacityExceeded',
        correlationId,
        scope: outcome.scope,
      });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-unavailable',
        title: 'Run dependency is unavailable',
        status: 503,
        code: 'RunUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

async function sendLeaseOutcome(
  reply: FastifyReply,
  outcome: AcquireRunLeaseOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'RunLeaseAcquired':
      await reply.code(201).send(outcome.projection);
      return;
    case 'RunLeaseReconciled':
      await reply.code(200).send(outcome.projection);
      return;
    case 'RunResourceNotFound':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-resource-not-found',
        title: 'Run resource was not found',
        status: 404,
        code: 'RunResourceNotFound',
        correlationId,
        resource: 'Run',
      });
      return;
    case 'RunVersionConflict':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'VersionConflict',
        currentVersion: outcome.currentVersion,
      });
      return;
    case 'RunLeaseConflict':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'LeaseConflict',
        incarnationId: outcome.incarnationId,
        expiresAt: outcome.expiresAt,
        currentVersion: outcome.currentVersion,
      });
      return;
    case 'RunLeaseLaterResumeRequired':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'LaterResumeRequired',
        expiredAt: outcome.expiredAt,
      });
      return;
    case 'RunNotPreparing':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'RunNotPreparing' });
      return;
    case 'RunLeaseConcurrentUpdate':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'ConcurrentUpdate' });
      return;
    case 'RunLeaseForbidden':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-admission-forbidden',
        title: 'Run admission is not permitted',
        status: 403,
        code: 'RunAdmissionForbidden',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-unavailable',
        title: 'Run dependency is unavailable',
        status: 503,
        code: 'RunUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

async function sendRenewalOutcome(
  reply: FastifyReply,
  outcome: RenewRunLeaseOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'RunLeaseRenewed':
    case 'RunLeaseRenewalReconciled':
      await reply
        .headers({
          [runLeaseRenewalHeaderNames.serverTime]: outcome.receipt.serverTime,
          [runLeaseRenewalHeaderNames.expiresAt]: outcome.receipt.expiresAt,
          [runLeaseRenewalHeaderNames.runVersion]: String(outcome.receipt.runVersion),
        })
        .code(204)
        .send();
      return;
    case 'RunResourceNotFound':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-resource-not-found',
        title: 'Run resource was not found',
        status: 404,
        code: 'RunResourceNotFound',
        correlationId,
        resource: 'Run',
      });
      return;
    case 'RunVersionConflict':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'VersionConflict',
        currentVersion: outcome.currentVersion,
      });
      return;
    case 'RunLeaseConflict':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'LeaseConflict',
        incarnationId: outcome.incarnationId,
        expiresAt: outcome.expiresAt,
        currentVersion: outcome.currentVersion,
      });
      return;
    case 'RunLeaseLaterResumeRequired':
      await sendProblem(reply, {
        ...conflictBase(correlationId),
        reason: 'LaterResumeRequired',
        expiredAt: outcome.expiredAt,
      });
      return;
    case 'RunLeaseNotHeld':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'LeaseNotHeld' });
      return;
    case 'RunNotRenewable':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'RunNotRenewable' });
      return;
    case 'RunLeaseConcurrentUpdate':
      await sendProblem(reply, { ...conflictBase(correlationId), reason: 'ConcurrentUpdate' });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-unavailable',
        title: 'Run dependency is unavailable',
        status: 503,
        code: 'RunUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

async function sendInspectionOutcome(
  reply: FastifyReply,
  outcome: InspectRunOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'RunFound':
      await reply.code(200).send(outcome.projection);
      return;
    case 'RunResourceNotFound':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-resource-not-found',
        title: 'Run resource was not found',
        status: 404,
        code: 'RunResourceNotFound',
        correlationId,
        resource: outcome.resource,
      });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/run-unavailable',
        title: 'Run dependency is unavailable',
        status: 503,
        code: 'RunUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
  }
}

export function runRoutes(configuration: RunRoutesConfiguration): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) {
        return { value: input };
      }
      const [firstError] = Errors(schema, input);
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
        fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY';
      if (!bodyTooLarge && validationContext !== 'headers' && !requestInvalid) {
        await reply.status(500).send();
        return;
      }
      await sendProblem(
        reply,
        validationContext === 'headers'
          ? baseProblem('RunCapabilityInvalid', configuration.newCorrelationId())
          : baseProblem(
              bodyTooLarge ? 'RunBodyTooLarge' : 'RunRequestInvalid',
              configuration.newCorrelationId(),
            ),
      );
    });

    server.post(
      '/api/runs',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'admitRun',
          headers: workAccessAuthorizationHeadersSchema,
          body: runAdmissionCommandSchema,
          response: {
            200: runProjectionSchema,
            201: runProjectionSchema,
            202: runAdmissionPendingProjectionSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: conflictResponses,
            413: runBodyTooLargeProblemSchema,
            422: runAdmissionRejectedProblemSchema,
            429: capacityResponses,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:create',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.admit({
          owner,
          command: request.body,
        });
        await sendAdmissionOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/runs/:runId',
      {
        schema: {
          operationId: 'inspectRun',
          headers: workAccessAuthorizationHeadersSchema,
          params: runParametersSchema,
          response: {
            200: runProjectionSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: workAccessForbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: workAccessGrantConcurrentUpdateProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:read',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.inspect({
          ownerAid: owner.ownerAid,
          runId: request.params.runId,
        });
        await sendInspectionOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/runs/:runId/continuations/:segmentSaid',
      {
        schema: {
          operationId: 'readRunSuccessorSegment',
          headers: workAccessAuthorizationHeadersSchema,
          params: runSuccessorSegmentParametersSchema,
          response: {
            200: runSuccessorSegmentSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: workAccessForbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: workAccessGrantConcurrentUpdateProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:read',
          configuration,
        );
        if (owner === undefined) return;
        const outcome = await configuration.successors?.read({
          ownerAid: owner.ownerAid,
          ...request.params,
        });
        if (
          outcome?.kind === 'Found' &&
          decodeRunSuccessorSegment(outcome.segment).kind === 'Accepted'
        ) {
          // Content-addressed JSON retains its producer order across transport.
          await reply.code(200).serializer(JSON.stringify).send(outcome.segment);
        } else {
          await sendInspectionOutcome(
            reply,
            outcome?.kind === 'NotFound'
              ? { kind: 'RunResourceNotFound', resource: 'Run' }
              : { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' },
            configuration.newCorrelationId(),
          );
        }
      },
    );

    server.post(
      '/api/runs/:runId/continuations',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'admitRunContinuation',
          headers: workAccessAuthorizationHeadersSchema,
          params: runParametersSchema,
          body: runContinuationRequestSchema,
          response: {
            200: runContinuationReceiptSchema,
            201: runContinuationReceiptSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: Type.Union([
              workAccessGrantConcurrentUpdateProblemSchema,
              runContinuationRejectedProblemSchema,
            ]),
            413: runBodyTooLargeProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:execute',
          configuration,
        );
        if (owner === undefined) return;
        const outcome = await configuration.continuation?.admit({
          owner,
          runId: request.params.runId,
          command: request.body,
        });
        const correlationId = configuration.newCorrelationId();
        if (
          (outcome?.kind === 'Admitted' || outcome?.kind === 'Equivalent') &&
          Check(runContinuationReceiptSchema, outcome.receipt) &&
          decodeRunProjection(outcome.receipt.run).kind === 'Accepted' &&
          decodeRunSuccessorSegment(outcome.receipt.segment).kind === 'Accepted'
        ) {
          await reply
            .code(outcome.kind === 'Admitted' ? 201 : 200)
            .serializer(JSON.stringify)
            .send(outcome.receipt);
        } else if (outcome?.kind === 'RunNotFound') {
          await sendProblem(reply, {
            type: 'https://devrandom.example/problems/run-resource-not-found',
            title: 'Run resource was not found',
            status: 404,
            code: 'RunResourceNotFound',
            resource: 'Run',
            correlationId,
          });
        } else if (outcome?.kind === 'Rejected') {
          await sendProblem(reply, {
            ...conflictBase(correlationId),
            reason: 'ContinuationRejected',
          });
        } else {
          await sendProblem(reply, {
            type: 'https://devrandom.example/problems/run-unavailable',
            title: 'Run dependency is unavailable',
            status: 503,
            code: 'RunUnavailable',
            correlationId,
            dependency: 'HostedMongoDB',
          });
        }
      },
    );

    server.put(
      '/api/runs/:runId/incarnations/:incarnationId',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'acquireRunLease',
          headers: workAccessAuthorizationHeadersSchema,
          params: runIncarnationParametersSchema,
          body: runLeaseAcquisitionBodySchema,
          response: {
            200: runLeaseProjectionSchema,
            201: runLeaseProjectionSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: conflictResponses,
            413: runBodyTooLargeProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:execute',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.acquireLease({
          owner,
          runId: request.params.runId,
          incarnationId: request.params.incarnationId,
          command: request.body,
        });
        await sendLeaseOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.put(
      '/api/runs/:runId/incarnations/:incarnationId/lease',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'renewRunLease',
          headers: workAccessAuthorizationHeadersSchema,
          params: runIncarnationParametersSchema,
          body: runLeaseAcquisitionBodySchema,
          response: {
            204: runLeaseRenewedResponseSchema,
            400: runRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            404: runResourceNotFoundProblemSchema,
            409: conflictResponses,
            413: runBodyTooLargeProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: runUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'run:execute',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.renewLease({
          ownerAid: owner.ownerAid,
          runId: request.params.runId,
          incarnationId: request.params.incarnationId,
          command: request.body,
        });
        await sendRenewalOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
