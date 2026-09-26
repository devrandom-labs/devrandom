import { ProtectedCredentials, taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  admitBaselineHarnessBodySchema,
  baselineHarnessProjectionSchema,
  harnessAdmissionConflictProblemSchema,
  harnessAdmissionForbiddenProblemSchema,
  harnessBodyTooLargeProblemSchema,
  harnessCapabilityInvalidProblemSchema,
  harnessRequestInvalidProblemSchema,
  harnessRevisionParametersSchema,
  harnessRevisionRejectedProblemSchema,
  harnessTaskNotFoundProblemSchema,
  harnessUnavailableProblemSchema,
  workAccessAuthorizationHeadersSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  type HarnessProblem,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type {
  AdmitBaselineHarnessInput,
  AdmitBaselineHarnessOutcome,
} from '../application/admit-baseline-harness.js';

export type HarnessAccessAuthorization =
  | {
      readonly kind: 'HarnessAccessAuthorized';
      readonly owner: AdmitBaselineHarnessInput['owner'];
    }
  | { readonly kind: 'HarnessAccessInvalid' }
  | { readonly kind: 'HarnessAccessExpired' }
  | { readonly kind: 'HarnessAccessReleased' }
  | { readonly kind: 'HarnessAccessRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'HarnessAccessScopeRejected' }
  | { readonly kind: 'HarnessAccessConcurrentUpdate' }
  | { readonly kind: 'HarnessAccessExhausted' }
  | { readonly kind: 'HarnessAccessUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface HarnessAccessAuthorizer {
  authorize(input: {
    readonly bearerSecret: string;
    readonly scope: 'run:prepare';
    readonly observedAt: string;
  }): Promise<HarnessAccessAuthorization>;
}

export interface HarnessConversation {
  admit(input: AdmitBaselineHarnessInput): Promise<AdmitBaselineHarnessOutcome>;
}

export interface HarnessRoutesConfiguration {
  readonly access: HarnessAccessAuthorizer;
  readonly conversation: HarnessConversation;
  now(): string;
  newCorrelationId(): string;
}

const unauthorizedResponses = Type.Union([
  harnessCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
]);
const forbiddenResponses = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  harnessAdmissionForbiddenProblemSchema,
]);
const conflictResponses = Type.Union([
  workAccessGrantConcurrentUpdateProblemSchema,
  harnessAdmissionConflictProblemSchema,
]);

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

async function sendProblem(reply: FastifyReply, problem: HarnessProblem): Promise<void> {
  await reply.code(problem.status).type('application/problem+json').send(problem);
}

function baseProblem(
  code: 'HarnessRequestInvalid' | 'HarnessCapabilityInvalid' | 'HarnessBodyTooLarge',
  correlationId: string,
): HarnessProblem {
  switch (code) {
    case 'HarnessRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/harness-request-invalid',
        title: 'Harness request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'HarnessCapabilityInvalid':
      return {
        type: 'https://devrandom.example/problems/harness-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code,
        correlationId,
      };
    case 'HarnessBodyTooLarge':
      return {
        type: 'https://devrandom.example/problems/harness-body-too-large',
        title: 'Harness request body is too large',
        status: 413,
        code,
        correlationId,
      };
  }
}

async function authorize(
  reply: FastifyReply,
  authorization: string,
  configuration: HarnessRoutesConfiguration,
): Promise<AdmitBaselineHarnessInput['owner'] | undefined> {
  const outcome = await configuration.access.authorize({
    bearerSecret: bearerSecret(authorization),
    scope: 'run:prepare',
    observedAt: configuration.now(),
  });
  const correlationId = configuration.newCorrelationId();
  switch (outcome.kind) {
    case 'HarnessAccessAuthorized':
      return outcome.owner;
    case 'HarnessAccessInvalid':
      await sendProblem(reply, baseProblem('HarnessCapabilityInvalid', correlationId));
      return undefined;
    case 'HarnessAccessExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId,
      });
      return undefined;
    case 'HarnessAccessReleased':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-released',
        title: 'Work Access Grant was released',
        status: 401,
        code: 'WorkAccessGrantReleased',
        correlationId,
      });
      return undefined;
    case 'HarnessAccessRevoked':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId,
        reason: outcome.reason,
      });
      return undefined;
    case 'HarnessAccessScopeRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId,
        requiredScope: 'run:prepare',
      });
      return undefined;
    case 'HarnessAccessConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
        title: 'Work Access Grant changed concurrently',
        status: 409,
        code: 'WorkAccessGrantConcurrentUpdate',
        correlationId,
      });
      return undefined;
    case 'HarnessAccessExhausted':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId,
      });
      return undefined;
    case 'HarnessAccessUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-unavailable',
        title: 'Harness dependency is unavailable',
        status: 503,
        code: 'HarnessUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return undefined;
  }
}

async function sendOutcome(
  reply: FastifyReply,
  outcome: AdmitBaselineHarnessOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'HarnessRevisionCreated':
      await reply.code(201).send(outcome.projection);
      return;
    case 'ExistingHarnessRevision':
      await reply.code(200).send(outcome.projection);
      return;
    case 'HarnessCommandConflict':
    case 'HarnessLineageConflict':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-admission-conflict',
        title: 'Harness admission conflicts with durable state',
        status: 409,
        code: 'HarnessAdmissionConflict',
        correlationId,
        reason: outcome.kind === 'HarnessCommandConflict' ? 'CommandConflict' : 'LineageConflict',
      });
      return;
    case 'HarnessTaskNotFound':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-task-not-found',
        title: 'Harness Task was not found',
        status: 404,
        code: 'HarnessTaskNotFound',
        correlationId,
      });
      return;
    case 'HarnessRevisionRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-revision-rejected',
        title: 'Harness Revision was rejected',
        status: 422,
        code: 'HarnessRevisionRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'HarnessAdmissionForbidden':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-admission-forbidden',
        title: 'Harness admission is not permitted',
        status: 403,
        code: 'HarnessAdmissionForbidden',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/harness-unavailable',
        title: 'Harness dependency is unavailable',
        status: 503,
        code: 'HarnessUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

export function harnessRoutes(
  configuration: HarnessRoutesConfiguration,
): FastifyPluginCallbackTypebox {
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
          ? baseProblem('HarnessCapabilityInvalid', configuration.newCorrelationId())
          : baseProblem(
              bodyTooLarge ? 'HarnessBodyTooLarge' : 'HarnessRequestInvalid',
              configuration.newCorrelationId(),
            ),
      );
    });

    server.put(
      '/api/harness-revisions/:harnessSaid',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'admitBaselineHarness',
          headers: workAccessAuthorizationHeadersSchema,
          params: harnessRevisionParametersSchema,
          body: admitBaselineHarnessBodySchema,
          response: {
            200: baselineHarnessProjectionSchema,
            201: baselineHarnessProjectionSchema,
            400: harnessRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            404: harnessTaskNotFoundProblemSchema,
            409: conflictResponses,
            413: harnessBodyTooLargeProblemSchema,
            422: harnessRevisionRejectedProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: harnessUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        if (request.params.harnessSaid !== request.body.revision.d) {
          await sendProblem(reply, {
            type: 'https://devrandom.example/problems/harness-revision-rejected',
            title: 'Harness Revision was rejected',
            status: 422,
            code: 'HarnessRevisionRejected',
            correlationId: configuration.newCorrelationId(),
            reason: 'HarnessSaidMismatch',
          });
          return;
        }
        const owner = await authorize(reply, request.headers.authorization, configuration);
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.admit({
          protectedCredentials: new ProtectedCredentials([
            bearerSecret(request.headers.authorization),
          ]),
          owner,
          command: request.body,
        });
        await sendOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
