import { taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  mandatePresentationBodyTooLargeProblemSchema,
  mandatePresentationConflictProblemSchema,
  mandatePresentationExpiredProblemSchema,
  mandatePresentationForbiddenProblemSchema,
  mandatePresentationParametersSchema,
  mandatePresentationProjectionSchema,
  mandatePresentationRejectedProblemSchema,
  mandatePresentationRequestInvalidProblemSchema,
  mandatePresentationUnavailableProblemSchema,
  presentMandateBodySchema,
  workAccessAuthorizationHeadersSchema,
  workAccessCapabilityInvalidProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  type MandatePresentationProblem,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import { projectMandatePresentation } from '../application/presentation-projection.js';
import type { PresentMandateInput, PresentMandateOutcome } from '../application/present-mandate.js';

export type MandateAccessAuthorization =
  | {
      readonly kind: 'MandateAccessAuthorized';
      readonly authority: PresentMandateInput['authority'];
    }
  | { readonly kind: 'MandateAccessInvalid' }
  | { readonly kind: 'MandateAccessExpired' }
  | { readonly kind: 'MandateAccessReleased' }
  | { readonly kind: 'MandateAccessRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'MandateAccessScopeRejected' }
  | { readonly kind: 'MandateAccessConcurrentUpdate' }
  | { readonly kind: 'MandateAccessExhausted' }
  | { readonly kind: 'MandateAccessUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface MandateAccessAuthorizer {
  authorize(input: {
    readonly bearerSecret: string;
    readonly scope: 'run:prepare';
    readonly observedAt: string;
  }): Promise<MandateAccessAuthorization>;
}

export interface MandateConversation {
  present(input: PresentMandateInput): Promise<PresentMandateOutcome>;
}

export interface MandateRoutesConfiguration {
  readonly access: MandateAccessAuthorizer;
  readonly conversation: MandateConversation;
  now(): string;
  newCorrelationId(): string;
}

const unauthorizedResponses = Type.Union([
  workAccessCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
]);
const forbiddenResponses = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  mandatePresentationForbiddenProblemSchema,
]);
const conflictResponses = Type.Union([
  workAccessGrantConcurrentUpdateProblemSchema,
  mandatePresentationConflictProblemSchema,
]);
const capacityResponses = workAccessGrantExhaustedProblemSchema;

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

async function sendProblem(
  reply: FastifyReply,
  problem: MandatePresentationProblem,
): Promise<void> {
  await reply.code(problem.status).type('application/problem+json').send(problem);
}

function baseProblem(
  code: 'MandatePresentationRequestInvalid' | 'MandatePresentationBodyTooLarge',
  correlationId: string,
): MandatePresentationProblem {
  switch (code) {
    case 'MandatePresentationRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/mandate-presentation-request-invalid',
        title: 'Mandate presentation request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'MandatePresentationBodyTooLarge':
      return {
        type: 'https://devrandom.example/problems/mandate-presentation-body-too-large',
        title: 'Mandate presentation request body is too large',
        status: 413,
        code,
        correlationId,
      };
  }
}

async function authorize(
  reply: FastifyReply,
  authorization: string,
  configuration: MandateRoutesConfiguration,
): Promise<PresentMandateInput['authority'] | undefined> {
  const outcome = await configuration.access.authorize({
    bearerSecret: bearerSecret(authorization),
    scope: 'run:prepare',
    observedAt: configuration.now(),
  });
  const correlationId = configuration.newCorrelationId();
  switch (outcome.kind) {
    case 'MandateAccessAuthorized':
      return outcome.authority;
    case 'MandateAccessInvalid':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code: 'WorkAccessCapabilityInvalid',
        correlationId,
      });
      return undefined;
    case 'MandateAccessExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId,
      });
      return undefined;
    case 'MandateAccessReleased':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-released',
        title: 'Work Access Grant was released',
        status: 401,
        code: 'WorkAccessGrantReleased',
        correlationId,
      });
      return undefined;
    case 'MandateAccessRevoked':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId,
        reason: outcome.reason,
      });
      return undefined;
    case 'MandateAccessScopeRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId,
        requiredScope: 'run:prepare',
      });
      return undefined;
    case 'MandateAccessConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
        title: 'Work Access Grant changed concurrently',
        status: 409,
        code: 'WorkAccessGrantConcurrentUpdate',
        correlationId,
      });
      return undefined;
    case 'MandateAccessExhausted':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId,
      });
      return undefined;
    case 'MandateAccessUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-unavailable',
        title: 'Mandate presentation dependency is unavailable',
        status: 503,
        code: 'MandatePresentationUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return undefined;
  }
}

async function sendOutcome(
  reply: FastifyReply,
  outcome: PresentMandateOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'MandatePresentationPending':
      await reply.code(202).send(projectMandatePresentation(outcome.presentation));
      return;
    case 'MandatePresentationAdmitted':
      await reply.code(200).send(projectMandatePresentation(outcome.presentation));
      return;
    case 'UserCredentialNotCurrent':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-forbidden',
        title: 'Mandate presentation is not permitted',
        status: 403,
        code: 'MandatePresentationForbidden',
        correlationId,
        reason: outcome.kind,
      });
      return;
    case 'MandatePresentationForbidden':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-forbidden',
        title: 'Mandate presentation is not permitted',
        status: 403,
        code: 'MandatePresentationForbidden',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'MandatePresentationConflict':
    case 'MandatePresentationConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-conflict',
        title: 'Mandate presentation conflicts with its prior use',
        status: 409,
        code: 'MandatePresentationConflict',
        correlationId,
      });
      return;
    case 'MandatePresentationExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-expired',
        title: 'Mandate presentation expired',
        status: 410,
        code: 'MandatePresentationExpired',
        correlationId,
      });
      return;
    case 'MandatePresentationRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-rejected',
        title: 'Mandate presentation was rejected',
        status: 422,
        code: 'MandatePresentationRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'MandatePresentationInvalid':
      await sendProblem(reply, baseProblem('MandatePresentationRequestInvalid', correlationId));
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/mandate-presentation-unavailable',
        title: 'Mandate presentation dependency is unavailable',
        status: 503,
        code: 'MandatePresentationUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

export function mandateRoutes(
  configuration: MandateRoutesConfiguration,
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
      if (validationContext === 'headers') {
        await sendProblem(reply, {
          type: 'https://devrandom.example/problems/work-access-capability-invalid',
          title: 'Work Access capability is invalid',
          status: 401,
          code: 'WorkAccessCapabilityInvalid',
          correlationId: configuration.newCorrelationId(),
        });
        return;
      }
      await sendProblem(
        reply,
        baseProblem(
          bodyTooLarge ? 'MandatePresentationBodyTooLarge' : 'MandatePresentationRequestInvalid',
          configuration.newCorrelationId(),
        ),
      );
    });

    server.put(
      '/api/mandate-presentations/:credentialSaid',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'presentMandate',
          headers: workAccessAuthorizationHeadersSchema,
          params: mandatePresentationParametersSchema,
          body: presentMandateBodySchema,
          response: {
            200: mandatePresentationProjectionSchema,
            202: mandatePresentationProjectionSchema,
            400: mandatePresentationRequestInvalidProblemSchema,
            401: unauthorizedResponses,
            403: forbiddenResponses,
            409: conflictResponses,
            410: mandatePresentationExpiredProblemSchema,
            413: mandatePresentationBodyTooLargeProblemSchema,
            422: mandatePresentationRejectedProblemSchema,
            429: capacityResponses,
            503: mandatePresentationUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const authority = await authorize(reply, request.headers.authorization, configuration);
        if (authority === undefined) {
          return;
        }
        const outcome = await configuration.conversation.present({
          authority,
          command: {
            mandateKind: request.body.mandateKind,
            credentialSaid: request.params.credentialSaid,
            grantSaid: request.body.grantSaid,
          },
        });
        await sendOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
